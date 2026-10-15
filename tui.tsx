/** @jsxImportSource @opentui/solid */
// tui.tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { graphLayout, renderDetail, renderEdges, renderHeader, renderHints, renderStrip } from "./layout.mjs"
import {
  AUTO_CLOSE_GRACE_MS,
  canCancel,
  canRetry,
  createRunStore,
  moveSelection,
  resolveSelection,
  shouldAutoClose,
  shouldAutoOpen,
} from "./panel-state.mjs"
import { AgentDag, type Run } from "./rpc.ts"

type DagRun = typeof Run.Type
type Segment = { text: string; role: string; bold?: boolean }
type Line = Segment[]
type Controller = ReturnType<typeof createController>
type Toast = "info" | "success" | "warning" | "error"
type CallOptions = { location?: { directory: string } }

// Effect schemas satisfy the runtime client but not the SDK's Portable* types, so the client shape is stated here.
type DagRpc = {
  snapshot: (input: { sessionID: string }, options?: CallOptions) => Promise<{ runs: readonly DagRun[] }>
  cancel: (input: { runId: string }, options?: CallOptions) => Promise<{ run?: DagRun }>
  retry: (input: { runId: string }, options?: CallOptions) => Promise<{ run?: DagRun }>
  events: { on: (name: "updated", handler: (event: { data: { sessionID: string; run: DagRun } }) => void) => () => void }
}

const PANEL = "questline.dag"
const TOGGLE = "questline.dag.toggle"
const FALLBACK_HINT = "<leader>d"

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
  const stopStore = store.subscribe(() => setVersion((value) => value + 1))
  const rpc = context.client.rpc(AgentDag as never) as unknown as DagRpc
  let disposed = false
  let warned = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let expectedClose: string | undefined
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

  function openPanel(sessionID: string, source: "auto" | "manual") {
    // The panel reads this at mount, which happens inside open(), so set it first and skip the notify.
    store.patchUi(sessionID, { opened: source, interacted: false }, { silent: true })
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
    dismiss(sessionID)
    closePanel()
  }

  // A close we did not ask for (terminal pane, another panel, the host) counts as a dismissal,
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
    if (routed() === previous.sessionID) dismiss(previous.sessionID)
  }

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
    if (!store.newest(sessionID)) {
      toast("No DAG in this session")
      return
    }
    openPanel(sessionID, "manual")
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
    toggle,
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
      <text wrapMode="none">
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
        id: TOGGLE,
        title: "Toggle DAG panel",
        description: "Show or hide the agent DAG graph for this session",
        group: "DAG",
        bind: "<leader>d",
        palette: true,
        slash: { name: "dag" },
        run: () => {
          void ctl.toggle()
        },
      },
    ],
  }))

  createEffect(
    on(ctl.routed, (sessionID) => {
      if (sessionID) void ctl.refresh(sessionID)
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
    if (open) untrack(() => ctl.openPanel(sessionID, "auto"))
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
    if (!run || run.status !== "running") return undefined
    return renderStrip(run, {
      now: props.ctl.now(),
      leaderHint: context.keymap.shortcuts(TOGGLE)[0] ?? FALLBACK_HINT,
      width: dims().width - 2,
    }) as Line | null
  })
  return (
    <Show when={segments()}>
      {(line) => (
        <box flexShrink={0} paddingLeft={1} onMouseUp={() => void props.ctl.toggle()}>
          <Row line={line()} />
        </box>
      )}
    </Show>
  )
}

function DagPanel(props: { ctl: Controller; panel: PanelInput }) {
  const context = usePlugin()
  const ctl = props.ctl
  const dims = useTerminalDimensions()
  const sessionID = () => props.panel.sessionID
  const run = createMemo(() => {
    ctl.version()
    return ctl.store.newest(sessionID()) as DagRun | undefined
  })
  const selectedId = createMemo(() => {
    ctl.version()
    return resolveSelection(run(), ctl.store.ui(sessionID()), sessionID()) as string | undefined
  })
  const node = createMemo(() => run()?.nodes.find((item) => item.id === selectedId()))
  const width = () => Math.max(10, props.panel.width - 2)
  const toggleHint = () => context.keymap.shortcuts(TOGGLE)[0] ?? FALLBACK_HINT

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
  const hints = createMemo((): Line =>
    renderHints({
      running: canCancel(run()),
      canOpen: Boolean(node()?.sessionID),
      focused: props.panel.focused,
      toggleHint: toggleHint(),
      focusHint: context.keymap.shortcuts("pane.focus.right")[0],
      width: width(),
    }),
  )

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

  const move = (delta: number) => {
    const current = run()
    if (current) ctl.select(sessionID(), current, moveSelection(current, selectedId(), delta))
  }

  const openNode = () => {
    ctl.touch(sessionID())
    const target = node()?.sessionID
    if (!target) {
      ctl.toast("This node has no session yet")
      return
    }
    context.ui.router.navigate({ type: "session", sessionID: target })
  }

  const cancel = async () => {
    ctl.touch(sessionID())
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
    const current = run()
    if (!current) return
    if (!canRetry(current)) {
      ctl.toast("Run is still running")
      return
    }
    await ctl.act("retry", current)
  }

  const close = () => ctl.closeByUser(sessionID())

  context.keymap.layer(() => ({
    priority: 10,
    enabled: () => props.panel.focused,
    commands: [
      { id: `${PANEL}.panel.next`, title: "Next DAG node", group: "DAG", bind: "j", run: () => move(1) },
      { id: `${PANEL}.panel.next.arrow`, title: "Next DAG node", group: "DAG", bind: "down", run: () => move(1) },
      { id: `${PANEL}.panel.prev`, title: "Previous DAG node", group: "DAG", bind: "k", run: () => move(-1) },
      { id: `${PANEL}.panel.prev.arrow`, title: "Previous DAG node", group: "DAG", bind: "up", run: () => move(-1) },
      { id: `${PANEL}.panel.open`, title: "Open node session", group: "DAG", bind: "return", run: openNode },
      { id: `${PANEL}.panel.cancel`, title: "Cancel DAG run", group: "DAG", bind: "c", run: cancel },
      { id: `${PANEL}.panel.retry`, title: "Retry DAG run", group: "DAG", bind: "r", run: retry },
      { id: `${PANEL}.panel.close`, title: "Close DAG panel", group: "DAG", bind: "q", run: close },
      { id: `${PANEL}.panel.close.escape`, title: "Close DAG panel", group: "DAG", bind: "escape", run: close },
    ],
  }))

  let scroll: ScrollBoxRenderable | undefined
  createEffect(
    on(selectedId, (id) => {
      const range = untrack(() => graph()?.ranges[id ?? ""])
      if (!range || !scroll) return
      if (range.end > scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(range.end - scroll.viewport.height)
      if (range.start < scroll.scrollTop) scroll.scrollTo(range.start)
    }),
  )

  return (
    <box
      flexDirection="column"
      height="100%"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      onMouseDown={() => ctl.touch(sessionID())}
    >
      <Show
        when={run()}
        fallback={
          <text fg={context.theme.text.muted} wrapMode="none">
            No DAG in this session
          </text>
        }
      >
        <Lines lines={header()} />
        <scrollbox flexGrow={1} marginTop={1} scrollbarOptions={{ visible: false }} ref={(value: ScrollBoxRenderable) => (scroll = value)}>
          <Lines lines={graph()?.lines ?? []} />
          <Row line={[]} />
          <Lines lines={edges()} />
        </scrollbox>
        <box flexShrink={0} paddingTop={1}>
          <Lines lines={detail()} />
        </box>
        <Lines lines={[hints()]} />
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "questline.tui",
  setup(context) {
    const ctl = createController(context)

    const removers = [
      context.ui.slot({ append: "app", render: () => <Host ctl={ctl} /> }),
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === PANEL}>
            <DagPanel ctl={ctl} panel={panel} />
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
