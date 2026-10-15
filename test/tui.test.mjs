// test/tui.test.mjs
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  ROLES,
  STATE_GLYPH,
  STATE_ROLE,
  clean,
  countNodes,
  displayWidth,
  edgesOf,
  fit,
  fitLine,
  formatElapsed,
  graphLayout,
  layersOf,
  lineText,
  lineWidth,
  renderDetail,
  renderEdges,
  renderGraph,
  renderHeader,
  renderHints,
  renderStrip,
  wrapText,
} from "../layout.mjs"
import {
  AUTO_CLOSE_GRACE_MS,
  MAX_KEPT_RUNS,
  canCancel,
  canRetry,
  canSplit,
  createRunStore,
  defaultSelection,
  includesSession,
  isNewerRevision,
  moveSelection,
  newestRun,
  nodeForSession,
  resolveSelection,
  selectionOrder,
  shouldAutoClose,
  shouldAutoOpen,
} from "../panel-state.mjs"

const AGENT_DAG = ".."
const TUI_SOURCE = readFileSync(new URL(`${AGENT_DAG}/tui.tsx`, import.meta.url), "utf8")
const RPC_SOURCE = readFileSync(new URL(`${AGENT_DAG}/rpc.ts`, import.meta.url), "utf8")

const NOW = 1_700_000_000_000
const WIDTHS = [1, 5, 8, 11, 12, 20, 24, 33, 40, 60, 80, 120, 200]

const node = (id, state = "pending", dependsOn = [], extra = {}) => ({
  id,
  label: id,
  dependsOn,
  state,
  attempt: 1,
  ...extra,
})

const run = (nodes, extra = {}) => ({
  id: "r1",
  name: "release",
  sessionID: "S1",
  status: "running",
  revision: 1,
  createdAt: NOW - 90_000,
  updatedAt: NOW,
  maxParallel: 3,
  nodes,
  ...extra,
})

const diamond = (extra = {}) =>
  run(
    [
      node("plan", "completed", [], { startedAt: NOW - 80_000, finishedAt: NOW - 50_000 }),
      node("lint", "running", ["plan"], { startedAt: NOW - 40_000, activity: "reading terraform" }),
      node("test", "failed", ["plan"], { error: "3 tests failed in the integration suite" }),
      node("ship", "pending", ["lint", "test"]),
    ],
    extra,
  )

const fanOut = (count) =>
  run([node("root", "completed"), ...Array.from({ length: count - 1 }, (_, index) => node(`task-${index}`, "pending", ["root"]))])

const widest = (lines) => Math.max(0, ...lines.map(lineWidth))
const texts = (lines) => lines.map(lineText)
const boxesIn = (line) => [...line].filter((char) => char === "╭" || char === "┏").length

test("elapsed time reads compactly and never goes negative", () => {
  assert.equal(formatElapsed(0), "0s")
  assert.equal(formatElapsed(59_999), "59s")
  assert.equal(formatElapsed(65_000), "1m 05s")
  assert.equal(formatElapsed(3_725_000), "1h 02m")
  assert.equal(formatElapsed(-5), "0s")
  assert.equal(formatElapsed(Number.NaN), "0s")
})

test("display width counts wide glyphs double and combining marks as zero", () => {
  assert.equal(displayWidth("abc"), 3)
  assert.equal(displayWidth("日本語"), 6)
  assert.equal(displayWidth("\u{1F680}"), 2)
  assert.equal(displayWidth("e\u0301"), 1)
  for (const icon of Object.values(STATE_GLYPH)) assert.equal(displayWidth(icon), 1)
  for (const glyph of ["▸", "▾", "▼", "←", "…", "●", "✓", "×", "╭", "┏", "┃"]) assert.equal(displayWidth(glyph), 1)
})

test("fit truncates with an ellipsis, pads on request, and strips control characters", () => {
  assert.equal(fit("short", 10), "short")
  assert.equal(fit("short", 10, true), "short     ")
  assert.equal(fit("a-very-long-label", 8), "a-very-…")
  assert.equal(fit("日本語日本語", 7), "日本語…")
  assert.equal(fit("abc", 0), "")
  assert.equal(fit("abc", 1), "…")
  assert.equal(clean("\u001b[31mred\u001b[0m\nline\ttab"), "red line tab")
  for (const columns of [1, 2, 3, 5, 9]) assert.ok(displayWidth(fit("日本語 mixed ラベル text", columns, true)) <= columns)
})

test("fitLine keeps roles, truncates across segments, and never exceeds the width", () => {
  const line = [
    { text: "alpha ", role: "muted" },
    { text: "beta gamma", role: "error", bold: true },
  ]
  assert.deepEqual(fitLine(line, 40), line)
  const cut = fitLine(line, 9)
  assert.equal(lineText(cut), "alpha be…")
  assert.ok(lineWidth(cut) <= 9)
  assert.equal(cut.at(-1).role, "error")
  assert.equal(cut.at(-2).bold, true)
  assert.equal(lineWidth(fitLine(line, 20, true)), 20)
  assert.deepEqual(fitLine(line, 0), [])
})

test("wrapText splits on spaces, hard-splits long words, and ellipsizes past the limit", () => {
  assert.deepEqual(wrapText("one two three four", 9), ["one two", "three", "four"])
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"])
  assert.deepEqual(wrapText("first\n\nsecond", 20), ["first", "second"])
  assert.deepEqual(wrapText("", 10), [])
  const limited = wrapText("one two three four five six", 7, 2)
  assert.equal(limited.length, 2)
  assert.match(limited[1], /…$/)
  for (const row of wrapText("日本語のとても長い説明文です", 6)) assert.ok(displayWidth(row) <= 6)
})

test("layers are topological and tolerate cycles and unknown dependencies", () => {
  const ids = (layers) => layers.map((layer) => layer.map((item) => item.id))
  assert.deepEqual(ids(layersOf(diamond().nodes)), [["plan"], ["lint", "test"], ["ship"]])
  assert.deepEqual(ids(layersOf([node("a"), node("b"), node("c", "pending", ["a", "b"])])), [["a", "b"], ["c"]])
  assert.deepEqual(ids(layersOf([node("a", "pending", ["ghost"])])), [["a"]])
  assert.deepEqual(ids(layersOf([node("a", "pending", ["b"]), node("b", "pending", ["a"]), node("c")])), [["c"], ["a", "b"]])
  assert.deepEqual(ids(layersOf([node("a", "pending", ["a"])])), [["a"]])
  assert.deepEqual(layersOf([]), [])
})

test("edges skip unknown and duplicate dependencies", () => {
  const nodes = [node("a"), node("b", "pending", ["a", "a", "ghost"]), node("c", "pending", ["a", "b"])]
  assert.deepEqual(edgesOf(nodes), [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "c" },
  ])
})

test("every node state has a distinct glyph and a role", () => {
  const states = ["pending", "running", "completed", "failed", "skipped", "cancelled"]
  assert.equal(new Set(states.map((state) => STATE_GLYPH[state])).size, states.length)
  for (const state of states) assert.ok(ROLES.includes(STATE_ROLE[state]), state)
  assert.equal(STATE_ROLE.running, "info")
  assert.equal(STATE_ROLE.completed, "success")
  assert.equal(STATE_ROLE.failed, "error")
  assert.equal(STATE_ROLE.skipped, "warning")
  assert.equal(STATE_ROLE.pending, "muted")
  assert.equal(STATE_ROLE.cancelled, "muted")

  const all = run(states.map((state) => node(state, state)))
  const frame = texts(renderGraph(all, { width: 120, now: NOW })).join("\n")
  for (const state of states) assert.match(frame, new RegExp(`\\${STATE_GLYPH[state]} ${state}`))
})

test("node boxes carry marker, label, state line and dependency line", () => {
  const frame = texts(renderGraph(diamond(), { width: 80, selectedId: "lint", now: NOW }))
  const joined = frame.join("\n")
  assert.match(joined, /┃ >▾ lint/)
  assert.match(joined, /│  ▸ plan/)
  assert.match(joined, /✓ completed 30s/)
  assert.match(joined, /● running reading/)
  assert.match(joined, /× failed 3 tests/)
  assert.match(joined, /← plan/)
  assert.match(joined, /← lint, test/)
  assert.match(joined, / start /)
})

test("selection is drawn with a heavy border and marker on exactly one node", () => {
  const selected = texts(renderGraph(diamond(), { width: 80, selectedId: "test", now: NOW })).join("\n")
  assert.equal((selected.match(/┏/g) ?? []).length, 1)
  assert.equal((selected.match(/>▾/g) ?? []).length, 1)
  assert.match(selected, />▾ test/)
  const none = texts(renderGraph(diamond(), { width: 80, now: NOW })).join("\n")
  assert.doesNotMatch(none, /┏|>▾/)
  const missing = texts(renderGraph(diamond(), { width: 80, selectedId: "ghost", now: NOW })).join("\n")
  assert.doesNotMatch(missing, /┏|>▾/)
})

test("connectors join layers with box junctions and a down arrow", () => {
  const frame = texts(renderGraph(diamond(), { width: 80, now: NOW })).join("\n")
  assert.match(frame, /┌[─┬┴]*┐|┌─+┴─+┐/)
  assert.match(frame, /▼/)
  assert.ok((frame.match(/▼/g) ?? []).length >= 3)
  assert.match(frame, /└[─┬┴┼]*[┘┬]/)
})

test("no rendered line exceeds the requested width", () => {
  const longLabels = run([
    node("a", "completed", [], { label: "an extremely long label that cannot possibly fit in a box" }),
    node("b", "running", ["a"], { label: "日本語のとても長いラベルです", activity: "doing something verbose and slow" }),
    node("c", "failed", ["a"], { label: "\u{1F680} rocket launch preparation checklist", error: "a very long error message ".repeat(8) }),
    node("d", "pending", ["a", "b", "c", ...Array.from({ length: 12 }, (_, i) => `ghost-${i}`)]),
  ])
  const cases = [
    ["diamond", diamond()],
    ["fan-out 24", fanOut(24)],
    ["24 independent", run(Array.from({ length: 24 }, (_, i) => node(`n${i}`, "running")))],
    ["long labels", longLabels],
    ["finished", { ...diamond(), status: "failed", finishedAt: NOW }],
    ["empty", run([])],
  ]
  for (const [name, subject] of cases) {
    for (const width of WIDTHS) {
      for (const selectedId of [undefined, subject.nodes[1]?.id]) {
        const lines = renderGraph(subject, { width, selectedId, now: NOW })
        assert.ok(widest(lines) <= width, `${name} graph at ${width}: ${widest(lines)}`)
        assert.ok(widest(renderEdges(subject, { width })) <= width, `${name} edges at ${width}`)
        assert.ok(widest(renderHeader(subject, { width, now: NOW })) <= width, `${name} header at ${width}`)
        for (const item of subject.nodes) {
          assert.ok(widest(renderDetail(item, { width, now: NOW })) <= width, `${name} detail ${item.id} at ${width}`)
        }
      }
    }
  }
})

test("graph shows more than one box per row only when it fits", () => {
  const perRow = (width) => Math.max(...renderGraph(diamond(), { width, now: NOW }).map((line) => boxesIn(lineText(line))))
  assert.equal(perRow(40), 1)
  assert.equal(perRow(41), 1)
  assert.equal(perRow(42), 2)
  assert.equal(perRow(60), 2)
  assert.equal(perRow(120), 2)

  const wide = (width) => Math.max(...renderGraph(fanOut(24), { width, now: NOW }).map((line) => boxesIn(lineText(line))))
  assert.equal(wide(40), 1)
  assert.equal(wide(60), 2)
  assert.equal(wide(80), 3)
  assert.equal(wide(120), 5)
  for (const width of [60, 80, 120, 200]) {
    for (const line of renderGraph(fanOut(24), { width, now: NOW })) assert.ok(boxesIn(lineText(line)) <= Math.floor((width + 2) / 22))
  }
})

test("a 24-node fan-out wraps into groups, keeps every node, and reports line ranges", () => {
  const { lines, ranges } = graphLayout(fanOut(24), { width: 120, selectedId: "task-22", now: NOW })
  const frame = texts(lines).join("\n")
  for (let index = 0; index < 23; index++) assert.match(frame, new RegExp(`task-${index}\\b`))
  assert.match(frame, /same layer/)
  assert.equal(Object.keys(ranges).length, 24)
  for (const { start, end } of Object.values(ranges)) {
    assert.equal(end - start, 5)
    assert.ok(end <= lines.length)
  }
  assert.match(texts(lines.slice(ranges["task-22"].start, ranges["task-22"].end)).join("\n"), /┃ >▾ task-22/)
  const root = ranges.root
  const first = ranges["task-0"]
  assert.ok(root.end <= first.start)
})

test("very narrow panels fall back to one line per node", () => {
  const { lines, ranges } = graphLayout(diamond(), { width: 11, selectedId: "lint", now: NOW })
  assert.equal(lines.length, 4)
  assert.ok(widest(lines) <= 11)
  assert.match(lineText(lines[ranges.lint.start]), /^> ● lint/)
})

test("empty and finished runs render sensibly", () => {
  assert.deepEqual(texts(renderGraph(run([]), { width: 40 })), ["No nodes"])
  assert.deepEqual(renderGraph(undefined, { width: 40 }).map(lineText), ["No nodes"])
  const finished = { ...diamond(), status: "completed", finishedAt: NOW - 10_000 }
  const frame = texts(renderGraph(finished, { width: 80, now: NOW + 3_600_000 })).join("\n")
  assert.doesNotMatch(frame, /1h/)
  const header = texts(renderHeader(finished, { width: 80, now: NOW + 3_600_000 }))
  assert.match(header[0], /dag release {2}completed/)
  assert.match(header[1], /1m 20s/)
})

test("strip text matches the contract for a running run and is empty otherwise", () => {
  const strip = renderStrip(diamond(), { now: NOW, leaderHint: "ctrl+g d" })
  assert.equal(lineText(strip), "dag release  1● 1/4 ✓  1×  1m 30s   ctrl+g d graph")
  assert.deepEqual(strip.map((item) => item.role), ["muted", "accent", "default", "info", "default", "success", "error", "muted", "muted"])
  assert.equal(lineText(renderStrip(run([node("a", "running"), node("b")]), { now: NOW })), "dag release  1● 0/2 ✓  1m 30s   <leader>d graph")
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(renderStrip(diamond({ status }), { now: NOW }), null)
  assert.equal(renderStrip(undefined, { now: NOW }), null)
})

test("strip drops the hint, then truncates the name, to fit", () => {
  const long = diamond({ name: "a-very-long-release-pipeline-name" })
  const full = lineText(renderStrip(long, { now: NOW, leaderHint: "ctrl+g d" }))
  assert.match(full, /graph$/)
  const noHint = lineText(renderStrip(long, { now: NOW, leaderHint: "ctrl+g d", width: full.length - 3 }))
  assert.doesNotMatch(noHint, /graph/)
  assert.match(noHint, /a-very-long-release-pipeline-name/)
  for (const width of [1, 4, 10, 20, 30, 45, 80]) {
    const line = renderStrip(long, { now: NOW, leaderHint: "ctrl+g d", width })
    assert.ok(lineWidth(line) <= width, `strip at ${width}`)
  }
  const squeezed = lineText(renderStrip(long, { now: NOW, leaderHint: "ctrl+g d", width: 30 }))
  assert.match(squeezed, /…/)
})

test("detail card lists state, agent, attempt, elapsed, session, error and output head", () => {
  const detail = texts(
    renderDetail(
      node("review", "failed", ["plan", "lint"], {
        label: "Security review",
        agent: "explorer",
        attempt: 2,
        startedAt: NOW - 125_000,
        finishedAt: NOW - 5_000,
        sessionID: "ses_01abc",
        error: "terraform plan exited with status 1 because the backend was unreachable",
        output: "line one\nline two is a bit longer than the others\n\nline three",
      }),
      { width: 40, now: NOW },
    ),
  )
  assert.match(detail[0], /^Security review \(review\)$/)
  assert.match(detail[1], /× failed {2}attempt 2 {2}2m 00s/)
  const joined = detail.join("\n")
  assert.match(joined, /agent {3}explorer/)
  assert.match(joined, /deps {4}plan, lint/)
  assert.match(joined, /session ses_01abc/)
  assert.match(joined, /error {3}terraform plan exited/)
  assert.match(joined, /output {2}line one/)
  assert.ok(texts(renderDetail(node("same", "pending"), { width: 40 }))[0] === "same")
  assert.deepEqual(renderDetail(undefined, { width: 40 }), [])
})

test("detail card clamps to maxLines with an ellipsis", () => {
  const verbose = node("v", "failed", ["a", "b"], {
    agent: "x",
    sessionID: "s",
    error: "e ".repeat(60),
    output: "o ".repeat(80),
  })
  const lines = renderDetail(verbose, { width: 30, now: NOW, maxLines: 5 })
  assert.equal(lines.length, 5)
  assert.equal(lineText(lines.at(-1)), "…")
  assert.ok(renderDetail(verbose, { width: 30, now: NOW }).length <= 12)
})

test("running node elapsed uses now, finished node uses its own end", () => {
  const detail = (item) => texts(renderDetail(item, { width: 40, now: NOW }))[1]
  assert.match(detail(node("r", "running", [], { startedAt: NOW - 61_000 })), /1m 01s/)
  assert.match(detail(node("c", "completed", [], { startedAt: NOW - 61_000, finishedAt: NOW - 1_000 })), /1m 00s/)
  assert.doesNotMatch(detail(node("p", "pending")), /\ds/)
})

test("header shows status, counts, parallelism and a bounded error", () => {
  const header = texts(renderHeader(diamond({ status: "failed", error: "the run failed because node test failed and nothing could continue ".repeat(3) }), { width: 36, now: NOW }))
  assert.match(header[0], /dag release {2}failed/)
  assert.match(header[1], /1● 1\/4 ✓ {2}1× {2}\d+m \d+s {2}parallel 3/)
  assert.ok(header.length <= 4)
  assert.deepEqual(countNodes(diamond()), { total: 4, pending: 1, running: 1, completed: 1, failed: 1, skipped: 0, cancelled: 0 })
})

test("hints depend on run state and focus", () => {
  assert.equal(lineText(renderHints({ running: true, canOpen: true, focused: true })), "j/k move  enter open  c cancel  q close")
  assert.equal(lineText(renderHints({ running: false, canOpen: false, focused: true })), "j/k move  r retry  q close")
  assert.equal(lineText(renderHints({ running: true, canOpen: true, focused: false, toggleHint: "ctrl+g d" })), "click to focus  ctrl+g d close")
  const unfocused = { running: true, canOpen: true, focused: false, toggleHint: "ctrl+g d", focusHint: "ctrl+g →" }
  assert.equal(lineText(renderHints({ ...unfocused, width: 60 })), "click or ctrl+g → to focus  ctrl+g d close")
  assert.equal(lineText(renderHints({ ...unfocused, width: 38 })), "click or ctrl+g → to focus")
  assert.equal(lineText(renderHints({ ...unfocused, width: 20 })), "click to focus")
  assert.ok(lineWidth(renderHints({ ...unfocused, width: 6 })) <= 6)
  assert.ok(lineWidth(renderHints({ running: true, canOpen: true, focused: true, width: 12 })) <= 12)
})

test("edge list groups dependents by source and says so when there are none", () => {
  const edges = texts(renderEdges(diamond(), { width: 40 }))
  assert.equal(edges[0], "Dependencies")
  assert.ok(edges.includes("  plan → lint, test"))
  assert.ok(edges.includes("  lint → ship"))
  assert.deepEqual(texts(renderEdges(run([node("a")]), { width: 40 })), ["Dependencies", "  none"])
  const wide = texts(renderEdges(fanOut(24), { width: 30 }))
  assert.ok(wide.length > 3)
  assert.ok(wide.every((line) => displayWidth(line) <= 30))
})

test("every segment role is a known role", () => {
  const lines = [
    ...renderGraph(diamond(), { width: 80, selectedId: "lint", now: NOW }),
    ...renderEdges(diamond(), { width: 80 }),
    ...renderHeader(diamond({ error: "boom" }), { width: 80, now: NOW }),
    ...renderDetail(diamond().nodes[2], { width: 80, now: NOW }),
    renderStrip(diamond(), { now: NOW }),
    renderHints({ running: true, canOpen: true, focused: true }),
  ]
  for (const line of lines) for (const item of line) assert.ok(ROLES.includes(item.role), item.role)
})

test("panel opens only for a running, undismissed run in its origin session on a wide terminal", () => {
  const base = { runStatus: "running", dismissed: false, width: 120, isOriginSession: true, panelOpen: false }
  assert.equal(shouldAutoOpen(base), true)
  assert.equal(shouldAutoOpen({ ...base, runStatus: "completed" }), false)
  assert.equal(shouldAutoOpen({ ...base, runStatus: undefined }), false)
  assert.equal(shouldAutoOpen({ ...base, dismissed: true }), false)
  assert.equal(shouldAutoOpen({ ...base, isOriginSession: false }), false)
  assert.equal(shouldAutoOpen({ ...base, panelOpen: true }), false)
  assert.equal(shouldAutoOpen({ ...base, width: 80 }), false)
  assert.equal(shouldAutoOpen({ ...base, width: 81 }), true)
  assert.equal(shouldAutoOpen({ ...base, width: Number.NaN }), false)
  assert.equal(canSplit(80), false)
  assert.equal(canSplit(81), true)
})

test("auto-opened panel closes after the run ends unless the user touched it", () => {
  const base = { autoOpened: true, interacted: false, runStatus: "completed" }
  assert.equal(shouldAutoClose(base), true)
  for (const runStatus of ["failed", "cancelled"]) assert.equal(shouldAutoClose({ ...base, runStatus }), true)
  assert.equal(shouldAutoClose({ ...base, runStatus: "running" }), false)
  assert.equal(shouldAutoClose({ ...base, runStatus: undefined }), false)
  assert.equal(shouldAutoClose({ ...base, interacted: true }), false)
  assert.equal(shouldAutoClose({ ...base, autoOpened: false }), false)
  assert.equal(AUTO_CLOSE_GRACE_MS, 8000)
})

test("cancel needs a running run and retry a finished one", () => {
  assert.equal(canCancel(diamond()), true)
  assert.equal(canCancel(diamond({ status: "failed" })), false)
  assert.equal(canCancel(undefined), false)
  assert.equal(canRetry(diamond({ status: "failed" })), true)
  assert.equal(canRetry(diamond()), false)
  assert.equal(canRetry(undefined), false)
})

test("runs belong to their origin session and to their node child sessions", () => {
  const first = diamond({ id: "a", createdAt: 100, updatedAt: 100 })
  first.nodes[1].sessionID = "C1"
  const second = diamond({ id: "b", createdAt: 200, updatedAt: 200 })
  const other = diamond({ id: "c", sessionID: "S2", createdAt: 300, updatedAt: 300 })
  assert.equal(includesSession(first, "S1"), true)
  assert.equal(includesSession(first, "C1"), true)
  assert.equal(includesSession(first, "S2"), false)
  assert.equal(newestRun([first, second, other], "S1").id, "b")
  assert.equal(newestRun([first, second, other], "S2").id, "c")
  assert.equal(newestRun([first, second, other], "C1").id, "a")
  assert.equal(newestRun([first, second, other], "nope"), undefined)
  assert.equal(newestRun([{ ...first, id: "x", updatedAt: 150 }, first], "S1").id, "x")
  assert.equal(nodeForSession(first, "C1").id, "lint")
  assert.equal(nodeForSession(first, "S1"), undefined)
})

test("store keeps only strictly newer revisions and notifies subscribers", () => {
  const store = createRunStore()
  const seen = []
  const stop = store.subscribe(() => seen.push(store.all().length))
  assert.equal(store.ingest({ ...diamond(), revision: 3, name: "three" }), true)
  assert.equal(store.ingest({ ...diamond(), revision: 2, name: "two" }), false)
  assert.equal(store.ingest({ ...diamond(), revision: 3, name: "again" }), false)
  assert.equal(store.ingest({ ...diamond(), revision: 4, name: "four" }), true)
  assert.equal(store.newest("S1").name, "four")
  assert.deepEqual(seen, [1, 1])
  assert.equal(isNewerRevision(undefined, { revision: 0 }), true)
  assert.equal(isNewerRevision({ revision: 1 }, { revision: 1 }), false)
  stop()
  store.ingest({ ...diamond(), revision: 9 })
  assert.deepEqual(seen, [1, 1])
})

test("store prunes the oldest finished runs and never a running one", () => {
  const store = createRunStore({ maxRuns: 3 })
  store.ingest(diamond({ id: "old-running", createdAt: 1 }))
  for (let index = 2; index <= 6; index++) store.ingest(diamond({ id: `done-${index}`, status: "completed", createdAt: index }))
  const ids = store.all().map((item) => item.id).sort()
  assert.deepEqual(ids, ["done-5", "done-6", "old-running"])
  assert.equal(MAX_KEPT_RUNS, 24)
})

test("per-session ui state patches only on change and can be silent", () => {
  const store = createRunStore()
  let notified = 0
  store.subscribe(() => notified++)
  assert.equal(store.ui("S1").interacted, false)
  assert.equal(store.patchUi("S1", { interacted: false }), false)
  assert.equal(notified, 0)
  assert.equal(store.patchUi("S1", { interacted: true, opened: "auto" }), true)
  assert.equal(notified, 1)
  assert.equal(store.patchUi("S1", { opened: "manual" }, { silent: true }), true)
  assert.equal(notified, 1)
  assert.deepEqual({ ...store.ui("S1") }, {
    dismissedRunId: undefined,
    opened: "manual",
    interacted: true,
    selectedRunId: undefined,
    selectedNodeId: undefined,
  })
  assert.equal(store.ui("S2").opened, undefined)
  store.dispose()
  assert.equal(store.all().length, 0)
})

test("selection walks layers in order, clamps, and prefers the viewed child node", () => {
  const subject = diamond()
  subject.nodes[2].sessionID = "C2"
  assert.deepEqual(selectionOrder(subject), ["plan", "lint", "test", "ship"])
  assert.equal(moveSelection(subject, "plan", 1), "lint")
  assert.equal(moveSelection(subject, "ship", 1), "ship")
  assert.equal(moveSelection(subject, "plan", -1), "plan")
  assert.equal(moveSelection(subject, undefined, 1), "plan")
  assert.equal(moveSelection(subject, undefined, -1), "ship")
  assert.equal(moveSelection(run([]), "x", 1), undefined)

  assert.equal(defaultSelection(subject, "C2"), "test")
  assert.equal(defaultSelection(subject, "S1"), "lint")
  assert.equal(defaultSelection({ ...subject, nodes: subject.nodes.map((item) => ({ ...item, state: item.state === "running" ? "completed" : item.state })) }, "S1"), "test")
  assert.equal(defaultSelection(run([node("a", "completed"), node("b", "completed", ["a"])]), "S1"), "a")
  assert.equal(defaultSelection(run([]), "S1"), undefined)
})

test("a moved selection sticks to its run only", () => {
  const subject = diamond()
  const ui = { selectedRunId: "r1", selectedNodeId: "ship" }
  assert.equal(resolveSelection(subject, ui, "S1"), "ship")
  assert.equal(resolveSelection({ ...subject, id: "r2" }, ui, "S1"), "lint")
  assert.equal(resolveSelection(subject, { selectedRunId: "r1", selectedNodeId: "gone" }, "S1"), "lint")
  assert.equal(resolveSelection(undefined, ui, "S1"), undefined)
})

test("terminal plugin mounts the session panel and composer strip, never the sidebar", () => {
  assert.equal(TUI_SOURCE.split("\n")[0], "/** @jsxImportSource @opentui/solid */")
  assert.equal(TUI_SOURCE.split("\n")[1], "// tui.tsx")
  assert.match(TUI_SOURCE, /Plugin\.define\(\{\s*id: "questline\.tui"/)
  assert.match(TUI_SOURCE, /append: "session\.panel"/)
  assert.match(TUI_SOURCE, /append: "session\.composer\.top"/)
  assert.match(TUI_SOURCE, /append: "app"/)
  assert.match(TUI_SOURCE, /panel\.name === PANEL/)
  assert.doesNotMatch(TUI_SOURCE, /sidebar\.(content|footer)/)
  assert.doesNotMatch(TUI_SOURCE, /context\.ui\.panel\.open\([^)]*presentation/)
})

test("terminal plugin binds leader d, a palette command and the dag slash command", () => {
  assert.match(TUI_SOURCE, /bind: "<leader>d"/)
  assert.match(TUI_SOURCE, /title: "Toggle DAG panel"/)
  assert.match(TUI_SOURCE, /palette: true/)
  assert.match(TUI_SOURCE, /slash: \{ name: "dag" \}/)
  assert.match(TUI_SOURCE, /"No DAG in this session"/)
})

test("terminal plugin keys are scoped to the focused panel", () => {
  assert.match(TUI_SOURCE, /enabled: \(\) => props\.panel\.focused/)
  for (const [bind, id] of [["j", "next"], ["down", "next.arrow"], ["k", "prev"], ["up", "prev.arrow"], ["return", "open"], ["c", "cancel"], ["r", "retry"], ["q", "close"], ["escape", "close.escape"]]) {
    assert.match(TUI_SOURCE, new RegExp(`id: \`\\$\\{PANEL\\}\\.panel\\.${id.replace(".", "\\.")}\`[^\\n]*bind: "${bind}"`))
  }
  assert.match(TUI_SOURCE, /dialog\.confirm\(/)
  assert.match(TUI_SOURCE, /router\.navigate\(\{ type: "session", sessionID: target \}\)/)
})

test("terminal plugin uses the fixed RPC contract and recovers on route change and reconnect", () => {
  assert.match(TUI_SOURCE, /from "\.\/rpc\.ts"/)
  assert.match(RPC_SOURCE, /id: "questline\.dag"/)
  for (const method of ["snapshot", "cancel", "retry"]) {
    assert.match(RPC_SOURCE, new RegExp(`\\b${method}: \\{`))
    assert.match(TUI_SOURCE, new RegExp(`rpc\\.${method}\\(`))
  }
  assert.match(TUI_SOURCE, /rpc\.events\.on\("updated"/)
  assert.match(TUI_SOURCE, /context\.data\.on\("server\.connected"/)
  assert.match(TUI_SOURCE, /on\(ctl\.routed,/)
  assert.match(TUI_SOURCE, /rpc\.snapshot\(\{ sessionID \}/)
  assert.match(TUI_SOURCE, /context\.client\.rpc\(AgentDag/)
})

test("terminal plugin hands focus back, guards RPC failures, and tears everything down", () => {
  assert.match(TUI_SOURCE, /dispatch\("pane\.focus\.left"\)/)
  assert.match(TUI_SOURCE, /if \(disposed \|\| warned\) return/)
  const teardown = TUI_SOURCE.slice(TUI_SOURCE.lastIndexOf("return () => {"))
  assert.match(teardown, /for \(const remove of removers\) remove\(\)/)
  assert.match(teardown, /ctl\.dispose\(\)/)
  const dispose = TUI_SOURCE.slice(TUI_SOURCE.indexOf("function dispose()"))
  for (const stop of ["cancelClose()", "stopEvents()", "stopConnected()", "stopStore()", "store.dispose()"]) {
    assert.ok(dispose.slice(0, 400).includes(stop), stop)
  }
})

test("terminal plugin takes decisions from the pure helpers and uses theme tokens", () => {
  assert.match(TUI_SOURCE, /from "\.\/panel-state\.mjs"/)
  assert.match(TUI_SOURCE, /from "\.\/layout\.mjs"/)
  assert.match(TUI_SOURCE, /shouldAutoOpen\(/)
  assert.match(TUI_SOURCE, /shouldAutoClose\(/)
  assert.match(TUI_SOURCE, /theme\.text\.feedback\.error\.base/)
  assert.match(TUI_SOURCE, /theme\.text\.muted/)
  assert.doesNotMatch(TUI_SOURCE, /theme\.text\.subdued|theme\.text\.default|chezmoi/)
})
