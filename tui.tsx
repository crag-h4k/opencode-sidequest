/** @jsxImportSource @opentui/solid */
// tui.tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, untrack } from "solid-js"
import {
  graphLayout,
  renderDetail,
  renderEdges,
  renderHeader,
  renderHelp,
  renderHints,
  renderRuns,
  renderSessionPage,
  renderStepHeader,
  renderStrip,
  renderTranscript,
  renderViewTabs,
} from "./layout.mjs"
import {
  AUTO_CLOSE_GRACE_MS,
  availableViews,
  canCancel,
  canRetry,
  contextUsage,
  createRunStore,
  cycleView,
  focusAction,
  navigate,
  originTarget,
  resolveKey as resolveHostKey,
  resolveSelection,
  resolveView,
  runsOf,
  shouldAutoClose,
  shouldAutoOpen,
  shownRun,
} from "./panel-state.mjs"
import { AgentDag, type Run } from "./rpc.ts"

type Direction = "up" | "down" | "left" | "right"
type DagRun = typeof Run.Type
type Segment = { text: string; role: string; bold?: boolean }
type Line = Segment[]
type Controller = ReturnType<typeof createController>
type Toast = "info" | "success" | "warning" | "error"
type CallOptions = { location?: { directory: string } }
type View = "session" | "graph" | "runs" | "help"

// Effect schemas satisfy the runtime client but not the SDK's Portable* types, so the client shape is stated here.
type DagRpc = {
  snapshot: (input: { sessionID: string }, options?: CallOptions) => Promise<{ runs: readonly DagRun[] }>
  cancel: (input: { runId: string }, options?: CallOptions) => Promise<{ run?: DagRun }>
  retry: (input: { runId: string }, options?: CallOptions) => Promise<{ run?: DagRun }>
  events: { on: (name: "updated", handler: (event: { data: { sessionID: string; run: DagRun } }) => void) => () => void }
}

const PANEL = "sidequest.dag"
const PANEL_TOGGLE = "sidequest.panel.toggle"
const FOCUS = "sidequest.dag.focus"
const GRAPH = "sidequest.dag.toggle"
const ORIGIN = "sidequest.dag.origin"
// OpenCode's own commands worth remembering next to the panel, listed on the help page with whatever
// keys the user has bound.
const HOST_COMMANDS = [
  ["session.tab.previous", "previous session tab"],
  ["session.tab.next", "next session tab"],
  ["session.first", "go to the first message"],
] as const

function resolveKey(context: Context, id: string): string | undefined {
  return resolveHostKey((key) => context.keymap.shortcuts(key), id)
}

// Keys come from the host's formatted shortcuts, so a binding the host did not register is simply absent.
function panelKeys(context: Context) {
  return { toggle: resolveKey(context, PANEL_TOGGLE), focus: resolveKey(context, FOCUS), origin: resolveKey(context, ORIGIN) }
}

// Only commands the host actually has a key for; there is no fallback for a key it does not bind.
function hostKeys(context: Context): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [id, label] of HOST_COMMANDS) {
    const key = context.keymap.shortcuts(id)[0]
    if (key) entries.push([key, label])
  }
  return entries
}

// How to get back to a DAG's origin session: the origin key, else the slash command.
function originCue(context: Context): string {
  const key = resolveKey(context, ORIGIN)
  return key ? `${key} origin` : "/dag-origin"
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const { type, message } = error as { type?: unknown; message?: unknown }
    if (typeof message === "string") return typeof type === "string" ? `${type}: ${message}` : message
    if (typeof type === "string") return type
  }
  return "unknown error"
}

function roleColor(theme: Context["theme"], role: string) {
  switch (role) {
    case "muted":
      return theme.text.muted
    case "info":
      return theme.text.feedback.info.base
    case "success":
      return theme.text.feedback.success.base
    case "error":
      return theme.text.feedback.error.base
    case "warning":
      return theme.text.feedback.warning.base
    case "selected":
      return theme.text.action.primary.selected
    case "accent":
      return theme.hue.accent[500]
    default:
      return theme.text.base
  }
}

function createController(context: Context) {
  const store = createRunStore()
  const [version, setVersion] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [panelFocused, setPanelFocused] = createSignal(false)
  let panelHandle: PanelInput | undefined
  const stopStore = store.subscribe(() => setVersion((value) => value + 1))
  const rpc = context.client.rpc(AgentDag as never) as unknown as DagRpc
  let disposed = false
  let warned = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let expectedClose: string | undefined
  // A panel the user opened by hand moves with them to the next session; OpenCode closes a panel
  // whenever the route changes, so it is opened again there.
  let follow = false
  let stopEvents = () => {}

  const routed = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const openFor = (sessionID: string | undefined) => {
    const current = context.ui.panel.current()
    return current?.name === PANEL && current.sessionID === sessionID
  }

  const callOptions = (sessionID: string): CallOptions => {
    const location = context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
    return location?.directory ? { location: { directory: location.directory } } : {}
  }

  const toast = (message: string, variant: Toast = "info") =>
    context.ui.toast.show({ title: "Agent DAG", message, variant })

  function fail(error: unknown) {
    if (disposed || warned) return
    warned = true
    toast(`Unavailable: ${describe(error)}`, "warning")
  }

  async function refresh(sessionID: string) {
    if (disposed) return
    try {
      const result = await rpc.snapshot({ sessionID }, callOptions(sessionID))
      if (disposed) return
      warned = false
      for (const run of result.runs) store.ingest(run)
    } catch (error) {
      fail(error)
    }
  }

  try {
    stopEvents = rpc.events.on("updated", (event) => {
      store.ingest(event.data.run)
    })
  } catch (error) {
    fail(error)
  }

  // The event stream opens with server.connected, so this also fires on every reconnect.
  const stopConnected = context.data.on("server.connected", () => {
    const sessionID = routed()
    if (sessionID) void refresh(sessionID)
  })

  function openPanel(sessionID: string, source: "auto" | "manual", landing: { view?: string; shownRunId?: string } = {}) {
    // The panel reads this at mount, which happens inside open(), so set it first and skip the notify.
    store.patchUi(sessionID, { opened: source, interacted: false, ...landing }, { silent: true })
    if (context.ui.panel.open(PANEL)) return true
    store.patchUi(sessionID, { opened: undefined }, { silent: true })
    return false
  }

  function closePanel() {
    const current = context.ui.panel.current()
    if (current?.name !== PANEL) return
    expectedClose = current.sessionID
    context.ui.panel.close()
  }

  function dismiss(sessionID: string) {
    store.patchUi(sessionID, { dismissedRunId: store.newest(sessionID)?.id })
  }

  function closeByUser(sessionID: string) {
    follow = false
    dismiss(sessionID)
    closePanel()
  }

  // A close we did not ask for (terminal pane, sidebar, another panel, the host) counts as a dismissal,
  // unless the route moved away, which is how the host closes a panel on navigation.
  function onPanelChange(
    current: { name: string; sessionID: string } | undefined,
    previous: { name: string; sessionID: string } | undefined,
  ) {
    if (previous?.name !== PANEL) return
    if (current?.name === PANEL && current.sessionID === previous.sessionID) return
    store.patchUi(previous.sessionID, { opened: undefined, interacted: false })
    if (expectedClose === previous.sessionID) {
      expectedClose = undefined
      return
    }
    if (routed() === previous.sessionID) {
      follow = false
      dismiss(previous.sessionID)
    }
  }

  // After a route change OpenCode has closed the panel; bring it to the new session if it was following.
  function followRoute(sessionID: string | undefined) {
    if (!follow || !sessionID) return
    setTimeout(() => {
      if (disposed || !follow || routed() !== sessionID || openFor(sessionID)) return
      openPanel(sessionID, "manual")
    }, 0)
  }

  // Lands on the graph when a run is going, otherwise on whatever page was used last.
  function landingFor(sessionID: string) {
    return store.newest(sessionID)?.status === "running" ? { view: "graph", shownRunId: undefined } : {}
  }

  // Opens the panel, or closes it.
  async function toggle() {
    const sessionID = routed()
    if (!sessionID) {
      toast("Open a session first")
      return
    }
    if (openFor(sessionID)) {
      closeByUser(sessionID)
      return
    }
    if (!store.newest(sessionID)) await refresh(sessionID)
    if (routed() !== sessionID) return
    follow = true
    openPanel(sessionID, "manual", landingFor(sessionID))
  }

  // /dag: the newest graph, with the cursor in the panel.
  async function openGraph() {
    const sessionID = routed()
    if (!sessionID) {
      toast("Open a session first")
      return
    }
    if (!store.newest(sessionID)) await refresh(sessionID)
    if (routed() !== sessionID) return
    const landing = store.newest(sessionID) ? { view: "graph", shownRunId: undefined } : {}
    follow = true
    if (openFor(sessionID)) {
      store.patchUi(sessionID, { ...landing, interacted: true })
      if (panelHandle) panelHandle.focus()
      return
    }
    openPanel(sessionID, "manual", landing)
  }

  // The focus key: open the panel, or move the cursor between the panel and the session.
  async function flip() {
    const sessionID = routed()
    if (!sessionID) {
      toast("Open a session first")
      return
    }
    const action = focusAction({ shown: openFor(sessionID), focused: panelFocused() })
    if (action === "open") await toggle()
    else if (action === "leave") context.keymap.dispatch("pane.focus.left")
    else if (panelHandle) panelHandle.focus()
    else context.keymap.dispatch("pane.focus.right")
  }

  // Steps through the panel's pages.
  function cycle(direction: 1 | -1) {
    const sessionID = routed()
    if (!sessionID || !openFor(sessionID)) return
    const views = availableViews(runsOf(store.all(), sessionID).length)
    const next = cycleView(views, resolveView(views, store.ui(sessionID).view), direction)
    store.patchUi(sessionID, { view: next, stepId: undefined, interacted: true })
  }

  // From a step's session, return to the session that started the DAG.
  function backToOrigin() {
    const sessionID = routed()
    const target = originTarget(sessionID ? store.newest(sessionID) : undefined, sessionID)
    if (target.kind === "go") {
      context.ui.router.navigate({ type: "session", sessionID: target.sessionID })
      return
    }
    toast(target.kind === "here" ? "Already in the session that started this DAG" : "This session is not a DAG step")
  }

  function touch(sessionID: string) {
    if (!store.ui(sessionID).interacted) store.patchUi(sessionID, { interacted: true })
  }

  function select(sessionID: string, run: DagRun, nodeID: string | undefined) {
    if (nodeID === undefined) return
    store.patchUi(sessionID, { selectedRunId: run.id, selectedNodeId: nodeID, interacted: true })
  }

  async function act(kind: "cancel" | "retry", run: DagRun) {
    try {
      const options = callOptions(run.sessionID)
      const result =
        kind === "cancel" ? await rpc.cancel({ runId: run.id }, options) : await rpc.retry({ runId: run.id }, options)
      if (result.run) store.ingest(result.run)
      toast(kind === "cancel" ? "Cancelling run" : "Retrying run", "success")
    } catch (error) {
      toast(`${kind === "cancel" ? "Cancel" : "Retry"} failed: ${describe(error)}`, "error")
    }
  }

  function cancelClose() {
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = undefined
  }

  function scheduleClose(sessionID: string) {
    if (graceTimer) return
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      if (disposed || routed() !== sessionID || !openFor(sessionID)) return
      const ui = store.ui(sessionID)
      const autoOpened = ui.opened === "auto"
      if (shouldAutoClose({ autoOpened, interacted: ui.interacted, runStatus: store.newest(sessionID)?.status })) closePanel()
    }, AUTO_CLOSE_GRACE_MS)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    cancelClose()
    stopEvents()
    stopConnected()
    stopStore()
    store.dispose()
  }

  return {
    store,
    version,
    now,
    tick: () => setNow(Date.now()),
    routed,
    openFor,
    refresh,
    openPanel,
    closePanel,
    closeByUser,
    onPanelChange,
    followRoute,
    toggle,
    openGraph,
    flip,
    cycle,
    backToOrigin,
    panelFocused,
    setPanelFocused,
    attach: (panel: PanelInput | undefined) => {
      panelHandle = panel
    },
    touch,
    select,
    act,
    toast,
    scheduleClose,
    cancelClose,
    dispose,
  }
}

function Spans(props: { segments: Line }) {
  const context = usePlugin()
  return (
    <For each={props.segments}>
      {(segment) => (
        <span style={{ fg: roleColor(context.theme, segment.role), attributes: segment.bold ? TextAttributes.BOLD : undefined }}>
          {segment.text}
        </span>
      )}
    </For>
  )
}

function Row(props: { line: Line }) {
  return (
    <Show when={props.line.length > 0} fallback={<text>{" "}</text>}>
      <text wrapMode="none" flexShrink={0}>
        <Spans segments={props.line} />
      </text>
    </Show>
  )
}

function Lines(props: { lines: Line[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.lines}>{(line) => <Row line={line} />}</For>
    </box>
  )
}

function Host(props: { ctl: Controller }) {
  const context = usePlugin()
  const ctl = props.ctl
  const dims = useTerminalDimensions()

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: PANEL_TOGGLE,
        title: "Toggle side panel",
        description: "Show or hide the side panel: OpenCode's landing page, the DAG graph, the run list, and help",
        group: "DAG",
        bind: "<leader>b",
        palette: true,
        slash: { name: "side-panel" },
        run: () => {
          void ctl.toggle()
        },
      },
      {
        id: FOCUS,
        title: "Focus side panel",
        description: "Move the cursor between the session and the side panel, opening the panel if it is closed",
        group: "DAG",
        bind: typeof context.options.focusKey === "string" ? context.options.focusKey : "ctrl+g",
        palette: true,
        run: () => {
          void ctl.flip()
        },
      },
      {
        id: GRAPH,
        title: "Show DAG graph",
        description: "Open the side panel on the newest DAG graph and move the cursor into it",
        group: "DAG",
        bind: false,
        palette: true,
        slash: { name: "dag" },
        run: () => {
          void ctl.openGraph()
        },
      },
      {
        id: ORIGIN,
        title: "Go to the DAG's origin session",
        description: "From a step's session, switch back to the session that started the DAG",
        group: "DAG",
        bind: "<leader>o",
        palette: true,
        slash: { name: "dag-origin" },
        run: () => ctl.backToOrigin(),
      },
    ],
  }))

  createEffect(
    on(ctl.routed, (sessionID) => {
      if (!sessionID) return
      void ctl.refresh(sessionID)
      ctl.followRoute(sessionID)
    }),
  )

  createEffect(on(() => context.ui.panel.current(), (current, previous) => ctl.onPanelChange(current, previous)))

  createEffect(() => {
    const sessionID = ctl.routed()
    ctl.version()
    if (!sessionID) return
    const run = ctl.store.newest(sessionID)
    if (!run) return
    const open = shouldAutoOpen({
      runStatus: run.status,
      dismissed: ctl.store.ui(sessionID).dismissedRunId === run.id,
      width: dims().width,
      isOriginSession: run.sessionID === sessionID,
      panelOpen: ctl.openFor(sessionID),
    })
    // A run that opens the panel by itself is shown on its graph, whatever page was picked before.
    if (open) untrack(() => ctl.openPanel(sessionID, "auto", { view: "graph", shownRunId: undefined }))
  })

  createEffect(() => {
    const sessionID = ctl.routed()
    ctl.version()
    const run = sessionID ? ctl.store.newest(sessionID) : undefined
    const ui = sessionID ? ctl.store.ui(sessionID) : undefined
    const due =
      sessionID !== undefined &&
      ui !== undefined &&
      ctl.openFor(sessionID) &&
      shouldAutoClose({ autoOpened: ui.opened === "auto", interacted: ui.interacted, runStatus: run?.status })
    untrack(() => (due ? ctl.scheduleClose(sessionID) : ctl.cancelClose()))
  })

  const running = createMemo(() => {
    ctl.version()
    return ctl.store.all().some((run: DagRun) => run.status === "running")
  })
  createEffect(() => {
    if (!running()) return
    const timer = setInterval(ctl.tick, 1000)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(ctl.cancelClose)
  return null
}

function Strip(props: { ctl: Controller; sessionID: () => string }) {
  const context = usePlugin()
  const dims = useTerminalDimensions()
  const segments = createMemo(() => {
    props.ctl.version()
    const run = props.ctl.store.newest(props.sessionID())
    if (run?.status !== "running") return undefined
    const insideStep = run.sessionID !== props.sessionID()
    return renderStrip(run, {
      now: props.ctl.now(),
      panelHint: resolveKey(context, FOCUS),
      originHint: insideStep ? originCue(context) : undefined,
      width: dims().width - 2,
    }) as Line | null
  })
  return (
    <Show when={segments()}>
      {(line) => (
        <box flexShrink={0} paddingLeft={1} onMouseUp={() => void props.ctl.openGraph()}>
          <Row line={line()} />
        </box>
      )}
    </Show>
  )
}

// The side panel: OpenCode's landing page, the DAG graph, the run list, and help, one page at a time.
// The host owns the pane, so it can be dragged wider or narrower and remembers the width.
function Pages(props: { ctl: Controller; panel: PanelInput }) {
  const context = usePlugin()
  const ctl = props.ctl
  const dims = useTerminalDimensions()
  const sessionID = () => props.panel.sessionID
  // One column for the drag line and one of padding on each side.
  const width = () => Math.max(10, props.panel.width - 3)
  const [saved, update] = context.storage.store("session-page", { initial: { mcpOpen: true } })

  const runs = createMemo(() => {
    ctl.version()
    return runsOf(ctl.store.all(), sessionID()) as DagRun[]
  })
  const views = createMemo(() => availableViews(runs().length) as View[])
  const view = createMemo(() => {
    ctl.version()
    return resolveView(views(), ctl.store.ui(sessionID()).view) as View
  })
  const run = createMemo(() => {
    ctl.version()
    return shownRun(runs(), ctl.store.ui(sessionID())) as DagRun | undefined
  })
  const selectedId = createMemo(() => {
    ctl.version()
    return resolveSelection(run(), ctl.store.ui(sessionID()), sessionID()) as string | undefined
  })
  const node = createMemo(() => run()?.nodes.find((item) => item.id === selectedId()))
  const cursorRunId = createMemo(() => {
    ctl.version()
    const cursor = ctl.store.ui(sessionID()).runCursor
    return runs().some((item) => item.id === cursor) ? cursor : run()?.id
  })

  // A node opened inside the panel: its conversation shows here instead of in the session view.
  const stepNode = createMemo(() => {
    ctl.version()
    const id = ctl.store.ui(sessionID()).stepId
    return id === undefined ? undefined : run()?.nodes.find((item) => item.id === id)
  })
  const step = () => view() === "graph" && stepNode() !== undefined
  const stepSession = () => (step() ? stepNode()?.sessionID : undefined)
  const [typing, setTyping] = createSignal(false)
  const [draft, setDraft] = createSignal("")

  const info = createMemo(() => context.data.session.get(sessionID()))
  const usage = createMemo(() =>
    contextUsage(
      context.data.session.message.list(sessionID()),
      context.data.location.model.list(info()?.location),
      info()?.revert?.messageID,
    ),
  )
  const servers = createMemo(() => context.data.location.mcp.server.list(info()?.location) ?? [])
  const page = createMemo(() =>
    renderSessionPage({
      title: info()?.title,
      usage: usage(),
      cost: context.data.session.cost(sessionID()),
      servers: servers(),
      expanded: saved.mcpOpen,
      width: width(),
    }),
  )

  const tabs = createMemo((): Line => renderViewTabs(views(), view(), { width: width() }) as Line)
  const header = createMemo((): Line[] => (run() ? renderHeader(run(), { width: width(), now: ctl.now() }) : []))
  const graph = createMemo(() =>
    run() ? graphLayout(run(), { width: width(), selectedId: selectedId(), now: ctl.now() }) : undefined,
  )
  const edges = createMemo((): Line[] => (run() ? renderEdges(run(), { width: width() }) : []))
  const detail = createMemo((): Line[] =>
    renderDetail(node(), {
      width: width(),
      now: ctl.now(),
      maxLines: Math.min(12, Math.max(4, Math.floor(dims().height / 4))),
    }),
  )
  const runList = createMemo(() => renderRuns(runs(), { selectedId: cursorRunId(), width: width(), now: ctl.now() }))
  const help = createMemo((): Line[] => renderHelp({ keys: panelKeys(context), host: hostKeys(context), width: width() }) as Line[])
  const stepHeader = createMemo((): Line[] => renderStepHeader(stepNode(), { width: width(), now: ctl.now() }) as Line[])
  const transcript = createMemo((): Line[] => {
    const id = stepSession()
    return id ? (renderTranscript(context.data.session.message.list(id), { width: width() }) as Line[]) : []
  })
  const hints = createMemo(
    (): Line[] =>
      renderHints({
        view: view(),
        step: step(),
        typing: typing(),
        running: canCancel(run()),
        canOpen: Boolean(node()?.sessionID),
        canCycle: views().length > 1,
        focused: props.panel.focused,
        keys: panelKeys(context),
        width: width(),
      }) as Line[],
  )

  // The controller flips the cursor between the panel and the session, so it needs this panel's focus state.
  ctl.attach(props.panel)
  createEffect(() => ctl.setPanelFocused(props.panel.focused))
  onCleanup(() => {
    ctl.attach(undefined)
    ctl.setPanelFocused(false)
  })

  // Mounting focuses the panel. An auto-opened panel hands focus back to the composer once, as soon
  // as the host reports it focused, so typing is not interrupted.
  let handBack = ctl.store.ui(sessionID()).opened === "auto"
  createEffect(() => {
    if (!handBack || !props.panel.focused) return
    handBack = false
    context.keymap.dispatch("pane.focus.left")
  })

  // Below the split width the host forces fullscreen; an unrequested takeover is closed at once.
  createEffect(() => {
    if (props.panel.presentation !== "fullscreen") return
    const ui = ctl.store.ui(sessionID())
    if (ui.opened === "auto" && !ui.interacted) ctl.closeByUser(sessionID())
  })

  // The step's messages are fetched when it is opened and kept fresh while it works.
  createEffect(() => {
    const id = stepSession()
    if (!id) return
    void context.data.session.message.sync(id)
    if (stepNode()?.state !== "running" && context.data.session.status(id) !== "running") return
    const timer = setInterval(() => void context.data.session.message.sync(id), 1500)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(() => {
    if (!step()) setTyping(false)
  })

  let scroll: ScrollBoxRenderable | undefined
  const scrollBy = (delta: number) => {
    if (scroll) scroll.scrollTo(Math.max(0, scroll.scrollTop + delta))
  }
  const keepInView = (range: { start: number; end: number } | undefined) => {
    if (!range || !scroll) return
    if (range.end > scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(range.end - scroll.viewport.height)
    if (range.start < scroll.scrollTop) scroll.scrollTo(range.start)
  }

  const move = (direction: Direction) => {
    ctl.touch(sessionID())
    const current = view()
    if (current === "graph" && step()) {
      if (direction === "up" || direction === "down") scrollBy(direction === "down" ? 1 : -1)
      return
    }
    if (current === "graph") {
      const shown = run()
      if (shown) ctl.select(sessionID(), shown, navigate(graph(), selectedId(), direction))
      return
    }
    if (direction === "left" || direction === "right") return
    const stepSize = direction === "down" ? 1 : -1
    if (current === "runs") {
      const ids = runs().map((item) => item.id)
      const at = Math.max(0, ids.indexOf(cursorRunId() ?? ""))
      const next = ids[Math.min(ids.length - 1, Math.max(0, at + stepSize))]
      if (next) ctl.store.patchUi(sessionID(), { runCursor: next })
      return
    }
    scrollBy(stepSize)
  }

  // Enter on a node shows its conversation in the panel, where it can be read and answered.
  const openStep = () => {
    ctl.touch(sessionID())
    const current = node()
    if (!current?.sessionID) {
      ctl.toast("This node has no session yet")
      return
    }
    ctl.store.patchUi(sessionID(), { stepId: current.id })
  }

  // The step's own session view, for when the panel is not enough.
  const openSession = () => {
    ctl.touch(sessionID())
    const target = stepNode()?.sessionID
    if (!target) {
      ctl.toast("This node has no session yet")
      return
    }
    context.ui.router.navigate({ type: "session", sessionID: target })
  }

  const startTyping = () => {
    if (!stepSession()) return
    ctl.touch(sessionID())
    setTyping(true)
  }
  const stopTyping = () => {
    setTyping(false)
    props.panel.focus()
  }
  const send = async (value: string) => {
    const text = value.trim()
    const target = stepSession()
    if (!text || !target) return
    setDraft("")
    try {
      await context.client.session.prompt({ sessionID: target, text })
      void context.data.session.message.sync(target)
    } catch (error) {
      setDraft(text)
      ctl.toast(`Could not send: ${describe(error)}`, "error")
    }
  }

  // Enter opens a step in the graph, starts a message inside a step, and shows the chosen run in the runs list.
  const enter = () => {
    if (view() === "runs") {
      ctl.touch(sessionID())
      const chosen = cursorRunId()
      if (chosen) ctl.store.patchUi(sessionID(), { shownRunId: chosen, view: "graph" })
      return
    }
    if (view() !== "graph") return
    if (step()) startTyping()
    else openStep()
  }

  // Esc backs out one level: stop typing, leave the step, then close the panel.
  const back = () => {
    if (typing()) stopTyping()
    else if (step()) ctl.store.patchUi(sessionID(), { stepId: undefined })
    else ctl.closeByUser(sessionID())
  }

  const needGraph = () => {
    ctl.toast(step() ? "Press esc to leave the step first" : "Switch to the Graph page first")
  }

  const cancel = async () => {
    ctl.touch(sessionID())
    if (view() !== "graph" || step()) return needGraph()
    const current = run()
    if (!current) return
    if (!canCancel(current)) {
      ctl.toast("Run already finished")
      return
    }
    const confirmed = await context.ui.dialog.confirm({
      title: "Cancel DAG run",
      message: `Stop "${current.name}"? Running nodes are aborted.`,
      label: { confirm: "Cancel run", cancel: "Keep running" },
    })
    if (confirmed) await ctl.act("cancel", current)
  }

  const retry = async () => {
    ctl.touch(sessionID())
    if (view() !== "graph" || step()) return needGraph()
    const current = run()
    if (!current) return
    if (!canRetry(current)) {
      ctl.toast("Run is still running")
      return
    }
    await ctl.act("retry", current)
  }

  const close = () => ctl.closeByUser(sessionID())

  const toggleMcp = () => {
    if (servers().length <= 2) return
    update((draft) => {
      draft.mcpOpen = !draft.mcpOpen
    }).catch((error) => console.error("Failed to persist the session page state", error))
  }

  // Esc works while typing too, so it lives apart from the keys that would otherwise type.
  context.keymap.layer(() => ({
    priority: 30,
    enabled: () => props.panel.focused,
    commands: [{ id: `${PANEL}.panel.close.escape`, title: "Side panel: back", group: "DAG", bind: "escape", run: back }],
  }))

  context.keymap.layer(() => ({
    priority: 10,
    enabled: () => props.panel.focused && !typing(),
    commands: [
      { id: `${PANEL}.panel.down`, title: "Side panel: down", group: "DAG", bind: "j", run: () => move("down") },
      { id: `${PANEL}.panel.down.arrow`, title: "Side panel: down", group: "DAG", bind: "down", run: () => move("down") },
      { id: `${PANEL}.panel.up`, title: "Side panel: up", group: "DAG", bind: "k", run: () => move("up") },
      { id: `${PANEL}.panel.up.arrow`, title: "Side panel: up", group: "DAG", bind: "up", run: () => move("up") },
      { id: `${PANEL}.panel.left`, title: "Side panel: left", group: "DAG", bind: "h", run: () => move("left") },
      { id: `${PANEL}.panel.left.arrow`, title: "Side panel: left", group: "DAG", bind: "left", run: () => move("left") },
      { id: `${PANEL}.panel.right`, title: "Side panel: right", group: "DAG", bind: "l", run: () => move("right") },
      { id: `${PANEL}.panel.right.arrow`, title: "Side panel: right", group: "DAG", bind: "right", run: () => move("right") },
      { id: `${PANEL}.panel.open`, title: "Side panel: open the selection", group: "DAG", bind: "return", run: enter },
      { id: `${PANEL}.panel.view.previous`, title: "Side panel: previous page", group: "DAG", bind: "y", run: () => ctl.cycle(-1) },
      { id: `${PANEL}.panel.view.next`, title: "Side panel: next page", group: "DAG", bind: "o", run: () => ctl.cycle(1) },
      { id: `${PANEL}.panel.fullscreen`, title: "Side panel: toggle fullscreen", group: "DAG", bind: "f", run: () => props.panel.toggleFullscreen() },
      { id: `${PANEL}.panel.cancel`, title: "Cancel DAG run", group: "DAG", bind: "c", run: cancel },
      { id: `${PANEL}.panel.retry`, title: "Retry DAG run", group: "DAG", bind: "r", run: retry },
      { id: `${PANEL}.panel.message`, title: "Side panel: message the step", group: "DAG", bind: "i", run: startTyping },
      { id: `${PANEL}.panel.session`, title: "Side panel: open the step's session", group: "DAG", bind: "g", run: openSession },
      { id: `${PANEL}.panel.close`, title: "Close side panel", group: "DAG", bind: "q", run: close },
    ],
  }))

  createEffect(
    on(selectedId, (id) => {
      if (untrack(view) === "graph") keepInView(untrack(() => graph()?.ranges[id ?? ""]))
    }),
  )
  createEffect(
    on(cursorRunId, (id) => {
      if (untrack(view) === "runs") keepInView(untrack(() => runList().ranges[id ?? ""]))
    }),
  )

  return (
    <box
      flexDirection="column"
      height="100%"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      border={["left"]}
      borderStyle="single"
      borderColor={context.theme.text.base}
      onMouseDown={() => ctl.touch(sessionID())}
    >
      <Row line={tabs()} />
      <Switch>
        <Match when={view() === "session"}>
          <scrollbox flexGrow={1} minHeight={0} marginTop={1} scrollbarOptions={{ visible: false }} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
            <Lines lines={page().top} />
            <Show when={page().mcpTitle}>
              {(title) => (
                <box flexDirection="column" flexShrink={0} paddingTop={page().top.length ? 1 : 0}>
                  <box flexShrink={0} onMouseDown={toggleMcp}>
                    <Row line={title()} />
                  </box>
                  <box flexShrink={0} onMouseUp={() => context.keymap.dispatch("mcp.list")}>
                    <Lines lines={page().mcpRows} />
                  </box>
                </box>
              )}
            </Show>
          </scrollbox>
        </Match>
        <Match when={view() === "graph" && run()}>
          <Show
            when={step()}
            fallback={
              <>
                <Lines lines={header()} />
                <scrollbox flexGrow={1} minHeight={0} marginTop={1} scrollbarOptions={{ visible: false }} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
                  <Lines lines={graph()?.lines ?? []} />
                  <Row line={[]} />
                  <Lines lines={edges()} />
                </scrollbox>
                <box flexShrink={0} paddingTop={1}>
                  <Lines lines={detail()} />
                </box>
              </>
            }
          >
            <Lines lines={stepHeader()} />
            <scrollbox flexGrow={1} minHeight={0} marginTop={1} scrollbarOptions={{ visible: false }} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
              <Lines lines={transcript()} />
            </scrollbox>
            <box flexShrink={0} flexDirection="row" paddingTop={1}>
              <text fg={roleColor(context.theme, "accent")} flexShrink={0}>{"› "}</text>
              <input
                flexGrow={1}
                focused={typing()}
                value={draft()}
                placeholder="message this step"
                textColor={context.theme.text.base}
                placeholderColor={context.theme.text.muted}
                onInput={setDraft}
                onSubmit={() => void send(draft())}
              />
            </box>
          </Show>
        </Match>
        <Match when={view() === "runs"}>
          <scrollbox flexGrow={1} minHeight={0} marginTop={1} scrollbarOptions={{ visible: false }} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
            <Lines lines={runList().lines} />
          </scrollbox>
        </Match>
        <Match when={view() === "help"}>
          <scrollbox flexGrow={1} minHeight={0} marginTop={1} scrollbarOptions={{ visible: false }} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
            <Lines lines={help()} />
          </scrollbox>
        </Match>
      </Switch>
      <box flexShrink={0} paddingTop={1}>
        <Lines lines={hints()} />
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "sidequest.tui",
  setup(context) {
    const ctl = createController(context)

    const removers = [
      context.ui.slot({ append: "app", render: () => <Host ctl={ctl} /> }),
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === PANEL}>
            <Pages ctl={ctl} panel={panel} />
          </Show>
        ),
      }),
      context.ui.slot({
        append: "session.composer.top",
        render: (input) => <Strip ctl={ctl} sessionID={() => input.sessionID} />,
      }),
    ]

    return () => {
      for (const remove of removers) remove()
      ctl.dispose()
    }
  },
})
