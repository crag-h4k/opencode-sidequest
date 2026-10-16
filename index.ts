// index.ts
import { Plugin } from "@opencode/plugin"
import type { Rpc } from "@opencode/plugin"
import { AgentDag } from "./rpc.ts"
import type { Run } from "./rpc.ts"
import * as DAG from "./dag.mjs"

type Context = Plugin.Context
type RunData = typeof Run.Type
type Texts = { prompts: Record<string, string>; outputs: Record<string, string> }
type Stored = { v: 1; run: RunData; texts: Texts }
type Json = Parameters<Context["storage"]["set"]>[1]
type SessionApi = Pick<Context["session"], "create" | "prompt" | "wait" | "context" | "interrupt" | "get" | "update">
type RpcContext = { error: (type: string, message: string, data?: unknown) => unknown }
type StreamEvent = { type: string; data?: { sessionID?: string; name?: string } }
type Spec = {
  name: string
  maxParallel: number
  nodes: Array<{ id: string; prompt: string; label: string; dependsOn: string[]; agent?: string; model?: string; timeout?: number; maxCost?: number; maxTokens?: number; retries?: number }>
}

// Budget overruns are never retried: running the step again would only spend more.
class FatalNodeError extends Error {}

// session.create wants a Model.Ref; the tool takes "provider/modelID[#variant]".
function toModelRef(ref: string) {
  const hash = ref.indexOf("#")
  const base = hash >= 0 ? ref.slice(0, hash) : ref
  const variant = hash >= 0 ? ref.slice(hash + 1) : undefined
  const slash = base.indexOf("/")
  return {
    providerID: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(variant ? { variant } : {}),
  } as Parameters<Context["session"]["create"]>[0] extends { model?: infer M } ? M : never
}

interface Live {
  run: RunData
  texts: Texts
  abort: AbortController
  waiters: Array<() => void>
  dirty: boolean
  writing?: Promise<void>
  emitTimer?: ReturnType<typeof setTimeout>
  lastEmit: number
  summarySig?: string
}

interface Deps {
  session: SessionApi
  storage: Context["storage"]
  emit: (sessionID: string, run: RunData) => Promise<void>
  onActive?: (active: boolean) => void
  now?: () => number
  emitIntervalMs?: number
  guardIntervalMs?: number
  log?: (message: string, error?: unknown) => void
}

const MAX_ACTIVE_PER_SESSION = 3
const INTERRUPT_TIMEOUT_MS = 5000
const STORAGE_PREFIX = "run/"

function createController(deps: Deps) {
  const { session, storage } = deps
  const now = deps.now ?? (() => Date.now())
  const interval = deps.emitIntervalMs ?? 50
  const guardInterval = deps.guardIntervalMs ?? 2000
  const log = deps.log ?? ((message: string, error?: unknown) => console.error(`sidequest: ${message}`, error ?? ""))
  const runs = new Map<string, Live>()
  const lastTool = new Map<string, string>()
  const originQueues = new Map<string, Promise<void>>()
  let disposed = false
  let active = false
  let lastStamp = 0

  // Strictly increasing so "newest run" and eviction stay deterministic for runs started in the same millisecond.
  const stamp = () => (lastStamp = Math.max(now(), lastStamp + 1))
  const storageKey = (id: string) => `${STORAGE_PREFIX}${id}`
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

  function writeSoon(live: Live): Promise<void> {
    live.dirty = true
    if (live.writing) return live.writing
    live.writing = (async () => {
      try {
        while (live.dirty) {
          live.dirty = false
          try {
            await storage.set(storageKey(live.run.id), { v: 1, run: live.run, texts: live.texts } as Json)
          } catch (error) {
            log(`failed to persist run ${live.run.id}`, error)
          }
        }
      } finally {
        live.writing = undefined
      }
    })()
    return live.writing
  }

  function sendEmit(live: Live) {
    live.lastEmit = now()
    return deps.emit(live.run.sessionID, live.run).catch((error) => log(`failed to emit run ${live.run.id}`, error))
  }

  function scheduleEmit(live: Live, final: boolean) {
    if (final) {
      if (live.emitTimer) clearTimeout(live.emitTimer)
      live.emitTimer = undefined
      void sendEmit(live)
      return
    }
    if (live.emitTimer) return
    const delay = live.lastEmit + interval - now()
    if (delay <= 0) {
      void sendEmit(live)
      return
    }
    const timer = setTimeout(() => {
      live.emitTimer = undefined
      void sendEmit(live)
    }, delay)
    timer.unref?.()
    live.emitTimer = timer
  }

  function updateActive() {
    const next = [...runs.values()].some((live) => live.run.status === "running")
    if (next === active) return
    active = next
    deps.onActive?.(next)
  }

  // Session metadata updates replace the whole record, so merge into the current value.
  function syncSummary(live: Live) {
    const counts = DAG.summarizeRun(live.run)
    const signature = `${live.run.id}:${live.run.status}:${counts.completed}:${counts.total}`
    if (live.summarySig === signature) return
    live.summarySig = signature
    const sessionID = live.run.sessionID
    const summary = {
      runId: live.run.id,
      status: live.run.status,
      done: counts.completed,
      total: counts.total,
      updatedAt: live.run.updatedAt,
    }
    const previous = originQueues.get(sessionID) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const info = await session.get({ sessionID })
        await session.update({ sessionID, metadata: { ...(info.metadata ?? {}), dag: summary } })
      })
      .catch((error) => log(`failed to update summary for ${sessionID}`, error))
    originQueues.set(sessionID, next)
    void next.finally(() => {
      if (originQueues.get(sessionID) === next) originQueues.delete(sessionID)
    })
  }

  function commit(live: Live, next: RunData, options: { persist?: boolean } = {}) {
    if (disposed || next === live.run) return
    const previous = live.run
    live.run = next
    if (options.persist !== false) void writeSoon(live)
    const finished = previous.status === "running" && next.status !== "running"
    scheduleEmit(live, finished)
    syncSummary(live)
    if (!finished) return
    const waiters = live.waiters.splice(0)
    for (const resolve of waiters) resolve()
    updateActive()
  }

  function nodeOf(run: RunData, id: string) {
    return run.nodes.find((node) => node.id === id)
  }

  function isCurrent(live: Live, id: string, attempt: number) {
    const node = nodeOf(live.run, id)
    return live.run.status === "running" && node?.state === "running" && node.attempt === attempt
  }

  function interruptQuietly(sessionID: string) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, INTERRUPT_TIMEOUT_MS)
      timer.unref?.()
    })
    return Promise.race([
      session.interrupt({ sessionID }).then(
        () => undefined,
        (error) => log(`failed to interrupt ${sessionID}`, error),
      ),
      timeout,
    ]).finally(() => clearTimeout(timer))
  }

  async function runNode(live: Live, id: string, attempt: number, prompt: string) {
    const signal = live.abort.signal
    let sessionID: string | undefined
    try {
      const run = live.run
      const node = nodeOf(run, id)
      if (!node) return
      const model = node.model ? toModelRef(node.model) : undefined
      const created = await session.create(
        {
          parentID: run.sessionID,
          ...(node.agent ? { agent: node.agent } : {}),
          ...(model ? { model } : {}),
          title: `dag ${run.name}: ${node.label}`,
          metadata: { dag: { runId: run.id, nodeId: id } },
        },
        { signal },
      )
      sessionID = created.id
      if (!isCurrent(live, id, attempt)) {
        await interruptQuietly(sessionID)
        return
      }
      commit(live, DAG.attachSession(live.run, id, attempt, sessionID, now()) as RunData)
      // session.wait takes no signal a per-node guard can trip, and interrupting the child
      // does not unblock a wedged model request. So race prompt+wait against each guard
      // (deadline, budget poll) and treat whichever loses the race as the node's failure.
      let tripped = false
      const guards: Array<Promise<never>> = []
      const stops: Array<() => void> = []
      const trip = (reject: (error: Error) => void, reason: string, fatal = false) => {
        tripped = true
        reject(fatal ? new FatalNodeError(reason) : new Error(reason))
      }
      const timeout = node.timeout
      if (timeout !== undefined) {
        guards.push(
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => trip(reject, `timed out after ${timeout}s`), timeout * 1000)
            timer.unref?.()
            stops.push(() => clearTimeout(timer))
          }),
        )
      }
      const limits = { maxCost: node.maxCost, maxTokens: node.maxTokens }
      if (limits.maxCost !== undefined || limits.maxTokens !== undefined) {
        const watched = sessionID
        guards.push(
          new Promise<never>((_, reject) => {
            let inflight = false
            const poll = setInterval(() => {
              if (inflight) return
              inflight = true
              session
                .get({ sessionID: watched })
                .then((info) => {
                  const over = DAG.budgetViolation(info, limits)
                  if (over) trip(reject, over, true)
                })
                .catch(() => {})
                .finally(() => {
                  inflight = false
                })
            }, guardInterval)
            poll.unref?.()
            stops.push(() => clearInterval(poll))
          }),
        )
      }
      const work = (async () => {
        await session.prompt({ sessionID, text: prompt }, { signal })
        await session.wait({ sessionID }, { signal })
      })()
      try {
        await Promise.race([work, ...guards])
      } catch (error) {
        if (tripped) void interruptQuietly(sessionID)
        work.catch(() => {})
        throw error
      } finally {
        for (const stop of stops) stop()
      }
      if (!isCurrent(live, id, attempt)) return

      const [info, messages] = await Promise.all([
        session.get({ sessionID }, { signal }),
        session.context({ sessionID }, { signal }),
      ])
      const result = DAG.lastAssistantResult(messages as readonly unknown[])
      if (info.outcome === "failed" || info.outcome === "interrupted" || result.error) {
        throw new Error(result.error ?? `child session ${info.outcome}`)
      }
      if (!result.text) throw new Error("child session produced no assistant text")
      const over = DAG.budgetViolation(info, limits)
      if (over) throw new FatalNodeError(over)

      if (!isCurrent(live, id, attempt)) return
      live.texts.outputs[id] = DAG.truncate(result.text, DAG.DEP_OUTPUT_LIMIT)
      commit(live, DAG.completeNode(live.run, id, attempt, result.text, now()) as RunData)
    } catch (error) {
      if (!isCurrent(live, id, attempt)) return
      const reason = message(error)
      const requeued =
        error instanceof FatalNodeError ? undefined : (DAG.requeueNode(live.run, id, attempt, reason, now()) as RunData | undefined)
      commit(live, requeued ?? (DAG.failNode(live.run, id, attempt, reason, now()) as RunData))
    } finally {
      if (sessionID) lastTool.delete(sessionID)
      pump(live)
    }
  }

  function pump(live: Live) {
    if (disposed) return
    for (let guard = 0; live.run.status === "running" && guard < 100; guard++) {
      const ready = DAG.readyNodes(live.run)
      if (!ready.length) {
        const settled = DAG.failStuck(live.run, now()) as RunData
        if (settled === live.run) break
        commit(live, settled)
        continue
      }
      for (const id of ready) {
        const prompt = DAG.buildNodePrompt(live.run, id, live.texts) as string
        commit(live, DAG.startNode(live.run, id, { prompt, now: now() }) as RunData)
        const node = nodeOf(live.run, id)
        if (node?.state !== "running") continue
        void runNode(live, id, node.attempt, prompt).catch((error) => log(`node ${id} crashed`, error))
      }
    }
  }

  function track(run: RunData, texts: Texts) {
    const live: Live = { run, texts, abort: new AbortController(), waiters: [], dirty: false, lastEmit: 0 }
    runs.set(run.id, live)
    return live
  }

  async function evict() {
    const doomed = DAG.selectEvictions([...runs.values()].map((live) => live.run)) as string[]
    for (const id of doomed) {
      runs.delete(id)
      await storage.remove(storageKey(id)).catch((error) => log(`failed to remove run ${id}`, error))
    }
  }

  async function load() {
    let after: string | undefined
    for (;;) {
      const page = await storage.scan({ prefix: STORAGE_PREFIX, ...(after ? { after } : {}), limit: 100 })
      for (const entry of page.entries) {
        const stored = entry.value as Stored | null
        if (stored?.v !== 1 || !Array.isArray(stored.run?.nodes)) continue
        const texts = { prompts: stored.texts?.prompts ?? {}, outputs: stored.texts?.outputs ?? {} }
        const recovered = DAG.recoverRun(stored.run, now()) as RunData
        const live = track(recovered, texts)
        if (recovered !== stored.run) await writeSoon(live)
      }
      if (!page.next) break
      after = page.next
    }
    await evict()
  }

  function start(spec: Spec, sessionID: string) {
    const id = `dag-${crypto.randomUUID().slice(0, 8)}`
    const run = DAG.createRun(spec, { id, sessionID, now: stamp() }) as RunData
    const prompts: Record<string, string> = {}
    for (const node of spec.nodes) prompts[node.id] = node.prompt
    const live = track(run, { prompts, outputs: {} })
    void writeSoon(live)
    scheduleEmit(live, false)
    syncSummary(live)
    updateActive()
    pump(live)
    void evict()
    return id
  }

  async function cancel(runId: string) {
    const live = runs.get(runId)
    if (!live) return undefined
    if (live.run.status !== "running") return live.run
    const children = live.run.nodes
      .filter((node) => node.state === "running" && node.sessionID)
      .map((node) => node.sessionID as string)
    commit(live, DAG.cancelRun(live.run, now()) as RunData)
    live.abort.abort()
    await Promise.all(children.map(interruptQuietly))
    return live.run
  }

  function retry(runId: string) {
    const live = runs.get(runId)
    if (!live) return { status: "not_found" as const }
    const result = DAG.retryRun(live.run, now())
    if (!result.ok) return { status: "running" as const, run: live.run }
    if (!result.changed) return { status: "ok" as const, run: live.run, changed: false }
    const next = result.run as RunData
    for (const node of next.nodes) if (node.state !== "completed") delete live.texts.outputs[node.id]
    live.abort = new AbortController()
    commit(live, next)
    updateActive()
    pump(live)
    return { status: "ok" as const, run: live.run, changed: true }
  }

  function finished(runId: string) {
    const live = runs.get(runId)
    if (live?.run.status !== "running") return Promise.resolve()
    return new Promise<void>((resolve) => live.waiters.push(resolve))
  }

  async function waitFor(runId: string, signal: AbortSignal) {
    const onAbort = () => void cancel(runId)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    try {
      await finished(runId)
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    await runs.get(runId)?.writing
  }

  function view(runId: string) {
    const live = runs.get(runId)
    return live ? { run: live.run, texts: live.texts } : undefined
  }

  function newestFor(sessionID: string) {
    return [...runs.values()]
      .map((live) => live.run)
      .filter((run) => run.sessionID === sessionID)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))[0]
  }

  function snapshot(sessionID: string) {
    return [...runs.values()]
      .map((live) => live.run)
      .filter((run) => run.sessionID === sessionID || run.nodes.some((node) => node.sessionID === sessionID))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, DAG.RETAINED_RUNS)
  }

  function isNodeSession(sessionID: string) {
    return [...runs.values()].some((live) => live.run.nodes.some((node) => node.sessionID === sessionID))
  }

  function activeCount(sessionID: string) {
    return [...runs.values()].filter((live) => live.run.sessionID === sessionID && live.run.status === "running").length
  }

  function noteActivity(sessionID: string | undefined, activity: string | undefined) {
    if (!sessionID) return
    for (const live of runs.values()) {
      if (live.run.status !== "running") continue
      const node = live.run.nodes.find((item) => item.state === "running" && item.sessionID === sessionID)
      if (node) commit(live, DAG.setActivity(live.run, node.id, node.attempt, activity, now()) as RunData, { persist: false })
    }
  }

  function handleEvent(event: StreamEvent) {
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    switch (event.type) {
      case "session.tool.input.started": {
        const tool = `tool: ${event.data?.name}`
        lastTool.set(sessionID, tool)
        noteActivity(sessionID, tool)
        break
      }
      case "permission.asked":
        noteActivity(sessionID, "waiting on permission")
        break
      case "permission.replied":
        noteActivity(sessionID, lastTool.get(sessionID))
        break
      case "session.tool.success":
      case "session.tool.failed":
        lastTool.delete(sessionID)
        noteActivity(sessionID, undefined)
        break
    }
  }

  // Interrupted children are not adopted again: the next load marks the run failed.
  async function dispose() {
    disposed = true
    const children: string[] = []
    for (const live of runs.values()) {
      if (live.emitTimer) clearTimeout(live.emitTimer)
      for (const resolve of live.waiters.splice(0)) resolve()
      if (live.run.status !== "running") continue
      live.abort.abort()
      for (const node of live.run.nodes) if (node.state === "running" && node.sessionID) children.push(node.sessionID)
    }
    await Promise.all(children.map(interruptQuietly))
    await Promise.all([...runs.values()].map((live) => live.writing))
  }

  return { load, start, cancel, retry, waitFor, view, newestFor, snapshot, isNodeSession, activeCount, handleEvent, dispose }
}

const NODE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$", description: "Unique step id, lowercase letters, digits, - and _" },
    prompt: { type: "string", description: "Instructions for this step. Outputs of its dependencies are appended automatically." },
    agent: { type: "string", description: "Agent to run this step. Defaults to the session default." },
    model: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$", description: "Model to run this step, as provider/modelID (for example github-copilot/gpt-6-luna). When omitted the host picks its own default for new sessions, which is NOT necessarily this session's model and may be a slow free model. Set it explicitly." },
    timeout: { type: "integer", minimum: 1, maximum: 3600, description: "Seconds before this step is failed and its child session interrupted. No limit when omitted." },
    maxCost: { type: "number", minimum: 0, exclusiveMinimum: true, description: "USD ceiling for this step, checked while it runs. Free or unpriced models report a cost of 0, so use maxTokens to bound those. No limit when omitted." },
    maxTokens: { type: "integer", minimum: 1, description: "Ceiling on total tokens for this step: input, cached input, output and reasoning, checked while it runs. Each child session starts with about 23,000 tokens of instructions and tool definitions, so set it well above that. No limit when omitted." },
    retries: { type: "integer", minimum: 0, maximum: 3, description: "Automatic retries after a failure or timeout, 0 to 3, default 0. A step that exceeds its maxTokens or maxCost is never retried. A run also stops retrying after 6 retries in total." },
    label: { type: "string", description: "Short display name. Defaults to the id." },
    depends_on: { type: "array", items: { type: "string" }, description: "Ids of steps that must complete first." },
  },
  required: ["id", "prompt"],
}

const RUN_ID_SCHEMA = {
  type: "object",
  properties: { runId: { type: "string", description: "DAG run id. Defaults to the newest run in this session." } },
}

const START_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short name for the run. Defaults to dag." },
    maxParallel: { type: "integer", minimum: 1, maximum: DAG.MAX_PARALLEL, description: "Most steps running at once. Defaults to 3." },
    wait: { type: "boolean", description: "Block until the run ends. Defaults to true." },
    nodes: { type: "array", minItems: 1, maxItems: DAG.MAX_NODES, items: NODE_SCHEMA },
  },
  required: ["nodes"],
}

const RETRY_SCHEMA = {
  type: "object",
  properties: {
    runId: RUN_ID_SCHEMA.properties.runId,
    wait: { type: "boolean", description: "Block until the run ends. Defaults to true." },
  },
}

const text = (content: string, metadata?: Record<string, unknown>) => ({ content, ...(metadata ? { metadata } : {}) })

export default Plugin.define({
  id: "sidequest",
  async setup(ctx) {
    let events: { emit: (name: "updated", data: { sessionID: string; run: RunData }) => Promise<void> } | undefined
    let stream: AbortController | undefined

    const controller = createController({
      session: ctx.session,
      storage: ctx.storage,
      guardIntervalMs: (ctx.options as { guardIntervalMs?: number } | undefined)?.guardIntervalMs,
      emit: async (sessionID, run) => {
        await events?.emit("updated", { sessionID, run })
      },
      onActive: (active) => {
        stream?.abort()
        stream = undefined
        if (!active) return
        const current = new AbortController()
        stream = current
        void (async () => {
          for await (const event of ctx.event.subscribe({ signal: current.signal })) {
            controller.handleEvent(event as unknown as StreamEvent)
          }
        })().catch((error) => {
          if (!current.signal.aborted) console.error("sidequest: event stream ended", error)
        })
      },
    })

    await controller.load()

    // The Promise API types only accept portable schemas; the host also accepts the Effect Schemas in rpc.ts.
    const handlers = {
      snapshot: async ({ sessionID }: { sessionID: string }) => ({ runs: controller.snapshot(sessionID) }),
      cancel: async ({ runId }: { runId: string }) => {
        const run = await controller.cancel(runId)
        return run ? { run } : {}
      },
      retry: async ({ runId }: { runId: string }, context: RpcContext) => {
        const result = controller.retry(runId)
        if (result.status === "running") return context.error("not_finished", `Run ${runId} is still running`, { runId })
        return result.status === "ok" ? { run: result.run } : {}
      },
    }
    const registration = await ctx.rpc.register(AgentDag as unknown as Rpc.PortableDefinition, handlers as never)
    events = registration.events

    const resolve = (runId: unknown, sessionID: string) => {
      const run = typeof runId === "string" && runId ? controller.view(runId)?.run : controller.newestFor(sessionID)
      return run ? controller.view(run.id) : undefined
    }

    const report = (runId: string, extra?: string) => {
      const found = controller.view(runId)
      if (!found) return text(`Unknown DAG run ${runId}.`)
      const parts = [DAG.formatStatusTable(found.run, Date.now())]
      if (extra) parts.unshift(extra)
      const outputs = found.run.status === "running" ? "" : DAG.formatLeafOutputs(found.run, found.texts)
      if (outputs) parts.push(`## Final outputs\n\n${outputs}`)
      if (found.run.status === "failed") parts.push("Use dag_retry to re-run the failed steps; completed steps keep their output.")
      return text(parts.join("\n\n"), { dag: { runId, status: found.run.status } })
    }

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "dag_start",
        description:
          "Run a dependency graph (DAG) of sub-agent steps, each in its own child session, with independent steps in parallel. " +
          "Use this only when the user explicitly asks for a DAG or a parallel multi-agent pipeline. " +
          "Never use it for ordinary planning, coding, review or documentation requests. " +
          "Each step has a unique id, a prompt, an optional agent and optional depends_on ids; a step starts when all its dependencies complete and receives their outputs. " +
          `Up to ${DAG.MAX_NODES} steps. With wait true (default) the call blocks until the run ends and returns a status table plus each leaf step's output; with wait false it returns the run id at once and dag_status shows progress.`,
        input: START_SCHEMA,
        execute: async (input, context) => {
          const checked = DAG.validateSpec(input) as { ok: true; spec: Spec } | { ok: false; errors: string[] }
          if (!checked.ok) return text(`Invalid DAG spec:\n${checked.errors.map((error) => `- ${error}`).join("\n")}`)
          const sessionID = String(context.sessionID)
          if (controller.isNodeSession(sessionID)) return text("dag_start cannot be used from inside a DAG step.")
          if (controller.activeCount(sessionID) >= MAX_ACTIVE_PER_SESSION) {
            return text(`This session already has ${MAX_ACTIVE_PER_SESSION} DAG runs in progress. Wait for one to finish or cancel it.`)
          }
          if (context.signal.aborted) return text("DAG run not started: the call was aborted.")
          const runId = controller.start(checked.spec, sessionID)
          if ((input as { wait?: unknown }).wait === false) {
            return report(runId, `Started DAG run ${runId}. It runs in the background; use dag_status to check it.`)
          }
          await controller.waitFor(runId, context.signal)
          return report(runId)
        },
      })
      editor.add({
        name: "dag_status",
        description: "Show the status table of a DAG run, defaulting to the newest run in this session.",
        input: RUN_ID_SCHEMA,
        execute: async (input, context) => {
          const found = resolve((input as { runId?: unknown }).runId, String(context.sessionID))
          return found ? report(found.run.id) : text("No DAG run found.")
        },
      })
      editor.add({
        name: "dag_cancel",
        description: "Cancel a running DAG run, defaulting to the newest run in this session. Running steps are interrupted.",
        input: RUN_ID_SCHEMA,
        execute: async (input, context) => {
          const found = resolve((input as { runId?: unknown }).runId, String(context.sessionID))
          if (!found) return text("No DAG run found.")
          await controller.cancel(found.run.id)
          return report(found.run.id)
        },
      })
      editor.add({
        name: "dag_retry",
        description:
          "Re-run the failed, skipped and cancelled steps of a finished DAG run, defaulting to the newest run in this session. Completed steps keep their output.",
        input: RETRY_SCHEMA,
        execute: async (input, context) => {
          const found = resolve((input as { runId?: unknown }).runId, String(context.sessionID))
          if (!found) return text("No DAG run found.")
          const result = controller.retry(found.run.id)
          if (result.status === "running") return report(found.run.id, "This run is still running; retry only applies to finished runs.")
          if (result.status === "ok" && !result.changed) return report(found.run.id, "Nothing to retry: every step completed.")
          if ((input as { wait?: unknown }).wait !== false) await controller.waitFor(found.run.id, context.signal)
          return report(found.run.id)
        },
      })
    })

    return async () => {
      stream?.abort()
      await tools.dispose()
      await registration.dispose()
      await controller.dispose()
    }
  },
})
