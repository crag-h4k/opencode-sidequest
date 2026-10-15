// dag.mjs
export const MAX_NODES = 24
export const DEFAULT_PARALLEL = 3
export const MAX_PARALLEL = 8
export const STORED_TEXT_LIMIT = 2000
export const DEP_OUTPUT_LIMIT = 4000
export const RETAINED_RUNS = 10
export const MAX_NODE_RETRIES = 3
export const MAX_RUN_RETRIES = 6

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const NODE_KEYS = new Set(["id", "prompt", "agent", "model", "timeout", "maxCost", "maxTokens", "retries", "label", "depends_on"])
const MAX_ERRORS = 30
const ERROR_LIMIT = 1000

export function truncate(text, limit) {
  const value = typeof text === "string" ? text : String(text ?? "")
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 3))}...`
}

export function validateSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["spec must be an object with a nodes array"] }
  }
  const errors = []

  let name = "dag"
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== "string" || !input.name.trim()) errors.push("name must be a non-empty string")
    else name = truncate(input.name.trim(), 80)
  }

  let maxParallel = DEFAULT_PARALLEL
  if (input.maxParallel !== undefined && input.maxParallel !== null) {
    if (!Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > MAX_PARALLEL) {
      errors.push(`maxParallel must be an integer from 1 to ${MAX_PARALLEL}`)
    } else maxParallel = input.maxParallel
  }

  if (!Array.isArray(input.nodes)) {
    errors.push("nodes must be an array")
    return { ok: false, errors }
  }
  if (input.nodes.length < 1 || input.nodes.length > MAX_NODES) {
    errors.push(`nodes must have 1 to ${MAX_NODES} entries, got ${input.nodes.length}`)
  }

  const nodes = []
  const ids = new Set()
  input.nodes.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`node #${index + 1}: must be an object`)
      return
    }
    const ref = typeof raw.id === "string" && raw.id ? `node '${raw.id}'` : `node #${index + 1}`
    for (const key of Object.keys(raw)) {
      if (!NODE_KEYS.has(key)) errors.push(`${ref}: unknown field '${key}' (allowed: ${[...NODE_KEYS].join(", ")})`)
    }

    let usable = true
    if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
      errors.push(`${ref}: id must match ${ID_PATTERN}`)
      usable = false
    } else if (ids.has(raw.id)) {
      errors.push(`${ref}: duplicate id`)
      usable = false
    }
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
      errors.push(`${ref}: prompt must be a non-empty string`)
      usable = false
    }
    if (raw.agent !== undefined && raw.agent !== null && (typeof raw.agent !== "string" || !raw.agent.trim())) {
      errors.push(`${ref}: agent must be a non-empty string`)
      usable = false
    }
    if (raw.model !== undefined && raw.model !== null && (typeof raw.model !== "string" || !raw.model.trim() || !raw.model.includes("/"))) {
      errors.push(`${ref}: model must be "provider/modelID" (for example github-copilot/kimi-k3)`)
      usable = false
    }
    if (raw.timeout !== undefined && raw.timeout !== null && (!Number.isInteger(raw.timeout) || raw.timeout < 1 || raw.timeout > 3600)) {
      errors.push(`${ref}: timeout must be an integer from 1 to 3600 seconds`)
      usable = false
    }
    if (raw.maxCost !== undefined && raw.maxCost !== null && (typeof raw.maxCost !== "number" || !Number.isFinite(raw.maxCost) || raw.maxCost <= 0)) {
      errors.push(`${ref}: maxCost must be a positive number of USD`)
      usable = false
    }
    if (raw.maxTokens !== undefined && raw.maxTokens !== null && (!Number.isInteger(raw.maxTokens) || raw.maxTokens < 1)) {
      errors.push(`${ref}: maxTokens must be a positive integer`)
      usable = false
    }
    if (raw.retries !== undefined && raw.retries !== null && (!Number.isInteger(raw.retries) || raw.retries < 0 || raw.retries > MAX_NODE_RETRIES)) {
      errors.push(`${ref}: retries must be an integer from 0 to ${MAX_NODE_RETRIES}`)
      usable = false
    }
    if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== "string" || !raw.label.trim())) {
      errors.push(`${ref}: label must be a non-empty string`)
      usable = false
    }
    let dependsOn = []
    if (raw.depends_on !== undefined && raw.depends_on !== null) {
      if (!Array.isArray(raw.depends_on) || raw.depends_on.some((dep) => typeof dep !== "string")) {
        errors.push(`${ref}: depends_on must be an array of node ids`)
        usable = false
      } else dependsOn = [...new Set(raw.depends_on)]
    }
    if (!usable) return

    ids.add(raw.id)
    const node = {
      id: raw.id,
      prompt: raw.prompt,
      label: raw.label ? raw.label.trim() : raw.id,
      dependsOn,
    }
    if (raw.agent) node.agent = raw.agent.trim()
    if (raw.model) node.model = raw.model.trim()
    if (raw.timeout) node.timeout = raw.timeout
    if (raw.maxCost) node.maxCost = raw.maxCost
    if (raw.maxTokens) node.maxTokens = raw.maxTokens
    if (raw.retries) node.retries = raw.retries
    nodes.push(node)
  })

  const edges = new Map(nodes.map((node) => [node.id, []]))
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) errors.push(`node '${node.id}': depends on itself`)
      else if (!ids.has(dep)) errors.push(`node '${node.id}': depends on unknown node '${dep}'`)
      else edges.get(node.id).push(dep)
    }
  }
  const cycle = findCycleMembers(edges)
  if (cycle.length) errors.push(`dependency cycle among: ${cycle.join(", ")}`)

  if (errors.length) {
    const shown = errors.slice(0, MAX_ERRORS)
    if (errors.length > shown.length) shown.push(`...and ${errors.length - shown.length} more`)
    return { ok: false, errors: shown }
  }
  return { ok: true, spec: { name, maxParallel, nodes } }
}

// Kahn from the roots leaves cycles plus everything downstream of them; peeling
// nodes nothing else depends on leaves only the nodes that sit on a cycle.
function findCycleMembers(edges) {
  const remaining = new Map([...edges].map(([id, deps]) => [id, new Set(deps)]))
  const peel = (ready) => {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, deps] of [...remaining]) {
        if (!ready(id, deps)) continue
        remaining.delete(id)
        for (const other of remaining.values()) other.delete(id)
        changed = true
      }
    }
  }
  peel((_id, deps) => deps.size === 0)
  if (!remaining.size) return []
  peel((id) => ![...remaining.values()].some((deps) => deps.has(id)))
  return [...remaining.keys()]
}

export function createRun(spec, { id, sessionID, now }) {
  return {
    id,
    name: spec.name,
    sessionID,
    status: "running",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    maxParallel: spec.maxParallel,
    nodes: spec.nodes.map((node) => {
      const next = {
        id: node.id,
        label: node.label,
        dependsOn: [...node.dependsOn],
        state: "pending",
        attempt: 1,
        prompt: truncate(node.prompt, STORED_TEXT_LIMIT),
      }
      if (node.agent) next.agent = node.agent
      if (node.model) next.model = node.model
      if (node.timeout) next.timeout = node.timeout
      if (node.maxCost) next.maxCost = node.maxCost
      if (node.maxTokens) next.maxTokens = node.maxTokens
      if (node.retries) next.retries = node.retries
      return next
    }),
  }
}

// A warm child reports its context as cache.read rather than input, so cached tokens count too.
export function tokensUsed(tokens) {
  return (
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)
  )
}

// Free or unpriced models report a cost of 0, so the token cap is the one that always applies.
export function budgetViolation(info, { maxCost, maxTokens } = {}) {
  if (maxCost !== undefined && typeof info?.cost === "number" && info.cost > maxCost) {
    return `exceeded maxCost $${maxCost} (actual $${info.cost.toFixed(4)})`
  }
  if (maxTokens !== undefined) {
    const used = tokensUsed(info?.tokens)
    if (used > maxTokens) return `exceeded maxTokens ${maxTokens} (used ${used})`
  }
  return undefined
}

export function isTerminal(run) {
  return run.status !== "running"
}

function find(run, id) {
  return run.nodes.find((node) => node.id === id)
}

function patch(object, changes) {
  const next = { ...object, ...changes }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  return next
}

function bump(run, changes, now) {
  return patch(run, { ...changes, revision: run.revision + 1, updatedAt: now })
}

function replaceNode(nodes, id, node) {
  return nodes.map((item) => (item.id === id ? node : item))
}

function isLive(run, node, attempt) {
  return run.status === "running" && node?.state === "running" && node.attempt === attempt
}

function derive(run, nodes, now, changes = {}) {
  const base = { ...changes, nodes }
  if (nodes.some((node) => node.state === "pending" || node.state === "running")) return bump(run, base, now)
  const failed = nodes.filter((node) => node.state === "failed").map((node) => node.id)
  if (!failed.length) return bump(run, { ...base, status: "completed", finishedAt: now }, now)
  return bump(
    run,
    { ...base, status: "failed", finishedAt: now, error: `${failed.length} node(s) failed: ${failed.join(", ")}` },
    now,
  )
}

export function readyNodes(run) {
  if (run.status !== "running") return []
  const running = run.nodes.filter((node) => node.state === "running").length
  const slots = run.maxParallel - running
  if (slots <= 0) return []
  const done = new Set(run.nodes.filter((node) => node.state === "completed").map((node) => node.id))
  return run.nodes
    .filter((node) => node.state === "pending" && node.dependsOn.every((dep) => done.has(dep)))
    .slice(0, slots)
    .map((node) => node.id)
}

export function startNode(run, id, { prompt, now }) {
  const node = find(run, id)
  if (run.status !== "running" || node?.state !== "pending") return run
  const next = patch(node, {
    state: "running",
    startedAt: now,
    prompt: truncate(prompt, STORED_TEXT_LIMIT),
    finishedAt: undefined,
    error: undefined,
  })
  return bump(run, { nodes: replaceNode(run.nodes, id, next) }, now)
}

export function attachSession(run, id, attempt, sessionID, now) {
  const node = find(run, id)
  if (!isLive(run, node, attempt) || node.sessionID === sessionID) return run
  return bump(run, { nodes: replaceNode(run.nodes, id, patch(node, { sessionID })) }, now)
}

export function setActivity(run, id, attempt, activity, now) {
  const node = find(run, id)
  if (!isLive(run, node, attempt) || node.activity === activity) return run
  return bump(run, { nodes: replaceNode(run.nodes, id, patch(node, { activity })) }, now)
}

export function completeNode(run, id, attempt, output, now) {
  const node = find(run, id)
  if (!isLive(run, node, attempt)) return run
  const next = patch(node, {
    state: "completed",
    finishedAt: now,
    output: truncate(output, STORED_TEXT_LIMIT),
    activity: undefined,
    error: undefined,
  })
  return derive(run, replaceNode(run.nodes, id, next), now)
}

export function failNode(run, id, attempt, error, now) {
  const node = find(run, id)
  if (!isLive(run, node, attempt)) return run
  const failed = patch(node, {
    state: "failed",
    finishedAt: now,
    error: truncate(error || "failed", ERROR_LIMIT),
    activity: undefined,
  })
  const downstream = dependentsOf(run.nodes, id)
  const nodes = replaceNode(run.nodes, id, failed).map((item) =>
    downstream.has(item.id) && item.state === "pending"
      ? patch(item, { state: "skipped", finishedAt: now, error: `skipped: upstream '${id}' failed` })
      : item,
  )
  return derive(run, nodes, now)
}

// Extra attempts consumed so far, automatic or manual.
export function retriesUsed(run) {
  return run.nodes.reduce((total, node) => total + (node.attempt - 1), 0)
}

// Automatic retry. Terminates by construction: a step gets at most `retries + 1` attempts, and a
// run never exceeds MAX_RUN_RETRIES extra attempts in total, whatever its spec asks for.
// Returns undefined when the step may not retry, so the caller fails it instead.
export function requeueNode(run, id, attempt, error, now) {
  const node = find(run, id)
  if (!isLive(run, node, attempt)) return undefined
  if (attempt > (node.retries ?? 0)) return undefined
  if (retriesUsed(run) >= MAX_RUN_RETRIES) return undefined
  const next = patch(node, {
    state: "pending",
    attempt: attempt + 1,
    sessionID: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    activity: undefined,
    output: undefined,
    error: truncate(`attempt ${attempt} failed: ${error || "failed"}`, ERROR_LIMIT),
  })
  return bump(run, { nodes: replaceNode(run.nodes, id, next) }, now)
}

function dependentsOf(nodes, id) {
  const found = new Set()
  const queue = [id]
  while (queue.length) {
    const current = queue.pop()
    for (const node of nodes) {
      if (node.dependsOn.includes(current) && !found.has(node.id)) {
        found.add(node.id)
        queue.push(node.id)
      }
    }
  }
  return found
}

// Safety net: a running run with nothing runnable would otherwise hang forever.
export function failStuck(run, now) {
  if (run.status !== "running") return run
  if (run.nodes.some((node) => node.state === "running") || readyNodes(run).length) return run
  if (!run.nodes.some((node) => node.state === "pending")) return derive(run, run.nodes, now)
  const nodes = run.nodes.map((node) =>
    node.state === "pending"
      ? patch(node, { state: "failed", finishedAt: now, error: "unschedulable: dependencies can never complete" })
      : node,
  )
  return derive(run, nodes, now)
}

export function cancelRun(run, now, reason) {
  if (run.status !== "running") return run
  const nodes = run.nodes.map((node) => {
    if (node.state === "running") {
      return patch(node, { state: "cancelled", finishedAt: now, activity: undefined })
    }
    if (node.state === "pending") return patch(node, { state: "cancelled", finishedAt: now })
    return node
  })
  return bump(run, { nodes, status: "cancelled", finishedAt: now, error: reason }, now)
}

export function retryRun(run, now) {
  if (run.status === "running") return { ok: false, reason: "running" }
  const reset = new Set(["failed", "skipped", "cancelled"])
  if (!run.nodes.some((node) => reset.has(node.state))) return { ok: true, changed: false, run }
  const nodes = run.nodes.map((node) =>
    reset.has(node.state)
      ? patch(node, {
          state: "pending",
          attempt: node.attempt + 1,
          sessionID: undefined,
          startedAt: undefined,
          finishedAt: undefined,
          activity: undefined,
          error: undefined,
          output: undefined,
        })
      : node,
  )
  const next = bump(run, { nodes, status: "running", finishedAt: undefined, error: undefined }, now)
  return { ok: true, changed: true, run: next }
}

export function recoverRun(run, now) {
  if (run.status !== "running") return run
  const message = "interrupted by restart"
  const nodes = run.nodes.map((node) =>
    node.state === "running"
      ? patch(node, { state: "failed", finishedAt: now, activity: undefined, error: message })
      : node,
  )
  return bump(run, { nodes, status: "failed", finishedAt: now, error: message }, now)
}

export function selectEvictions(runs, limit = RETAINED_RUNS) {
  const bySession = new Map()
  for (const run of runs) {
    const group = bySession.get(run.sessionID) ?? []
    group.push(run)
    bySession.set(run.sessionID, group)
  }
  const evict = []
  for (const group of bySession.values()) {
    group.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    for (const run of group.slice(limit)) if (run.status !== "running") evict.push(run.id)
  }
  return evict
}

export function buildNodePrompt(run, id, texts = {}) {
  const node = find(run, id)
  const own = texts.prompts?.[id] ?? node.prompt ?? ""
  const sections = node.dependsOn.map((dep) => {
    const output = texts.outputs?.[dep] ?? find(run, dep)?.output ?? ""
    return `### ${dep}\n${truncate(output, DEP_OUTPUT_LIMIT) || "(no output)"}`
  })
  if (!sections.length) return own
  return `${own}\n\n## Results from upstream steps\n\n${sections.join("\n\n")}`
}

// Failure comes from the final assistant message; the text is the latest
// non-empty one, since a closing tool call can leave the last message blank.
export function lastAssistantResult(messages) {
  const assistants = messages.filter((message) => message?.type === "assistant")
  const last = assistants.at(-1)
  if (!last) return { text: "" }
  let text = ""
  for (let index = assistants.length - 1; index >= 0 && !text; index--) {
    text = (assistants[index].content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim()
  }
  const failure = last.error?.message ?? (last.finish === "error" ? "model request failed" : undefined)
  return { text, ...(failure ? { error: failure } : {}) }
}

export function leafIds(run) {
  const used = new Set(run.nodes.flatMap((node) => node.dependsOn))
  return run.nodes.filter((node) => !used.has(node.id)).map((node) => node.id)
}

export function summarizeRun(run) {
  const counts = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0 }
  for (const node of run.nodes) counts[node.state] += 1
  return { total: run.nodes.length, ...counts }
}

function summaryLine(run) {
  const counts = summarizeRun(run)
  const parts = [`${counts.completed}/${counts.total} completed`]
  for (const state of ["running", "pending", "failed", "skipped", "cancelled"]) {
    if (counts[state]) parts.push(`${counts[state]} ${state}`)
  }
  return `DAG "${run.name}" (${run.id}): ${run.status}, ${parts.join(", ")}`
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ")

export function formatStatusTable(run, now = Date.now()) {
  const rows = run.nodes.map((node) => {
    const elapsed = node.startedAt === undefined ? "-" : formatElapsed((node.finishedAt ?? now) - node.startedAt)
    const deps = node.dependsOn.length ? node.dependsOn.join(", ") : "-"
    return `| ${cell(node.id)} | ${node.state}${node.attempt > 1 ? ` (attempt ${node.attempt})` : ""} | ${cell(node.agent ?? "-")} | ${elapsed} | ${cell(deps)} |`
  })
  const lines = [
    summaryLine(run),
    "",
    "| id | state | agent | elapsed | deps |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ]
  const problems = run.nodes.filter((node) => node.state === "failed" && node.error)
  if (problems.length) {
    lines.push("", ...problems.map((node) => `- ${node.id}: ${truncate(node.error, 200)}`))
  }
  return lines.join("\n")
}

export function formatLeafOutputs(run, texts = {}) {
  return leafIds(run)
    .map((id) => {
      const node = find(run, id)
      if (node.state !== "completed") return undefined
      const output = texts.outputs?.[id] ?? node.output ?? ""
      return `### ${id}\n${truncate(output, DEP_OUTPUT_LIMIT) || "(no output)"}`
    })
    .filter(Boolean)
    .join("\n\n")
}
