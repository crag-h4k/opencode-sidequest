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

export function nodeForSession(run, sessionID) {
  return run?.nodes.find((node) => node.sessionID === sessionID)
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
