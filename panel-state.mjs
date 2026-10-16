// panel-state.mjs
// Pure decisions and run bookkeeping for the DAG panel. The terminal plugin
// wires these to the host; nothing here imports host or UI code.
import { layersOf } from "./layout.mjs"

export const MIN_SPLIT_WIDTH = 80
export const AUTO_CLOSE_GRACE_MS = 8000
export const MAX_KEPT_RUNS = 24

/** OpenCode forces fullscreen at or below 80 columns, so only wider terminals get a side panel. */
export function canSplit(width) {
  return Number.isFinite(width) && width > MIN_SPLIT_WIDTH
}

export function isNewerRevision(existing, incoming) {
  return !existing || incoming.revision > existing.revision
}

export function includesSession(run, sessionID) {
  return run.sessionID === sessionID || run.nodes.some((node) => node.sessionID === sessionID)
}

function newer(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  return a.id >= b.id ? a : b
}

export function newestRun(runs, sessionID) {
  let best
  for (const run of runs) {
    if (!includesSession(run, sessionID)) continue
    best = best ? newer(best, run) : run
  }
  return best
}

/** Runs that involve a session, as its origin or as one of its steps, newest first. */
export function runsOf(runs, sessionID) {
  return [...runs]
    .filter((run) => includesSession(run, sessionID))
    .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
}

/**
 * Pages the panel can show, in the order `[` and `]` step through them. Session is OpenCode's own
 * landing page (title, context, MCP) and Help is how to use the panel; both are always there. Graph
 * needs a run, and Runs needs two or more.
 */
export function availableViews(runCount) {
  const views = ["session"]
  if (runCount >= 1) views.push("graph")
  if (runCount >= 2) views.push("runs")
  views.push("help")
  return views
}

/** The user's pick while it is still available, else the first page, which is Session. */
export function resolveView(views, picked) {
  return views.includes(picked) ? picked : views[0]
}

/** Steps forward (1) or back (-1) through the views, wrapping around. */
export function cycleView(views, current, direction) {
  if (!views.length) return undefined
  const at = views.indexOf(current)
  if (at < 0) return views[0]
  return views[(at + direction + views.length) % views.length]
}

/** The run the graph shows: the one chosen in the Runs view while it still exists, else the newest. */
export function shownRun(runs, ui) {
  return runs.find((run) => run.id === ui?.shownRunId) ?? runs[0]
}

/**
 * What the focus key does. With the panel closed it opens it; with the panel open it moves the
 * cursor into the panel, or back to the session when the panel already has it.
 * @returns {"open" | "focus" | "leave"}
 */
export function focusAction({ shown, focused }) {
  if (!shown) return "open"
  return focused ? "leave" : "focus"
}

/**
 * The context window use OpenCode's own sidebar shows: the tokens of the latest assistant step after
 * the last completed compaction and before the revert boundary, as a count and, when the model is
 * known, a percent of its context limit.
 * @param {ReadonlyArray<any> | undefined} messages
 * @param {ReadonlyArray<any> | undefined} models
 * @param {string | undefined} boundary the message id a revert stopped at
 * @returns {{ tokens: number, percent: number | undefined } | undefined}
 */
export function contextUsage(messages, models, boundary) {
  if (!messages) return undefined
  const stop = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && stop === -1) return undefined
  const end = stop === -1 ? messages.length : stop
  const compaction = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  const step = messages.findLast(
    (message, index) => message.type === "assistant" && message.tokens !== undefined && index > compaction && index < end,
  )
  if (!step) return undefined
  const { input, output, reasoning, cache } = step.tokens
  const tokens = input + output + reasoning + cache.read + cache.write
  if (tokens <= 0) return undefined
  const model = models?.find((item) => item.providerID === step.model?.providerID && item.id === step.model?.id)
  const limit = model?.limit?.context
  return { tokens, percent: limit ? Math.round((tokens / limit) * 100) : undefined }
}

export function nodeForSession(run, sessionID) {
  return run?.nodes.find((node) => node.sessionID === sessionID)
}

/**
 * The key as the user presses it: the host's first formatted shortcut for `id`, or undefined when
 * the host has none, for example because a binding failed to parse. A key the host does not bind is
 * never shown.
 * @param {(id: string) => readonly string[] | undefined} shortcuts
 */
export function resolveKey(shortcuts, id) {
  return shortcuts(id)?.[0] || undefined
}

/**
 * Where "back to the origin session" should go from the session being viewed.
 * @returns {{ kind: "none" } | { kind: "here" } | { kind: "go", sessionID: string }}
 */
export function originTarget(run, sessionID) {
  if (!run || !sessionID) return { kind: "none" }
  if (run.sessionID === sessionID) return { kind: "here" }
  return nodeForSession(run, sessionID) ? { kind: "go", sessionID: run.sessionID } : { kind: "none" }
}

export function shouldAutoOpen({ runStatus, dismissed, width, isOriginSession, panelOpen = false }) {
  return runStatus === "running" && !dismissed && isOriginSession === true && !panelOpen && canSplit(width)
}

export function shouldAutoClose({ autoOpened, interacted, runStatus }) {
  return autoOpened === true && !interacted && runStatus !== undefined && runStatus !== "running"
}

export const canCancel = (run) => run?.status === "running"
export const canRetry = (run) => run !== undefined && run.status !== "running"

export function selectionOrder(run) {
  return layersOf(run?.nodes ?? []).flat().map((node) => node.id)
}

/**
 * Spatial move over the drawn graph. left/right step along the same row of boxes; up/down go to
 * the nearest box (by horizontal center) in the row above or below. At an edge the selection
 * stays put. In a single-column layout up/down are simply the previous/next node.
 * @param {{ ranges: Record<string, { start: number }>, centers: Record<string, number> } | undefined} layout
 * @param {string | undefined} currentId
 * @param {"up" | "down" | "left" | "right"} direction
 */
export function navigate(layout, currentId, direction) {
  const ranges = layout?.ranges ?? {}
  const centers = layout?.centers ?? {}
  const ids = Object.keys(ranges)
  if (!ids.length) return undefined
  const byPosition = (a, b) => ranges[a].start - ranges[b].start || (centers[a] ?? 0) - (centers[b] ?? 0)
  if (!currentId || !ranges[currentId]) return [...ids].sort(byPosition)[0]
  const here = ranges[currentId].start
  if (direction === "left" || direction === "right") {
    const row = ids.filter((id) => ranges[id].start === here).sort(byPosition)
    return row[row.indexOf(currentId) + (direction === "right" ? 1 : -1)] ?? currentId
  }
  const rows = [...new Set(ids.map((id) => ranges[id].start))].sort((a, b) => a - b)
  const target = rows[rows.indexOf(here) + (direction === "down" ? 1 : -1)]
  if (target === undefined) return currentId
  const x = centers[currentId] ?? 0
  return ids
    .filter((id) => ranges[id].start === target)
    .sort((a, b) => Math.abs((centers[a] ?? 0) - x) - Math.abs((centers[b] ?? 0) - x) || (centers[a] ?? 0) - (centers[b] ?? 0))[0]
}

export function moveSelection(run, currentId, delta) {
  const order = selectionOrder(run)
  if (!order.length) return undefined
  const index = order.indexOf(currentId)
  if (index < 0) return order[delta < 0 ? order.length - 1 : 0]
  return order[Math.min(order.length - 1, Math.max(0, index + delta))]
}

/** The viewed child session's node, else the first running node, else the first failure, else the first node. */
export function defaultSelection(run, viewedSessionID) {
  const nodes = layersOf(run?.nodes ?? []).flat()
  if (!nodes.length) return undefined
  const viewed = viewedSessionID ? nodes.find((node) => node.sessionID === viewedSessionID) : undefined
  return (
    viewed ??
    nodes.find((node) => node.state === "running") ??
    nodes.find((node) => node.state === "failed") ??
    nodes[0]
  ).id
}

/** A moved selection sticks to its run; a new run falls back to the default. */
export function resolveSelection(run, ui, viewedSessionID) {
  if (!run) return undefined
  if (ui.selectedRunId === run.id && run.nodes.some((node) => node.id === ui.selectedNodeId)) return ui.selectedNodeId
  return defaultSelection(run, viewedSessionID)
}

const EMPTY_UI = Object.freeze({
  dismissedRunId: undefined,
  opened: undefined,
  interacted: false,
  selectedRunId: undefined,
  selectedNodeId: undefined,
  view: undefined,
  shownRunId: undefined,
  runCursor: undefined,
  stepId: undefined,
})

/**
 * Plain run and per-session UI state with change notification. Runs are keyed
 * by id and only replaced by a higher revision, so events and snapshots that
 * arrive out of order cannot move a run backwards.
 */
export function createRunStore({ maxRuns = MAX_KEPT_RUNS } = {}) {
  const runs = new Map()
  const ui = new Map()
  const listeners = new Set()
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }

  function prune() {
    if (runs.size <= maxRuns) return
    const finished = [...runs.values()].filter((run) => run.status !== "running").sort((a, b) => a.createdAt - b.createdAt)
    for (const run of finished) {
      if (runs.size <= maxRuns) return
      runs.delete(run.id)
    }
  }

  return {
    ingest(run) {
      if (!isNewerRevision(runs.get(run.id), run)) return false
      runs.set(run.id, run)
      prune()
      emit()
      return true
    },
    all: () => [...runs.values()],
    newest: (sessionID) => newestRun(runs.values(), sessionID),
    ui: (sessionID) => ui.get(sessionID) ?? EMPTY_UI,
    patchUi(sessionID, patch, { silent = false } = {}) {
      const current = ui.get(sessionID) ?? EMPTY_UI
      if (Object.keys(patch).every((key) => current[key] === patch[key])) return false
      ui.set(sessionID, { ...current, ...patch })
      if (!silent) emit()
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      runs.clear()
      ui.clear()
    },
  }
}
