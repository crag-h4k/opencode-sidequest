// test/server.test.mjs
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import * as DAG from "../dag.mjs"

const require = createRequire(import.meta.url)
const PLUGIN_DIR = new URL("../", import.meta.url)
const INDEX_PATH = fileURLToPath(new URL("index.ts", PLUGIN_DIR))

const node = (id, extra = {}) => ({ id, prompt: `do ${id}`, ...extra })
const spec = (nodes, extra = {}) => {
  const result = DAG.validateSpec({ nodes, ...extra })
  assert.equal(result.ok, true, result.errors?.join("; "))
  return result.spec
}
const newRun = (nodes, extra = {}) => DAG.createRun(spec(nodes, extra), { id: "run1", sessionID: "ses_origin", now: 1000 })
const state = (run, id) => run.nodes.find((item) => item.id === id).state

function begin(run, id, now = 2000) {
  return DAG.startNode(run, id, { prompt: DAG.buildNodePrompt(run, id), now })
}

// Starts everything that is ready and finishes it with the given outcomes.
function drive(run, outcomes = {}, now = 2000) {
  for (let guard = 0; guard < 100 && run.status === "running"; guard++) {
    const ready = DAG.readyNodes(run)
    if (!ready.length) break
    for (const id of ready) run = begin(run, id, now)
    for (const id of ready) {
      const attempt = run.nodes.find((item) => item.id === id).attempt
      const outcome = outcomes[id]
      run = outcome?.fail
        ? DAG.failNode(run, id, attempt, outcome.fail, now + 1)
        : DAG.completeNode(run, id, attempt, outcome?.output ?? `out-${id}`, now + 1)
    }
  }
  return run
}

test("spec defaults name, parallelism and labels", () => {
  const result = DAG.validateSpec({ nodes: [node("a"), node("b", { depends_on: ["a"], agent: "reviewer", label: "Review" })] })
  assert.equal(result.ok, true)
  assert.equal(result.spec.name, "dag")
  assert.equal(result.spec.maxParallel, 3)
  assert.deepEqual(result.spec.nodes.map((item) => item.label), ["a", "Review"])
  assert.deepEqual(result.spec.nodes[1].dependsOn, ["a"])
  assert.equal(result.spec.nodes[1].agent, "reviewer")
  assert.equal("agent" in result.spec.nodes[0], false)
})

test("model, timeout and budget limits survive validation and are carried into the run", () => {
  const run = newRun([
    node("a", { model: "github-copilot/gpt-6-luna", timeout: 30, maxCost: 0.05, maxTokens: 60000, retries: 2 }),
    node("b"),
  ])
  const [a, b] = run.nodes
  assert.equal(a.model, "github-copilot/gpt-6-luna")
  assert.equal(a.timeout, 30)
  assert.equal(a.maxCost, 0.05)
  assert.equal(a.maxTokens, 60000)
  assert.equal(a.retries, 2)
  for (const key of ["model", "timeout", "maxCost", "maxTokens", "retries"]) assert.equal(key in b, false, key)
  assert.deepEqual(JSON.parse(JSON.stringify(run)).nodes[0], a)
})

// Drive a node through repeated failures the way the scheduler does, and count the attempts it gets.
function failUntilStopped(run, id) {
  let current = DAG.startNode(run, id, { prompt: "p", now: 2000 })
  let attempts = 1
  for (let guard = 0; guard < 50; guard++) {
    const attempt = current.nodes.find((item) => item.id === id).attempt
    const again = DAG.requeueNode(current, id, attempt, "boom", 3000 + guard)
    if (!again) return { run: DAG.failNode(current, id, attempt, "boom", 4000), attempts }
    current = DAG.startNode(again, id, { prompt: "p", now: 3000 + guard })
    attempts += 1
  }
  throw new Error("requeue never stopped")
}

test("a step with no retries is never requeued", () => {
  const run = newRun([node("a")])
  const started = DAG.startNode(run, "a", { prompt: "p", now: 2000 })
  assert.equal(DAG.requeueNode(started, "a", 1, "boom", 3000), undefined)
})

test("a step gets exactly retries + 1 attempts, then fails and skips its dependents", () => {
  for (const retries of [1, 2, 3]) {
    const run = newRun([node("a", { retries }), node("b", { depends_on: ["a"] })])
    const result = failUntilStopped(run, "a")
    assert.equal(result.attempts, retries + 1, `retries ${retries}`)
    assert.equal(state(result.run, "a"), "failed")
    assert.equal(state(result.run, "b"), "skipped")
    assert.equal(result.run.nodes[0].attempt, retries + 1)
    assert.equal(result.run.status, "failed")
  }
})

test("a requeued step goes back to pending without skipping dependents or finishing the run", () => {
  const run = newRun([node("a", { retries: 1 }), node("b", { depends_on: ["a"] })])
  const started = DAG.startNode(DAG.attachSession(DAG.startNode(run, "a", { prompt: "p", now: 2000 }), "a", 1, "ses_x", 2100), "a", { prompt: "p", now: 2000 })
  const again = DAG.requeueNode(started, "a", 1, "boom", 3000)
  const a = again.nodes.find((item) => item.id === "a")
  assert.equal(a.state, "pending")
  assert.equal(a.attempt, 2)
  assert.match(a.error, /attempt 1 failed: boom/)
  for (const key of ["sessionID", "startedAt", "finishedAt", "activity", "output"]) assert.equal(key in a, false, key)
  assert.equal(state(again, "b"), "pending")
  assert.equal(again.status, "running")
  assert.deepEqual(DAG.readyNodes(again), ["a"])
})

test("a stale attempt cannot requeue a node", () => {
  const run = newRun([node("a", { retries: 3 })])
  const started = DAG.startNode(run, "a", { prompt: "p", now: 2000 })
  assert.equal(DAG.requeueNode(started, "a", 2, "boom", 3000), undefined)
  assert.equal(DAG.requeueNode(DAG.cancelRun(started, 2500), "a", 1, "boom", 3000), undefined)
})

test("a run never retries more than the run-wide cap, however many steps ask for retries", () => {
  const ids = ["a", "b", "c", "d", "e"]
  let run = newRun(ids.map((id) => node(id, { retries: 3 })), { maxParallel: 8 })
  for (const id of ids) run = DAG.startNode(run, id, { prompt: "p", now: 2000 })
  let requeues = 0
  for (let guard = 0; guard < 200; guard++) {
    const running = run.nodes.find((item) => item.state === "running")
    if (!running) {
      const pending = DAG.readyNodes(run)
      if (!pending.length) break
      run = DAG.startNode(run, pending[0], { prompt: "p", now: 3000 })
      continue
    }
    const again = DAG.requeueNode(run, running.id, running.attempt, "boom", 3000 + guard)
    if (again) {
      requeues += 1
      run = again
    } else {
      run = DAG.failNode(run, running.id, running.attempt, "boom", 4000 + guard)
    }
  }
  assert.equal(requeues, DAG.MAX_RUN_RETRIES)
  assert.equal(DAG.retriesUsed(run), DAG.MAX_RUN_RETRIES)
  assert.equal(run.status, "failed")
})

test("the status table shows the attempt number only for retried steps", () => {
  const run = newRun([node("a", { retries: 1 }), node("b")])
  const started = DAG.startNode(run, "a", { prompt: "p", now: 2000 })
  const again = DAG.startNode(DAG.requeueNode(started, "a", 1, "boom", 3000), "a", { prompt: "p", now: 3100 })
  const table = DAG.formatStatusTable(again, 4000)
  assert.match(table, /\| a \| running \(attempt 2\) \|/)
  assert.match(table, /\| b \| pending \|/)
})

test("budget violations name the limit that tripped", () => {
  const usage = { cost: 0.2, tokens: { input: 40000, output: 500, reasoning: 100, cache: { read: 9000 } } }
  assert.equal(DAG.tokensUsed(usage.tokens), 49600)
  assert.equal(DAG.tokensUsed(undefined), 0)
  assert.match(DAG.budgetViolation(usage, { maxCost: 0.1 }), /exceeded maxCost \$0\.1 \(actual \$0\.2000\)/)
  assert.match(DAG.budgetViolation(usage, { maxTokens: 40000 }), /exceeded maxTokens 40000 \(used 49600\)/)
  assert.equal(DAG.budgetViolation(usage, { maxCost: 1, maxTokens: 50000 }), undefined)
  assert.equal(DAG.budgetViolation(usage, {}), undefined)
  assert.equal(DAG.budgetViolation({ cost: 0, tokens: { input: 90000, output: 1, reasoning: 0 } }, { maxCost: 0.01 }), undefined)
  assert.equal(DAG.budgetViolation(undefined, { maxTokens: 10 }), undefined)
})

test("a warm child's context counts toward the token cap even though it is reported as cached input", () => {
  // Captured from a live child: its 23k-token baseline came from cache, so input was only 3.
  const warm = { cost: 0.00023438, tokens: { input: 3, output: 5, reasoning: 0, cache: { read: 23158, write: 0 } } }
  assert.equal(DAG.tokensUsed(warm.tokens), 23166)
  assert.match(DAG.budgetViolation(warm, { maxTokens: 1000 }), /exceeded maxTokens 1000 \(used 23166\)/)
  assert.equal(DAG.budgetViolation(warm, { maxTokens: 60000 }), undefined)
  assert.match(DAG.budgetViolation(warm, { maxCost: 0.0001 }), /exceeded maxCost \$0\.0001 \(actual \$0\.0002\)/)
})

test("spec validation rejects each structural problem", () => {
  const errors = (input) => {
    const result = DAG.validateSpec(input)
    assert.equal(result.ok, false)
    return result.errors.join("\n")
  }
  assert.match(errors({ nodes: [node("a"), node("a")] }), /node 'a': duplicate id/)
  assert.match(errors({ nodes: [node("a", { depends_on: ["ghost"] })] }), /node 'a': depends on unknown node 'ghost'/)
  assert.match(errors({ nodes: [node("a", { depends_on: ["a"] })] }), /node 'a': depends on itself/)
  assert.match(errors({ nodes: [node("a", { depends_on: ["c"] }), node("b", { depends_on: ["a"] }), node("c", { depends_on: ["b"] })] }), /cycle among: a, b, c/)
  assert.match(errors({ nodes: Array.from({ length: 25 }, (_, i) => node(`n${i}`)) }), /1 to 24 entries, got 25/)
  assert.match(errors({ nodes: [] }), /1 to 24 entries, got 0/)
  assert.match(errors({ nodes: [node("Bad Id")] }), /node 'Bad Id': id must match/)
  assert.match(errors({ nodes: [{ prompt: "x" }] }), /node #1: id must match/)
  assert.match(errors({ nodes: [node("a", { prompt: "  " })] }), /node 'a': prompt must be a non-empty string/)
  assert.match(errors({ nodes: [node("a")], maxParallel: 0 }), /maxParallel must be an integer from 1 to 8/)
  assert.match(errors({ nodes: [node("a")], maxParallel: 9 }), /maxParallel/)
  assert.match(errors({ nodes: [node("a")], maxParallel: 2.5 }), /maxParallel/)
  assert.match(errors({ nodes: [node("a", { dependsOn: ["b"] })] }), /node 'a': unknown field 'dependsOn'/)
  assert.match(errors({ nodes: [node("a", { model: "kimi-k3" })] }), /model must be "provider\/modelID"/)
  assert.match(errors({ nodes: [node("a", { timeout: 0 })] }), /timeout must be an integer from 1 to 3600/)
  assert.match(errors({ nodes: [node("a", { timeout: 3601 })] }), /timeout must be an integer from 1 to 3600/)
  assert.match(errors({ nodes: [node("a", { timeout: 1.5 })] }), /timeout must be an integer from 1 to 3600/)
  assert.match(errors({ nodes: [node("a", { maxCost: 0 })] }), /maxCost must be a positive number of USD/)
  assert.match(errors({ nodes: [node("a", { maxCost: -1 })] }), /maxCost must be a positive number of USD/)
  assert.match(errors({ nodes: [node("a", { maxTokens: 0 })] }), /maxTokens must be a positive integer/)
  assert.match(errors({ nodes: [node("a", { maxTokens: 10.5 })] }), /maxTokens must be a positive integer/)
  assert.match(errors({ nodes: [node("a", { retries: -1 })] }), /retries must be an integer from 0 to 3/)
  assert.match(errors({ nodes: [node("a", { retries: 4 })] }), /retries must be an integer from 0 to 3/)
  assert.match(errors({ nodes: [node("a", { retries: 1.5 })] }), /retries must be an integer from 0 to 3/)
  assert.match(errors({ nodes: [node("a", { model: " " })] }), /model must be "provider\/modelID"/)
  assert.match(errors("nope"), /spec must be an object/)
})

test("cycle report names only the nodes on the cycle, not their dependents", () => {
  const result = DAG.validateSpec({
    nodes: [node("a", { depends_on: ["b"] }), node("b", { depends_on: ["a"] }), node("tail", { depends_on: ["a"] }), node("root")],
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, ["dependency cycle among: a, b"])
})

test("spec validation reports every problem at once", () => {
  const result = DAG.validateSpec({
    maxParallel: 99,
    nodes: [node("a", { depends_on: ["a", "zzz"] }), node("a"), node("B"), node("c", { prompt: "" })],
  })
  assert.equal(result.ok, false)
  const text = result.errors.join("\n")
  for (const expected of [/maxParallel/, /node 'a': depends on itself/, /unknown node 'zzz'/, /duplicate id/, /node 'B'/, /node 'c': prompt/]) {
    assert.match(text, expected)
  }
  assert.ok(result.errors.length >= 6)
})

test("only nodes whose dependencies completed are ready, up to maxParallel", () => {
  let run = newRun([node("a"), node("b"), node("c"), node("d", { depends_on: ["a", "b"] }), node("e")], { maxParallel: 2 })
  assert.deepEqual(DAG.readyNodes(run), ["a", "b"])
  run = begin(run, "a")
  assert.deepEqual(DAG.readyNodes(run), ["b"])
  run = begin(run, "b")
  assert.deepEqual(DAG.readyNodes(run), [])
  run = DAG.completeNode(run, "a", 1, "A", 3000)
  assert.deepEqual(DAG.readyNodes(run), ["c"])
  run = begin(run, "c")
  run = DAG.completeNode(run, "b", 1, "B", 3100)
  assert.deepEqual(DAG.readyNodes(run), ["d"])
  assert.equal(state(run, "d"), "pending")
})

test("a failure skips transitive dependents while independent branches finish", () => {
  const run = drive(
    newRun([
      node("root"),
      node("bad", { depends_on: ["root"] }),
      node("after", { depends_on: ["bad"] }),
      node("after2", { depends_on: ["after"] }),
      node("side", { depends_on: ["root"] }),
      node("join", { depends_on: ["side", "after"] }),
    ]),
    { bad: { fail: "boom" } },
  )
  assert.equal(run.status, "failed")
  assert.deepEqual(
    Object.fromEntries(run.nodes.map((item) => [item.id, item.state])),
    { root: "completed", bad: "failed", after: "skipped", after2: "skipped", side: "completed", join: "skipped" },
  )
  assert.equal(run.nodes.find((item) => item.id === "bad").error, "boom")
  assert.match(run.nodes.find((item) => item.id === "after").error, /upstream 'bad' failed/)
  assert.match(run.error, /1 node\(s\) failed: bad/)
  assert.ok(run.finishedAt)
})

test("a run completes only when every node completed", () => {
  const run = drive(newRun([node("a"), node("b", { depends_on: ["a"] })]))
  assert.equal(run.status, "completed")
  assert.equal(run.error, undefined)
  assert.equal(run.finishedAt, 2001)
})

test("cancel stops running and pending nodes and ignores late results", () => {
  let run = newRun([node("a"), node("b", { depends_on: ["a"] }), node("c")])
  run = begin(run, "a")
  run = begin(run, "c")
  run = DAG.completeNode(run, "c", 1, "C", 2500)
  const cancelled = DAG.cancelRun(run, 3000, "cancelled by user")
  assert.equal(cancelled.status, "cancelled")
  assert.deepEqual(cancelled.nodes.map((item) => item.state), ["cancelled", "cancelled", "completed"])
  assert.equal(cancelled.finishedAt, 3000)
  assert.equal(cancelled.error, "cancelled by user")
  assert.equal(DAG.completeNode(cancelled, "a", 1, "late", 3100), cancelled)
  assert.equal(DAG.failNode(cancelled, "a", 1, "late", 3100), cancelled)
  assert.equal(DAG.cancelRun(cancelled, 3200), cancelled)
  assert.deepEqual(DAG.readyNodes(cancelled), [])
})

test("retry resets failed work, keeps completed output and bumps attempts", () => {
  const failed = drive(newRun([node("a"), node("b", { depends_on: ["a"] }), node("c", { depends_on: ["b"] })]), { b: { fail: "boom" } })
  assert.equal(failed.status, "failed")
  const retried = DAG.retryRun(failed, 5000)
  assert.equal(retried.ok, true)
  assert.equal(retried.changed, true)
  const run = retried.run
  assert.equal(run.status, "running")
  assert.equal(run.finishedAt, undefined)
  assert.equal(run.error, undefined)
  const [a, b, c] = run.nodes
  assert.deepEqual([a.state, b.state, c.state], ["completed", "pending", "pending"])
  assert.deepEqual([a.attempt, b.attempt, c.attempt], [1, 2, 2])
  assert.equal(a.output, "out-a")
  assert.equal(b.error, undefined)
  assert.equal(b.startedAt, undefined)
  assert.deepEqual(DAG.readyNodes(run), ["b"])
  assert.equal(drive(run, {}, 6000).status, "completed")
})

test("retry is rejected while running and is a no-op for a clean run", () => {
  const running = newRun([node("a")])
  assert.deepEqual(DAG.retryRun(running, 5000), { ok: false, reason: "running" })
  const done = drive(running)
  const result = DAG.retryRun(done, 5000)
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.run, done)
})

test("results from a superseded attempt cannot touch a retried node", () => {
  let run = newRun([node("a")])
  run = begin(run, "a")
  run = DAG.cancelRun(run, 3000)
  run = DAG.retryRun(run, 3100).run
  run = begin(run, "a", 3200)
  assert.equal(run.nodes[0].attempt, 2)
  assert.equal(DAG.completeNode(run, "a", 1, "stale", 3300), run)
  assert.equal(DAG.attachSession(run, "a", 1, "ses_old", 3300), run)
  assert.equal(DAG.setActivity(run, "a", 1, "tool: bash", 3300), run)
  assert.equal(DAG.completeNode(run, "a", 2, "fresh", 3300).nodes[0].output, "fresh")
})

test("node prompts carry dependency outputs under their own headings", () => {
  const run = newRun([node("a"), node("b"), node("d", { depends_on: ["a", "b"], prompt: "merge them" })])
  const prompt = DAG.buildNodePrompt(run, "d", { prompts: { d: "merge them" }, outputs: { a: "alpha", b: "beta" } })
  assert.ok(prompt.startsWith("merge them"))
  assert.match(prompt, /### a\nalpha/)
  assert.match(prompt, /### b\nbeta/)
  assert.ok(prompt.indexOf("### a") < prompt.indexOf("### b"))
  assert.equal(DAG.buildNodePrompt(run, "a"), "do a")
  assert.match(DAG.buildNodePrompt(run, "d"), /### a\n\(no output\)/)
})

test("long outputs are truncated in prompts and in stored fields", () => {
  const long = "x".repeat(9000)
  const base = newRun([node("a"), node("d", { depends_on: ["a"] })])
  const prompt = DAG.buildNodePrompt(base, "d", { outputs: { a: long } })
  const section = prompt.split("### a\n")[1]
  assert.equal(section.length, DAG.DEP_OUTPUT_LIMIT)
  assert.ok(section.endsWith("..."))

  let run = begin(base, "a")
  run = DAG.completeNode(run, "a", 1, long, 3000)
  assert.equal(run.nodes[0].output.length, DAG.STORED_TEXT_LIMIT)
  assert.equal(run.nodes[0].prompt.length <= DAG.STORED_TEXT_LIMIT, true)
  const started = DAG.startNode(run, "d", { prompt: "p".repeat(5000), now: 3100 })
  assert.equal(started.nodes[1].prompt.length, DAG.STORED_TEXT_LIMIT)
})

test("status table lists every node plus a one-line summary", () => {
  let run = newRun([node("fetch", { agent: "build" }), node("b", { agent: "x|y", depends_on: ["fetch"] }), node("late", { depends_on: ["fetch"] })])
  run = begin(run, "fetch", 10_000)
  run = DAG.completeNode(run, "fetch", 1, "ok", 72_000)
  run = begin(run, "b", 72_000)
  run = DAG.failNode(run, "b", 1, "tool exploded", 75_000)
  const table = DAG.formatStatusTable(run, 80_000)
  const [summary, blank, header, divider, ...rows] = table.split("\n")
  assert.match(summary, /^DAG "dag" \(run1\): running, 1\/3 completed, 1 pending, 1 failed$/)
  assert.equal(blank, "")
  assert.equal(header, "| id | state | agent | elapsed | deps |")
  assert.equal(divider, "| --- | --- | --- | --- | --- |")
  assert.equal(rows[0], "| fetch | completed | build | 1m02s | - |")
  assert.equal(rows[1], "| b | failed | x\\|y | 3s | fetch |")
  assert.equal(rows[2], "| late | pending | - | - | fetch |")
  assert.match(table, /\n- b: tool exploded$/)
  assert.equal(DAG.formatElapsed(3_723_000), "1h02m")
  assert.equal(DAG.formatElapsed(900), "0s")
})

test("leaf outputs list only finished leaves", () => {
  const run = drive(newRun([node("a"), node("b", { depends_on: ["a"] }), node("c", { depends_on: ["a"] })]), { b: { output: "B!" }, c: { fail: "no" } })
  assert.deepEqual(DAG.leafIds(run), ["b", "c"])
  assert.equal(DAG.formatLeafOutputs(run, { outputs: { b: "full B" } }), "### b\nfull B")
})

test("revision rises on every mutation and no-ops keep the same object", () => {
  const revisions = []
  let run = newRun([node("a"), node("b", { depends_on: ["a"] })])
  revisions.push(run.revision)
  const step = (next) => {
    assert.notEqual(next, run)
    assert.ok(next.revision > run.revision, `${next.revision} should exceed ${run.revision}`)
    assert.ok(next.updatedAt >= run.updatedAt)
    run = next
    revisions.push(run.revision)
  }
  step(begin(run, "a"))
  step(DAG.attachSession(run, "a", 1, "ses_a", 2100))
  step(DAG.setActivity(run, "a", 1, "tool: read", 2200))
  assert.equal(DAG.setActivity(run, "a", 1, "tool: read", 2300), run)
  step(DAG.completeNode(run, "a", 1, "A", 2400))
  step(begin(run, "b", 2500))
  step(DAG.failNode(run, "b", 1, "bad", 2600))
  step(DAG.retryRun(run, 2700).run)
  step(DAG.cancelRun(run, 2800))
  assert.deepEqual(revisions, [...revisions].sort((x, y) => x - y))
  assert.equal(new Set(revisions).size, revisions.length)
  assert.equal(begin(run, "a"), run)
})

test("runs survive a JSON round trip, so no key is left undefined", () => {
  let run = newRun([node("a", { agent: "build" }), node("b", { depends_on: ["a"] })])
  const roundTrip = () => assert.deepEqual(JSON.parse(JSON.stringify(run)), run)
  roundTrip()
  run = begin(run, "a")
  run = DAG.attachSession(run, "a", 1, "ses_a", 2100)
  run = DAG.setActivity(run, "a", 1, "tool: read", 2200)
  roundTrip()
  run = DAG.failNode(run, "a", 1, "boom", 2300)
  roundTrip()
  run = DAG.retryRun(run, 2400).run
  roundTrip()
  run = DAG.cancelRun(run, 2500)
  roundTrip()
  run = DAG.recoverRun(DAG.retryRun(run, 2600).run, 2700)
  roundTrip()
})

test("a recovered running run fails its running nodes and can be retried", () => {
  let run = newRun([node("a"), node("b"), node("c", { depends_on: ["a"] })])
  run = begin(run, "a")
  run = DAG.completeNode(run, "a", 1, "A", 2100)
  run = begin(run, "b")
  const recovered = DAG.recoverRun(run, 9000)
  assert.equal(recovered.status, "failed")
  assert.equal(recovered.error, "interrupted by restart")
  assert.deepEqual(recovered.nodes.map((item) => item.state), ["completed", "failed", "pending"])
  assert.equal(recovered.nodes[1].error, "interrupted by restart")
  assert.equal(DAG.recoverRun(recovered, 9100), recovered)
  const retried = DAG.retryRun(recovered, 9200)
  assert.equal(retried.ok, true)
  assert.equal(drive(retried.run, {}, 9300).status, "completed")
})

test("a running run with nothing runnable is failed instead of hanging", () => {
  const stuck = { ...newRun([node("a"), node("b", { depends_on: ["a"] })]) }
  stuck.nodes = stuck.nodes.map((item) => (item.id === "a" ? { ...item, state: "skipped" } : item))
  const settled = DAG.failStuck(stuck, 4000)
  assert.equal(settled.status, "failed")
  assert.equal(state(settled, "b"), "failed")
  assert.match(settled.nodes[1].error, /unschedulable/)
  const idle = newRun([node("a")])
  assert.equal(DAG.failStuck(idle, 4000), idle)
})

test("only the newest runs per origin session are retained", () => {
  const runs = []
  for (let i = 0; i < 12; i++) runs.push({ id: `r${i}`, sessionID: "s1", createdAt: i, status: i === 0 ? "running" : "completed" })
  runs.push({ id: "other", sessionID: "s2", createdAt: 1, status: "completed" })
  assert.deepEqual(DAG.selectEvictions(runs).sort(), ["r1"])
  assert.deepEqual(DAG.selectEvictions(runs, 5).sort(), ["r1", "r2", "r3", "r4", "r5", "r6"])
})

test("the final assistant text is read from the real message shape", () => {
  const messages = [
    { type: "user" },
    { type: "assistant", content: [{ type: "text", text: "first" }, { type: "tool", name: "read" }] },
    { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "final" }, { type: "text", text: "answer" }] },
  ]
  assert.deepEqual(DAG.lastAssistantResult(messages), { text: "final\nanswer" })
  assert.deepEqual(DAG.lastAssistantResult([{ type: "assistant", content: [] }, ...messages.slice(1, 2)].reverse()), { text: "first" })
  assert.deepEqual(DAG.lastAssistantResult([{ type: "user" }]), { text: "" })
  assert.deepEqual(
    DAG.lastAssistantResult([{ type: "assistant", content: [], finish: "error", error: { type: "x", message: "rate limited" } }]),
    { text: "", error: "rate limited" },
  )
})

// ---------------------------------------------------------------------------
// Server plugin, driven through a fake host built from the Promise API surface.

let typescript
try {
  typescript = require("typescript")
} catch {}
const NO_TS = typescript ? false : "typescript is not resolvable; run through prek or set NODE_PATH to a node_modules that has it"

const ORIGIN = "ses_origin"

function loadPlugin(rpcModule) {
  const compiled = typescript.transpileModule(readFileSync(INDEX_PATH, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
    fileName: INDEX_PATH,
    reportDiagnostics: true,
  })
  assert.equal(compiled.diagnostics?.length ?? 0, 0)
  const module = { exports: {} }
  const run = vm.runInThisContext(`(function (module, exports, require) {${compiled.outputText}\n})`, { filename: INDEX_PATH })
  run(module, module.exports, (id) => {
    if (id === "@opencode/plugin") return { Plugin: { define: (definition) => definition } }
    if (id === "./rpc.ts") return rpcModule ?? { AgentDag: { id: "questline.dag" } }
    if (id === "./dag.mjs") return DAG
    throw new Error(`unexpected import: ${id}`)
  })
  return module.exports.default
}

function deferred() {
  const result = {}
  result.promise = new Promise((resolve, reject) => {
    result.resolve = resolve
    result.reject = reject
  })
  return result
}

async function until(check, label, timeout = 3000) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) assert.fail(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" })
}

function makeHost(options = {}) {
  const store = options.store ?? new Map()
  const host = {
    store,
    created: [],
    prompts: [],
    interrupts: [],
    gates: {},
    sessionGates: {},
    sessionOutputs: {},
    usage: {},
    options: options.pluginOptions,
    ignoreAbort: false,
    outputs: {},
    errors: {},
    emitted: [],
    tools: {},
    streams: [],
    handlers: undefined,
    registered: undefined,
    metadata: new Map([[ORIGIN, { keep: true }]]),
  }
  const nodeIdOf = (sessionID) => host.created.find((item) => item.id === sessionID)?.input.metadata.dag.nodeId

  host.pushEvent = (event) => {
    for (const stream of host.streams) {
      stream.queue.push(event)
      const wake = stream.wake
      stream.wake = undefined
      wake?.()
    }
  }
  host.sessionOf = (nodeId) => host.created.filter((item) => item.input.metadata.dag.nodeId === nodeId).at(-1)?.id
  host.count = (nodeId) => host.created.filter((item) => item.input.metadata.dag.nodeId === nodeId).length

  host.ctx = {
    options: options.pluginOptions,
    session: {
      create: async (input) => {
        const id = `ses_child_${host.created.length + 1}`
        host.created.push({ id, input })
        return { id }
      },
      prompt: async ({ sessionID, text }) => {
        host.prompts.push({ sessionID, text, nodeId: nodeIdOf(sessionID) })
        return {}
      },
      wait: async ({ sessionID }, request) => {
        const gate = host.sessionGates[sessionID] ?? host.gates[nodeIdOf(sessionID)]
        if (!gate) return
        await new Promise((resolve, reject) => {
          gate.promise.then(resolve, reject)
          if (host.ignoreAbort) return
          if (request?.signal?.aborted) reject(abortError())
          request?.signal?.addEventListener("abort", () => reject(abortError()), { once: true })
        })
      },
      context: async ({ sessionID }) => {
        const nodeId = nodeIdOf(sessionID)
        const injected = typeof host.errors[nodeId] === "function" ? host.errors[nodeId](host.count(nodeId)) : host.errors[nodeId]
        if (injected) {
          return [{ type: "assistant", content: [], finish: "error", error: { type: "provider", message: injected } }]
        }
        return [
          { type: "user" },
          { type: "assistant", content: [{ type: "text", text: host.sessionOutputs[sessionID] ?? host.outputs[nodeId] ?? `output of ${nodeId}` }] },
        ]
      },
      get: async ({ sessionID }) => ({
        id: sessionID,
        outcome: "succeeded",
        metadata: host.metadata.get(sessionID),
        ...(host.usage[nodeIdOf(sessionID)] ?? {}),
      }),
      update: async ({ sessionID, metadata }) => {
        host.metadata.set(sessionID, JSON.parse(JSON.stringify(metadata)))
      },
      interrupt: async ({ sessionID }) => {
        host.interrupts.push(sessionID)
        return { interrupted: true }
      },
    },
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      remove: async (key) => {
        store.delete(key)
      },
      scan: async ({ prefix, after, limit = 100 }) => {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort()
        const page = keys.slice(0, limit)
        return {
          entries: page.map((key) => ({ key, value: store.get(key) })),
          ...(keys.length > page.length ? { next: page.at(-1) } : {}),
        }
      },
    },
    rpc: {
      register: async (definition, handlers) => {
        host.registered = definition
        host.handlers = handlers
        return {
          dispose: async () => {},
          events: { emit: async (name, data) => host.emitted.push({ name, data: JSON.parse(JSON.stringify(data)) }) },
        }
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => (host.tools[tool.name] = tool) })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: (options) => {
        const stream = { signal: options?.signal, queue: [], wake: undefined }
        host.streams.push(stream)
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise((resolve) => {
                const take = () => {
                  if (stream.signal?.aborted) return resolve({ done: true, value: undefined })
                  if (stream.queue.length) return resolve({ done: false, value: stream.queue.shift() })
                  stream.wake = take
                }
                stream.signal?.addEventListener("abort", take, { once: true })
                take()
              }),
            return: async () => ({ done: true, value: undefined }),
          }),
        }
      },
    },
  }

  host.rpcContext = { signal: new AbortController().signal, error: (type, message, data) => ({ type, message, data }) }
  host.call = (name, input) => host.tools[name].execute(input, { sessionID: ORIGIN, signal: new AbortController().signal })
  host.snapshot = (sessionID = ORIGIN) => host.handlers.snapshot({ sessionID }).then((result) => result.runs)
  host.latest = async () => (await host.snapshot())[0]
  return host
}

async function boot(host, rpcModule) {
  const plugin = loadPlugin(rpcModule)
  assert.equal(plugin.id, "questline")
  const cleanup = await plugin.setup(host.ctx)
  return { plugin, cleanup }
}

const diamond = [
  node("a", { agent: "build", label: "Gather" }),
  node("b", { depends_on: ["a"], prompt: "branch b" }),
  node("c", { depends_on: ["a"], prompt: "branch c" }),
  node("d", { depends_on: ["b", "c"], prompt: "join" }),
]

test("plugin registers the four tools and the RPC", { skip: NO_TS }, async () => {
  const host = makeHost()
  await boot(host)
  assert.deepEqual(Object.keys(host.tools).sort(), ["dag_cancel", "dag_retry", "dag_start", "dag_status"])
  assert.match(host.tools.dag_start.description, /only when the user explicitly asks/)
  assert.match(host.tools.dag_start.description, /Never use it for ordinary planning/)
  assert.equal(host.registered.id, "questline.dag")
  assert.deepEqual(Object.keys(host.handlers).sort(), ["cancel", "retry", "snapshot"])
})

test("a diamond DAG runs in child sessions, in parallel, and passes outputs downstream", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.gates.b = deferred()
  host.gates.c = deferred()
  host.outputs.b = "result from b"
  host.outputs.c = "result from c"

  const started = host.call("dag_start", { name: "diamond", nodes: diamond })
  await until(() => host.sessionOf("b") && host.sessionOf("c"), "b and c to start together")
  assert.equal(host.sessionOf("d"), undefined)
  const running = (await host.latest()).nodes.filter((item) => item.state === "running").map((item) => item.id)
  assert.deepEqual(running, ["b", "c"])
  host.gates.b.resolve()
  host.gates.c.resolve()
  const result = await started

  assert.equal(host.created.length, 4)
  for (const { input } of host.created) {
    assert.equal(input.parentID, ORIGIN)
    assert.match(input.title, /^dag diamond: /)
  }
  const first = host.created.find((item) => item.input.metadata.dag.nodeId === "a").input
  assert.equal(first.agent, "build")
  assert.equal(first.title, "dag diamond: Gather")
  assert.equal("agent" in host.created.find((item) => item.input.metadata.dag.nodeId === "b").input, false)

  const run = await host.latest()
  assert.equal(run.status, "completed")
  assert.equal(run.sessionID, ORIGIN)
  for (const item of host.created) assert.equal(item.input.metadata.dag.runId, run.id)
  assert.deepEqual(run.nodes.map((item) => item.state), ["completed", "completed", "completed", "completed"])
  assert.equal(run.nodes.find((item) => item.id === "b").sessionID, host.sessionOf("b"))

  const joinPrompt = host.prompts.find((item) => item.nodeId === "d").text
  assert.ok(joinPrompt.startsWith("join"))
  assert.match(joinPrompt, /### b\nresult from b/)
  assert.match(joinPrompt, /### c\nresult from c/)

  assert.match(result.content, /DAG "diamond" \(dag-[0-9a-f]+\): completed, 4\/4 completed/)
  assert.match(result.content, /\| d \| completed \|/)
  assert.match(result.content, /### d\noutput of d/)
  assert.doesNotMatch(result.content, /### b\n/)

  await cleanup()
})

test("a node's model is passed to its child session as a model ref, and omitted otherwise", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  await host.call("dag_start", {
    name: "models",
    nodes: [
      node("a", { model: "github-copilot/gpt-6-luna" }),
      node("b", { model: "github-copilot/gpt-6-luna#high" }),
      node("c"),
    ],
  })
  const input = (nodeId) => host.created.find((item) => item.input.metadata.dag.nodeId === nodeId).input
  assert.deepEqual(input("a").model, { providerID: "github-copilot", id: "gpt-6-luna" })
  assert.deepEqual(input("b").model, { providerID: "github-copilot", id: "gpt-6-luna", variant: "high" })
  assert.equal("model" in input("c"), false)
  await cleanup()
})

test("a step that outlives its timeout is failed and interrupted while siblings finish", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.gates.slow = deferred()
  const result = await host.call("dag_start", {
    name: "timeouts",
    nodes: [node("slow", { timeout: 1 }), node("quick", { timeout: 30 }), node("after", { depends_on: ["slow"] })],
  })
  const run = await host.latest()
  const states = Object.fromEntries(run.nodes.map((item) => [item.id, item.state]))
  assert.deepEqual(states, { slow: "failed", quick: "completed", after: "skipped" })
  assert.equal(run.nodes.find((item) => item.id === "slow").error, "timed out after 1s")
  assert.ok(host.interrupts.includes(host.sessionOf("slow")), "the hung child is interrupted")
  assert.equal(host.interrupts.includes(host.sessionOf("quick")), false)
  assert.match(result.content, /slow: timed out after 1s/)
  await cleanup()
})

test("a token cap stops a step while it is still running, not after it ends", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost({ pluginOptions: { guardIntervalMs: 20 } })
  const { cleanup } = await boot(host)
  host.gates.hog = deferred()
  host.usage.hog = { cost: 0, tokens: { input: 90000, output: 20, reasoning: 5 } }
  host.usage.lean = { cost: 0, tokens: { input: 23000, output: 10, reasoning: 0 } }
  await host.call("dag_start", {
    name: "budget",
    nodes: [node("hog", { maxTokens: 50000 }), node("lean", { maxTokens: 50000 })],
  })
  const run = await host.latest()
  const states = Object.fromEntries(run.nodes.map((item) => [item.id, item.state]))
  assert.deepEqual(states, { hog: "failed", lean: "completed" })
  assert.match(run.nodes.find((item) => item.id === "hog").error, /exceeded maxTokens 50000 \(used 90025\)/)
  assert.ok(host.interrupts.includes(host.sessionOf("hog")))
  await cleanup()
})

test("a cost cap stops a metered step, and is silent for a provider that reports zero cost", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost({ pluginOptions: { guardIntervalMs: 20 } })
  const { cleanup } = await boot(host)
  host.gates.metered = deferred()
  host.usage.metered = { cost: 0.5, tokens: { input: 1000, output: 10, reasoning: 0 } }
  host.usage.flat = { cost: 0, tokens: { input: 90000, output: 10, reasoning: 0 } }
  await host.call("dag_start", {
    name: "money",
    nodes: [node("metered", { maxCost: 0.1 }), node("flat", { maxCost: 0.1 })],
  })
  const run = await host.latest()
  const states = Object.fromEntries(run.nodes.map((item) => [item.id, item.state]))
  assert.deepEqual(states, { metered: "failed", flat: "completed" })
  assert.match(run.nodes.find((item) => item.id === "metered").error, /exceeded maxCost \$0\.1 \(actual \$0\.5000\)/)
  await cleanup()
})

test("a step that always fails stops after retries + 1 sessions and skips its dependents", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.errors.flaky = "boom"
  await host.call("dag_start", {
    name: "bounded",
    nodes: [node("flaky", { retries: 2 }), node("after", { depends_on: ["flaky"] }), node("solo")],
  })
  const run = await host.latest()
  const byId = Object.fromEntries(run.nodes.map((item) => [item.id, item]))
  assert.equal(host.count("flaky"), 3, "exactly retries + 1 sessions, never a fourth")
  assert.equal(byId.flaky.state, "failed")
  assert.equal(byId.flaky.attempt, 3)
  assert.match(byId.flaky.error, /boom/)
  assert.equal(byId.after.state, "skipped")
  assert.equal(host.count("after"), 0)
  assert.equal(byId.solo.state, "completed")
  assert.equal(host.count("solo"), 1)
  await cleanup()
})

test("a step with no retries gets one session", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.errors.once = "boom"
  await host.call("dag_start", { name: "single", nodes: [node("once")] })
  assert.equal(host.count("once"), 1)
  assert.equal((await host.latest()).nodes[0].state, "failed")
  await cleanup()
})

test("a step that fails twice and then succeeds completes on its third attempt and unblocks its dependents", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.errors.shaky = (attempt) => (attempt < 3 ? `transient ${attempt}` : undefined)
  host.outputs.shaky = "finally"
  const result = await host.call("dag_start", {
    name: "recovers",
    nodes: [node("shaky", { retries: 2 }), node("next", { depends_on: ["shaky"] })],
  })
  const run = await host.latest()
  assert.equal(run.status, "completed")
  assert.equal(host.count("shaky"), 3)
  assert.equal(run.nodes[0].attempt, 3)
  assert.equal(run.nodes[0].state, "completed")
  assert.equal(host.count("next"), 1)
  assert.match(host.prompts.find((item) => item.nodeId === "next").text, /### shaky\nfinally/)
  assert.match(result.content, /\| shaky \| completed \(attempt 3\) \|/)
  await cleanup()
})

test("a step that blows its budget is not retried", { skip: NO_TS, timeout: 15000 }, async () => {
  const host = makeHost({ pluginOptions: { guardIntervalMs: 20 } })
  const { cleanup } = await boot(host)
  host.gates.hog = deferred()
  host.usage.hog = { cost: 0, tokens: { input: 90000, output: 20, reasoning: 5 } }
  await host.call("dag_start", { name: "no-retry-on-spend", nodes: [node("hog", { maxTokens: 50000, retries: 3 })] })
  const run = await host.latest()
  assert.equal(host.count("hog"), 1, "an overspend must not be run again")
  assert.equal(run.nodes[0].state, "failed")
  assert.match(run.nodes[0].error, /exceeded maxTokens/)
  await cleanup()
})

test("a timed-out step is retried, then stops at its limit", { skip: NO_TS, timeout: 20000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.sessionGates = new Proxy({}, { get: () => deferred() })
  await host.call("dag_start", { name: "timeouts-retry", nodes: [node("slow", { timeout: 1, retries: 1 })] })
  const run = await host.latest()
  assert.equal(host.count("slow"), 2)
  assert.equal(run.nodes[0].state, "failed")
  assert.equal(run.nodes[0].error, "timed out after 1s")
  await cleanup()
})

test("many steps asking for retries still stop at the run-wide cap", { skip: NO_TS, timeout: 20000 }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  const ids = ["a", "b", "c", "d", "e", "f"]
  for (const id of ids) host.errors[id] = "boom"
  await host.call("dag_start", { name: "cap", maxParallel: 8, nodes: ids.map((id) => node(id, { retries: 3 })) })
  const total = ids.reduce((sum, id) => sum + host.count(id), 0)
  assert.equal(total, ids.length + DAG.MAX_RUN_RETRIES)
  const run = await host.latest()
  assert.equal(run.status, "failed")
  assert.ok(run.nodes.every((item) => item.state === "failed"))
  await cleanup()
})

test("updates are emitted with the origin session, in order, and always end on the final state", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  await host.call("dag_start", { nodes: diamond })
  const run = await host.latest()

  assert.ok(host.emitted.length >= 2)
  assert.ok(host.emitted.every((item) => item.name === "updated" && item.data.sessionID === ORIGIN))
  const revisions = host.emitted.map((item) => item.data.run.revision)
  assert.deepEqual(revisions, [...revisions].sort((x, y) => x - y))
  assert.equal(new Set(revisions).size, revisions.length)
  assert.deepEqual(host.emitted.at(-1).data.run, run)
  assert.equal(run.status, "completed")
  await cleanup()
})

test("bursts of mutations are coalesced into few emits", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  await host.call("dag_start", { maxParallel: 8, nodes: Array.from({ length: 12 }, (_, i) => node(`n${i}`)) })
  const run = await host.latest()
  assert.ok(run.revision > 30)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(host.emitted.length <= 4, `expected few emits, got ${host.emitted.length} for revision ${run.revision}`)
  assert.equal(host.emitted.at(-1).data.run.revision, run.revision)
  await cleanup()
})

test("a snapshot for a child session returns the parent's DAG", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  await host.call("dag_start", { nodes: diamond })
  const run = await host.latest()
  const viaChild = await host.snapshot(host.sessionOf("b"))
  assert.deepEqual(viaChild.map((item) => item.id), [run.id])
  assert.deepEqual(await host.snapshot("ses_unrelated"), [])
  await cleanup()
})

test("runs are persisted per run and the origin session gets a merged summary", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  await host.call("dag_start", { nodes: diamond })
  const run = await host.latest()

  assert.deepEqual([...host.store.keys()], [`run/${run.id}`])
  const stored = host.store.get(`run/${run.id}`)
  assert.equal(stored.run.status, "completed")
  assert.equal(stored.texts.outputs.d, "output of d")

  await until(() => host.metadata.get(ORIGIN).dag?.status === "completed", "summary to settle")
  assert.deepEqual(host.metadata.get(ORIGIN), {
    keep: true,
    dag: { runId: run.id, status: "completed", done: 4, total: 4, updatedAt: run.updatedAt },
  })
  await cleanup()
})

test("a restart turns a running run into a failed one that retry can finish", { skip: NO_TS }, async () => {
  const first = makeHost()
  const { cleanup: stopFirst } = await boot(first)
  first.gates.a = deferred()
  const started = await first.call("dag_start", { wait: false, nodes: diamond })
  assert.match(started.content, /Started DAG run dag-/)
  await until(() => first.sessionOf("a"), "a to start")
  await until(() => first.store.size === 1, "state to be saved")

  const second = makeHost({ store: first.store })
  const { cleanup: stopSecond } = await boot(second)
  const [run] = await second.snapshot()
  assert.equal(run.status, "failed")
  assert.equal(run.error, "interrupted by restart")
  assert.deepEqual(run.nodes.map((item) => item.state), ["failed", "pending", "pending", "pending"])
  assert.equal(run.nodes[0].error, "interrupted by restart")
  assert.equal(first.store.get(`run/${run.id}`).run.status, "failed")

  const retried = await second.call("dag_retry", { runId: run.id })
  assert.match(retried.content, /: completed, 4\/4 completed/)
  const [done] = await second.snapshot()
  assert.equal(done.status, "completed")
  assert.equal(done.nodes[0].attempt, 2)

  await stopFirst()
  await stopSecond()
})

test("retry re-runs only failed work and refuses a run that is still going", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.errors.b = "provider exploded"
  const failed = await host.call("dag_start", { nodes: diamond })
  assert.match(failed.content, /: failed, 2\/4 completed, 1 failed, 1 skipped/)
  assert.match(failed.content, /- b: provider exploded/)
  assert.match(failed.content, /dag_retry/)
  const before = await host.latest()
  assert.deepEqual(before.nodes.map((item) => item.state), ["completed", "failed", "completed", "skipped"])
  assert.equal(host.count("a"), 1)

  delete host.errors.b
  const result = await host.handlers.retry({ runId: before.id }, host.rpcContext)
  assert.equal(result.run.status, "running")
  await until(() => host.count("d") === 1 && host.store.get(`run/${before.id}`)?.run.status === "completed", "retry to finish")

  const run = await host.latest()
  assert.deepEqual(run.nodes.map((item) => [item.state, item.attempt]), [["completed", 1], ["completed", 2], ["completed", 1], ["completed", 2]])
  assert.equal(host.count("a"), 1)
  assert.equal(host.count("b"), 2)
  assert.equal(host.count("c"), 1)
  assert.match(host.prompts.find((item) => item.nodeId === "d").text, /### c\noutput of c/)

  const noop = await host.call("dag_retry", {})
  assert.match(noop.content, /Nothing to retry/)
  await cleanup()
})

test("retry over RPC reports not_finished while the run is running", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.gates.a = deferred()
  await host.call("dag_start", { wait: false, nodes: diamond })
  const run = await host.latest()
  const refused = await host.handlers.retry({ runId: run.id }, host.rpcContext)
  assert.equal(refused.type, "not_finished")
  assert.deepEqual(refused.data, { runId: run.id })
  assert.deepEqual(await host.handlers.retry({ runId: "dag-missing" }, host.rpcContext), {})
  assert.deepEqual(await host.handlers.cancel({ runId: "dag-missing" }), {})
  host.gates.a.resolve()
  await until(async () => (await host.latest()).status === "completed", "run to finish")
  await cleanup()
})

test("aborting the tool call cancels the run and interrupts running children", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.gates.b = deferred()
  host.gates.c = deferred()
  const controller = new AbortController()
  const call = host.tools.dag_start.execute({ nodes: diamond }, { sessionID: ORIGIN, signal: controller.signal })
  await until(() => host.sessionOf("b") && host.sessionOf("c"), "b and c to start")
  const [b, c] = [host.sessionOf("b"), host.sessionOf("c")]
  controller.abort()
  const result = await call

  assert.match(result.content, /: cancelled, 1\/4 completed/)
  assert.deepEqual(host.interrupts.sort(), [b, c].sort())
  const run = await host.latest()
  assert.equal(run.status, "cancelled")
  assert.deepEqual(run.nodes.map((item) => item.state), ["completed", "cancelled", "cancelled", "cancelled"])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await host.latest()).status, "cancelled")
  assert.equal(host.sessionOf("d"), undefined)
  assert.equal(host.emitted.at(-1).data.run.status, "cancelled")
  await cleanup()
})

test("dag_cancel and RPC cancel stop a background run", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.gates.a = deferred()
  await host.call("dag_start", { wait: false, nodes: diamond })
  await until(() => host.sessionOf("a"), "a to start")
  const run = await host.latest()
  const cancelled = await host.handlers.cancel({ runId: run.id })
  assert.equal(cancelled.run.status, "cancelled")
  assert.deepEqual(host.interrupts, [host.sessionOf("a")])
  const status = await host.call("dag_status", {})
  assert.match(status.content, /: cancelled/)
  const again = await host.call("dag_cancel", { runId: run.id })
  assert.match(again.content, /: cancelled/)
  assert.equal(host.interrupts.length, 1)
  await cleanup()
})

test("a late result from a cancelled attempt cannot overwrite the retried node", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.ignoreAbort = true
  host.sessionGates = { ses_child_1: deferred(), ses_child_2: deferred() }
  host.sessionOutputs = { ses_child_1: "stale output", ses_child_2: "fresh output" }

  await host.call("dag_start", { wait: false, nodes: [node("a")] })
  await until(() => host.sessionOf("a"), "first attempt to start")
  const run = await host.latest()
  await host.handlers.cancel({ runId: run.id })
  const retried = await host.handlers.retry({ runId: run.id }, host.rpcContext)
  assert.equal(retried.run.status, "running")
  await until(() => host.count("a") === 2, "second attempt to start")

  host.sessionGates.ses_child_2.resolve()
  await until(async () => (await host.latest()).status === "completed", "second attempt to finish")
  host.sessionGates.ses_child_1.resolve()
  await new Promise((resolve) => setTimeout(resolve, 30))

  const done = await host.latest()
  assert.equal(done.status, "completed")
  assert.deepEqual([done.nodes[0].attempt, done.nodes[0].output, done.nodes[0].sessionID], [2, "fresh output", "ses_child_2"])
  const status = await host.call("dag_status", { runId: run.id })
  assert.match(status.content, /### a\nfresh output/)
  assert.doesNotMatch(status.content, /stale output/)
  await cleanup()
})

test("node activity follows tool and permission events for the node's session", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.gates.a = deferred()
  await host.call("dag_start", { wait: false, nodes: [node("a"), node("z")] })
  await until(() => host.sessionOf("a") && host.streams.length === 1, "event stream")
  const sessionID = host.sessionOf("a")
  const activity = async () => (await host.latest()).nodes.find((item) => item.id === "a").activity

  const expectActivity = (expected) => until(async () => (await activity()) === expected, `activity ${expected}`)

  host.pushEvent({ type: "session.tool.input.started", data: { sessionID, name: "bash" } })
  await expectActivity("tool: bash")
  host.pushEvent({ type: "permission.asked", data: { sessionID } })
  await expectActivity("waiting on permission")
  host.pushEvent({ type: "permission.replied", data: { sessionID } })
  await expectActivity("tool: bash")
  host.pushEvent({ type: "session.tool.success", data: { sessionID } })
  await expectActivity(undefined)
  host.pushEvent({ type: "session.tool.input.started", data: { sessionID: "ses_elsewhere", name: "read" } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await activity(), undefined)

  host.gates.a.resolve()
  await until(async () => (await host.latest()).status === "completed", "run to finish")
  assert.equal(host.streams[0].signal.aborted, true)
  await cleanup()
})

test("bad specs and nested starts are refused without creating sessions", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  const bad = await host.call("dag_start", { nodes: [node("a", { depends_on: ["b"] }), node("b", { depends_on: ["a"] }), node("a")] })
  assert.match(bad.content, /^Invalid DAG spec:/)
  assert.match(bad.content, /- node 'a': duplicate id/)
  assert.match(bad.content, /- dependency cycle among/)
  assert.equal(host.created.length, 0)
  assert.deepEqual(await host.snapshot(), [])

  host.gates.a = deferred()
  await host.call("dag_start", { wait: false, nodes: [node("a")] })
  await until(() => host.sessionOf("a"), "a to start")
  const nested = await host.tools.dag_start.execute({ nodes: [node("x")] }, { sessionID: host.sessionOf("a"), signal: new AbortController().signal })
  assert.match(nested.content, /cannot be used from inside a DAG step/)
  assert.equal(host.count("x"), 0)
  host.gates.a.resolve()
  await until(async () => (await host.latest()).status === "completed", "run to finish")
  await cleanup()
})

test("a failing child stops its branch but not its siblings", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  host.errors.b = "nope"
  await host.call("dag_start", { nodes: diamond })
  const run = await host.latest()
  assert.equal(run.status, "failed")
  assert.equal(host.sessionOf("d"), undefined)
  assert.equal(run.nodes.find((item) => item.id === "c").state, "completed")
  await cleanup()
})

test("a throwing session API becomes a node failure with the error text", { skip: NO_TS }, async () => {
  const host = makeHost()
  host.ctx.session.create = async () => {
    throw new Error("agent 'ghost' not found")
  }
  const { cleanup } = await boot(host)
  const result = await host.call("dag_start", { nodes: [node("a", { agent: "ghost" }), node("b", { depends_on: ["a"] })] })
  assert.match(result.content, /: failed, 0\/2 completed, 1 failed, 1 skipped/)
  assert.match(result.content, /- a: agent 'ghost' not found/)
  await cleanup()
})

test("only the newest ten runs per session are kept", { skip: NO_TS }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host)
  const ids = []
  for (let i = 0; i < 12; i++) {
    await host.call("dag_start", { name: `r${i}`, nodes: [node("a")] })
    ids.push((await host.latest()).id)
  }
  await until(() => host.store.size === 10, "old runs to be evicted")
  const kept = await host.snapshot()
  assert.equal(kept.length, 10)
  assert.equal(kept[0].id, ids.at(-1))
  assert.deepEqual(kept.map((item) => item.id), ids.slice(2).reverse())
  assert.deepEqual([...host.store.keys()].sort(), ids.slice(2).map((id) => `run/${id}`).sort())
  await cleanup()
})

// ---------------------------------------------------------------------------
// Conformance against the real RPC schema, only where the runtime packages resolve.

let realRpc
let realSchema
let noRpc = "@opencode/plugin/rpc cannot be resolved here; run with the OpenCode runtime's node_modules reachable"
try {
  import.meta.resolve("@opencode/plugin/rpc")
  realRpc = await import(new URL("rpc.ts", PLUGIN_DIR).href)
  realSchema = (await import("effect")).Schema
  noRpc = false
} catch {}

test("every emitted run and snapshot satisfies the RPC schema", { skip: NO_TS || noRpc }, async () => {
  const host = makeHost()
  const { cleanup } = await boot(host, realRpc)
  assert.equal(host.registered, realRpc.AgentDag)
  host.errors.b = "provider exploded"
  host.gates.a = deferred()
  const started = host.call("dag_start", { nodes: diamond })
  await until(() => host.sessionOf("a"), "a to start")
  host.pushEvent({ type: "session.tool.input.started", data: { sessionID: host.sessionOf("a"), name: "bash" } })
  host.gates.a.resolve()
  await started
  const [run] = await host.snapshot()
  await host.handlers.retry({ runId: run.id }, host.rpcContext)

  const decodeRun = realSchema.decodeUnknownSync(realRpc.Run)
  assert.ok(host.emitted.length > 1)
  for (const { data } of host.emitted) decodeRun(data.run)
  decodeRun(run)
  realSchema.decodeUnknownSync(realRpc.AgentDag.methods.snapshot.output)({ runs: await host.snapshot() })
  realSchema.decodeUnknownSync(realRpc.AgentDag.methods.cancel.output)(await host.handlers.cancel({ runId: run.id }))
  realSchema.decodeUnknownSync(realRpc.AgentDag.events.updated.schema)(host.emitted.at(-1).data)
  await cleanup()
})
