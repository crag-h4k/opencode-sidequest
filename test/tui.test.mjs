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
  PREREQUISITE_GLYPH,
  modelLabel,
  renderDetail,
  renderEdges,
  renderGraph,
  renderHeader,
  renderHelp,
  renderHints,
  renderRuns,
  renderSessionPage,
  renderStepHeader,
  renderStrip,
  renderTranscript,
  renderViewTabs,
  wrapText,
} from "../layout.mjs"
import {
  AUTO_CLOSE_GRACE_MS,
  MAX_KEPT_RUNS,
  availableViews,
  canCancel,
  canRetry,
  canSplit,
  contextUsage,
  createRunStore,
  cycleView,
  defaultSelection,
  focusAction,
  includesSession,
  isNewerRevision,
  moveSelection,
  navigate,
  newestRun,
  nodeForSession,
  originTarget,
  resolveKey,
  resolveSelection,
  resolveView,
  runsOf,
  selectionOrder,
  shouldAutoClose,
  shouldAutoOpen,
  shownRun,
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

test("node boxes carry marker, label, state line, model and dependency line", () => {
  const frame = texts(renderGraph(diamond(), { width: 80, selectedId: "lint", now: NOW }))
  const joined = frame.join("\n")
  assert.match(joined, /┃ >▾ lint/)
  assert.match(joined, /│ {2}▸ plan/)
  assert.match(joined, /✓ completed 30s/)
  assert.match(joined, /● running reading/)
  assert.match(joined, /× failed 3 tests/)
  assert.match(joined, /after ✓ plan/)
  assert.match(joined, /after ● lint × test/)
  assert.match(joined, /no deps/)
  assert.doesNotMatch(joined, /←/)
  assert.match(joined, /◇ default model/)
})

test("a dependency row shows each prerequisite with its own state glyph, in that state's role", () => {
  const nodes = [
    node("a", "completed"),
    node("b", "failed"),
    node("c", "running"),
    node("d", "skipped"),
    node("join", "pending", ["a", "b", "c", "d"]),
  ]
  const lines = renderGraph(run(nodes), { width: 120, now: NOW })
  const joinRow = lines.find((line) => lineText(line).includes("after"))
  const glyphRole = (glyph) => joinRow.find((part) => part.text === glyph)?.role
  assert.equal(glyphRole("✓"), "success")
  assert.equal(glyphRole("×"), "error")
  assert.equal(glyphRole("●"), "info")
  assert.equal(glyphRole("·"), "warning")
})

test("a prerequisite that is not met yet is an empty box, not the step's circle", () => {
  assert.equal(PREREQUISITE_GLYPH.pending, "□")
  assert.equal(PREREQUISITE_GLYPH.completed, STATE_GLYPH.completed)
  assert.equal(PREREQUISITE_GLYPH.running, STATE_GLYPH.running)
  assert.equal(PREREQUISITE_GLYPH.failed, STATE_GLYPH.failed)
  const nodes = [node("a", "completed"), node("b", "pending"), node("join", "pending", ["a", "b"])]
  const frame = texts(renderGraph(run(nodes), { width: 120, now: NOW })).join("\n")
  assert.match(frame, /after ✓ a □ b/)
  const joinRow = renderGraph(run(nodes), { width: 120, now: NOW }).find((line) => lineText(line).includes("after"))
  assert.equal(joinRow.find((part) => part.text === "□").role, "muted")
  assert.match(frame, /○ pending/, "a pending step itself still uses the circle")
})

test("each box names the model the step was asked to use, or says it uses the host default", () => {
  assert.equal(modelLabel(undefined), "default model")
  assert.equal(modelLabel("github-copilot/gpt-6-luna", 40), "github-copilot/gpt-6-luna")
  assert.equal(modelLabel("github-copilot/gpt-6-luna", 12), "gpt-6-luna")
  assert.equal(modelLabel("gpt-6-luna#high", 4), "gpt-6-luna#high")
  const nodes = [
    node("plan", "completed", [], { model: "github-copilot/gpt-6-luna" }),
    node("next", "pending", ["plan"]),
  ]
  const frame = texts(renderGraph(run(nodes), { width: 80, now: NOW })).join("\n")
  assert.match(frame, /◇ github-copilot\/gpt-6-luna/)
  assert.match(frame, /◇ default model/)
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
    assert.equal(end - start, 6)
    assert.ok(end <= lines.length)
  }
  assert.match(texts(lines.slice(ranges["task-22"].start, ranges["task-22"].end)).join("\n"), /┃ >▾ task-22/)
  const root = ranges.root
  const first = ranges["task-0"]
  assert.ok(root.end <= first.start)
})

// Spatial navigation over the drawn graph.
const wideGrid = () =>
  graphLayout(
    run([
      node("root", "completed"),
      node("a", "pending", ["root"]),
      node("b", "pending", ["root"]),
      node("c", "pending", ["root"]),
      node("join", "pending", ["a", "b", "c"]),
    ]),
    { width: 120, now: NOW },
  )

test("left and right step along a row of boxes and stop at its ends", () => {
  const layout = wideGrid()
  assert.equal(layout.ranges.a.start, layout.ranges.b.start)
  assert.equal(navigate(layout, "a", "right"), "b")
  assert.equal(navigate(layout, "b", "right"), "c")
  assert.equal(navigate(layout, "c", "right"), "c")
  assert.equal(navigate(layout, "c", "left"), "b")
  assert.equal(navigate(layout, "a", "left"), "a")
  assert.equal(navigate(layout, "root", "left"), "root")
  assert.equal(navigate(layout, "root", "right"), "root")
})

test("up and down move to the nearest box in the adjacent row", () => {
  const layout = wideGrid()
  assert.equal(navigate(layout, "root", "down"), "b")
  assert.equal(navigate(layout, "a", "down"), "join")
  assert.equal(navigate(layout, "c", "down"), "join")
  assert.equal(navigate(layout, "join", "up"), "b")
  assert.equal(navigate(layout, "b", "up"), "root")
  assert.equal(navigate(layout, "root", "up"), "root")
  assert.equal(navigate(layout, "join", "down"), "join")
})

test("every node is reachable using only the four directions", () => {
  const layout = graphLayout(fanOut(24), { width: 120, now: NOW })
  const seen = new Set()
  const queue = [navigate(layout, undefined, "down")]
  while (queue.length) {
    const id = queue.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const direction of ["up", "down", "left", "right"]) queue.push(navigate(layout, id, direction))
  }
  assert.equal(seen.size, 24)
})

test("in a single column up and down are previous and next and left and right do nothing", () => {
  const layout = graphLayout(diamond(), { width: 40, now: NOW })
  const order = Object.keys(layout.ranges).sort((a, b) => layout.ranges[a].start - layout.ranges[b].start)
  for (let index = 0; index < order.length; index++) {
    assert.equal(navigate(layout, order[index], "down"), order[Math.min(order.length - 1, index + 1)])
    assert.equal(navigate(layout, order[index], "up"), order[Math.max(0, index - 1)])
    assert.equal(navigate(layout, order[index], "left"), order[index])
    assert.equal(navigate(layout, order[index], "right"), order[index])
  }
})

test("navigation falls back to the first box with no selection and to nothing for an empty graph", () => {
  const layout = wideGrid()
  assert.equal(navigate(layout, undefined, "right"), "root")
  assert.equal(navigate(layout, "ghost", "down"), "root")
  assert.equal(navigate(undefined, "a", "down"), undefined)
  assert.equal(navigate(graphLayout(run([]), { width: 80 }), undefined, "down"), undefined)
})

test("the layout reports each box's center and keeps boxes within the width", () => {
  for (const width of [40, 60, 80, 120]) {
    const layout = graphLayout(run([node("root", "completed"), node("a", "pending", ["root"]), node("b", "pending", ["root"])]), { width, now: NOW })
    assert.deepEqual(Object.keys(layout.centers).sort(), ["a", "b", "root"])
    for (const center of Object.values(layout.centers)) assert.ok(center >= 0 && center < width, `${center} within ${width}`)
    assert.ok(widest(layout.lines) <= width)
  }
})

test("the strip names the way back only inside a step's session, and drops it first when narrow", () => {
  const running = diamond()
  const withHint = lineText(renderStrip(running, { now: NOW, panelHint: "ctrl+g p", originHint: "ctrl+x k origin" }))
  assert.match(withHint, /ctrl\+g p panel {2}ctrl\+x k origin$/)
  assert.match(lineText(renderStrip(running, { now: NOW, panelHint: "ctrl+g p", originHint: "/dag-origin" })), /\/dag-origin$/)
  assert.doesNotMatch(lineText(renderStrip(running, { now: NOW, panelHint: "ctrl+g p" })), /origin/)
  const full = lineWidth(renderStrip(running, { now: NOW, panelHint: "ctrl+g p", originHint: "ctrl+x k origin" }))
  const narrower = renderStrip(running, { now: NOW, panelHint: "ctrl+g p", originHint: "ctrl+x k origin", width: full - 1 })
  assert.doesNotMatch(lineText(narrower), /origin|panel/)
  assert.ok(lineWidth(narrower) <= full - 1)
  assert.equal(renderStrip({ ...running, status: "completed" }, { now: NOW, originHint: "/dag-origin" }), null)
})

test("back to the origin goes to the run's origin session from a step, and says why otherwise", () => {
  const r = run([node("a", "running", [], { sessionID: "STEP-A" }), node("b", "pending")])
  assert.deepEqual(originTarget(r, "STEP-A"), { kind: "go", sessionID: "S1" })
  assert.deepEqual(originTarget(r, "S1"), { kind: "here" })
  assert.deepEqual(originTarget(r, "elsewhere"), { kind: "none" })
  assert.deepEqual(originTarget(undefined, "S1"), { kind: "none" })
  assert.deepEqual(originTarget(r, undefined), { kind: "none" })
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
  const strip = renderStrip(diamond(), { now: NOW, panelHint: "ctrl+g p" })
  assert.equal(lineText(strip), "dag release  1● 1/4 ✓  1×  1m 30s   ctrl+g p panel")
  assert.deepEqual(strip.map((item) => item.role), ["muted", "accent", "default", "info", "default", "success", "error", "muted", "muted"])
  assert.equal(lineText(renderStrip(run([node("a", "running"), node("b")]), { now: NOW })), "dag release  1● 0/2 ✓  1m 30s", "no key, no hint")
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(renderStrip(diamond({ status }), { now: NOW }), null)
  assert.equal(renderStrip(undefined, { now: NOW }), null)
})

test("strip drops the hint, then truncates the name, to fit", () => {
  const long = diamond({ name: "a-very-long-release-pipeline-name" })
  const full = lineText(renderStrip(long, { now: NOW, panelHint: "ctrl+g p" }))
  assert.match(full, /panel$/)
  const noHint = lineText(renderStrip(long, { now: NOW, panelHint: "ctrl+g p", width: full.length - 3 }))
  assert.doesNotMatch(noHint, /panel/)
  assert.match(noHint, /a-very-long-release-pipeline-name/)
  for (const width of [1, 4, 10, 20, 30, 45, 80]) {
    const line = renderStrip(long, { now: NOW, panelHint: "ctrl+g p", width })
    assert.ok(lineWidth(line) <= width, `strip at ${width}`)
  }
  const squeezed = lineText(renderStrip(long, { now: NOW, panelHint: "ctrl+g p", width: 30 }))
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

const KEYS = { toggle: "ctrl+x b", focus: "ctrl+g" }
const hintText = (options) => texts(renderHints({ keys: KEYS, ...options }))
const FOCUSED = { view: "graph", running: true, canOpen: true, canCycle: true, focused: true, width: 240 }

test("the focused graph footer lists the plain keys, the action for the run's state, and the way back", () => {
  const running = hintText(FOCUSED)
  assert.equal(running.length, 1)
  assert.equal(
    running[0],
    "hjkl ←↓↑→ move   enter open step   c cancel run   y o change page   f fullscreen   q close   ctrl+g session",
  )
  const finished = hintText({ ...FOCUSED, running: false }).join(" ")
  assert.match(finished, /r retry/)
  assert.doesNotMatch(finished, /cancel/)
  const noSession = hintText({ ...FOCUSED, canOpen: false }).join(" ")
  assert.doesNotMatch(noSession, /open step/)
  const onePage = hintText({ ...FOCUSED, canCycle: false }).join(" ")
  assert.doesNotMatch(onePage, /change page/)
  for (const frame of [running.join(" "), finished, noSession, onePage]) assert.doesNotMatch(frame, /<leader>/)
})

test("each page has its own footer keys", () => {
  const runs = hintText({ view: "runs", canCycle: true, focused: true, width: 240 }).join(" ")
  assert.match(runs, /jk ↑↓ move/)
  assert.match(runs, /enter show run/)
  assert.doesNotMatch(runs, /cancel|retry|open step/)
  for (const view of ["session", "help"]) {
    const frame = hintText({ view, canCycle: true, focused: true, width: 240 }).join(" ")
    assert.match(frame, /jk ↑↓ scroll/)
    assert.doesNotMatch(frame, /enter|cancel|retry/)
  }
  for (const view of ["session", "runs", "help"]) {
    const frame = hintText({ view, canCycle: true, focused: true, width: 240 }).join(" ")
    assert.match(frame, /y o change page/)
    assert.match(frame, /f fullscreen/)
  }
})

test("a panel without the cursor says how to take it and offers only the toggle key", () => {
  const [line] = hintText({ ...FOCUSED, focused: false })
  assert.equal(line, "click or ctrl+g to focus   ctrl+x b close panel")
  assert.doesNotMatch(line, /hjkl|y o|cancel|retry|fullscreen/, "plain keys only work with the cursor")
  assert.equal(hintText({ focused: false, keys: {}, width: 80 })[0], "click to focus")
  assert.equal(hintText({ ...FOCUSED, keys: {}, width: 80 }).join(" ").includes("ctrl+"), false, "no key, no chip")
})

test("a key the host did not register is left out of the footer", () => {
  const frame = texts(renderHints({ ...FOCUSED, keys: { toggle: "ctrl+x b" } })).join(" ")
  assert.match(frame, /q close/)
  assert.doesNotMatch(frame, /ctrl\+g|session$/)
  const unfocused = texts(renderHints({ ...FOCUSED, focused: false, keys: { focus: "ctrl+g" } })).join(" ")
  assert.equal(unfocused, "click or ctrl+g to focus")
})

test("the footer wraps whole key-and-label chips, never splitting a key from its label", () => {
  const chips = ["hjkl ←↓↑→ move", "enter open step", "c cancel run", "y o change page", "f fullscreen", "q close", "ctrl+g session"]
  for (let width = 22; width <= 160; width++) {
    const lines = hintText({ ...FOCUSED, width, maxLines: 12 })
    for (const line of lines) assert.ok(displayWidth(line) <= width, `${width}: "${line}"`)
    for (const chip of chips) {
      const holders = lines.filter((line) => line.includes(chip))
      assert.equal(holders.length, 1, `${width}: "${chip}" must sit whole on exactly one line`)
    }
  }
  const unfocused = ["click or ctrl+g to focus", "ctrl+x b close panel"]
  for (let width = 26; width <= 160; width++) {
    const lines = hintText({ ...FOCUSED, focused: false, width, maxLines: 12 })
    for (const line of lines) assert.ok(displayWidth(line) <= width, `${width}: "${line}"`)
    for (const chip of unfocused) assert.equal(lines.filter((line) => line.includes(chip)).length, 1, `${width}: "${chip}"`)
  }
  assert.ok(hintText({ ...FOCUSED, width: 38, maxLines: 12 }).length > hintText({ ...FOCUSED, width: 160, maxLines: 12 }).length)
})

test("a step's footer offers reading, messaging and its own session, and typing narrows it to send and stop", () => {
  const reading = hintText({ ...FOCUSED, step: true }).join(" ")
  assert.equal(reading, "jk ↑↓ scroll   i message   g open session   esc back   q close   ctrl+g session")
  assert.doesNotMatch(reading, /cancel|retry|change page/, "run actions belong to the graph")
  const typing = hintText({ ...FOCUSED, step: true, typing: true }).join(" ")
  assert.equal(typing, "enter send   esc stop typing")
  assert.doesNotMatch(typing, /q close|i message/, "plain keys type while a message is open")
})

test("a step's header names it, its state and time, the model it was given, and what failed", () => {
  const done = node("s2", "completed", [], { startedAt: NOW - 4_000, finishedAt: NOW, model: "github-copilot/gpt-6-luna" })
  assert.deepEqual(texts(renderStepHeader(done, { width: 60, now: NOW })), ["s2  ✓ completed  4s", "◇ github-copilot/gpt-6-luna"])
  const failed = node("s3", "failed", [], { attempt: 2, error: "model call timed out" })
  const lines = texts(renderStepHeader(failed, { width: 60, now: NOW }))
  assert.equal(lines[0], "s3  × failed  attempt 2")
  assert.equal(lines[1], "◇ default model")
  assert.match(lines[2], /^error +model call timed out$/)
  assert.deepEqual(renderStepHeader(undefined), [])
  for (const width of WIDTHS) for (const line of renderStepHeader(failed, { width, now: NOW })) assert.ok(lineWidth(line) <= width, `${width}`)
})

test("a step's transcript shows what it was asked, what it said, and the tools it ran", () => {
  const messages = [
    { type: "user", text: "Reply with only your id." },
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "tool", name: "shell", state: { status: "completed", input: { command: "ls -la" } } },
        { type: "tool", name: "read", state: { status: "error", input: { filePath: "/nope" }, error: { message: "not found" } } },
        { type: "tool", name: "grep", state: { status: "running", input: { pattern: "dag" } } },
        { type: "text", text: "s1" },
      ],
    },
    { type: "synthetic", text: "The previous response was interrupted." },
    { type: "user", text: "ping" },
    { type: "assistant", content: [{ type: "text", text: "pong" }], error: { message: "rate limited" } },
  ]
  assert.deepEqual(texts(renderTranscript(messages, { width: 60 })), [
    "› Reply with only your id.",
    "",
    "· thinking",
    "▸ shell ✓ ls -la",
    "▸ read × /nope",
    "  not found",
    "▸ grep … dag",
    "s1",
    "",
    "The previous response was interrupted.",
    "",
    "› ping",
    "",
    "pong",
    "rate limited",
  ])
  assert.doesNotMatch(texts(renderTranscript(messages, { width: 60 })).join("\n"), /hidden/, "reasoning text stays out")
  assert.deepEqual(renderTranscript(undefined), [])
})

test("a long transcript keeps its newest lines and wraps inside the panel", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ type: "user", text: `message ${index}` }))
  const kept = texts(renderTranscript(messages, { width: 40, maxLines: 5 }))
  assert.equal(kept.length, 5)
  assert.equal(kept.at(-1), "› message 29")
  const long = [{ type: "assistant", content: [{ type: "text", text: "word ".repeat(40) }] }]
  for (const width of WIDTHS) for (const line of renderTranscript(long, { width })) assert.ok(lineWidth(line) <= width, `${width}`)
  const wrapped = texts(renderTranscript([{ type: "user", text: "word ".repeat(12) }], { width: 20 }))
  assert.ok(wrapped.length > 1)
  assert.ok(wrapped.slice(1).every((line) => line.startsWith("  ")), "a wrapped message lines up under its marker")
})

test("the footer is capped, and a width too small for any chip still never overflows", () => {
  assert.ok(hintText({ ...FOCUSED, width: 20, maxLines: 2 }).length <= 2)
  for (const width of [1, 3, 6, 12]) {
    for (const line of renderHints({ ...FOCUSED, keys: KEYS, width })) assert.ok(lineWidth(line) <= width)
  }
})

test("keys are shown in the accent role and labels in the muted role", () => {
  const [line] = renderHints({ ...FOCUSED, focused: false, keys: KEYS })
  assert.equal(line.find((part) => part.text === "ctrl+x b")?.role, "accent")
  assert.equal(line.find((part) => part.text === " close panel")?.role, "muted")
})

const SERVERS = [
  { name: "aws-documentation", status: { status: "connected" } },
  { name: "aws-iam-policy-autopilot", status: { status: "connected" } },
  { name: "databricks-genie", status: { status: "disabled" } },
  { name: "wiz", status: { status: "needs_auth" } },
  { name: "broken", status: { status: "failed" } },
  { name: "starting", status: { status: "pending" } },
]

test("the session page shows OpenCode's title, context use and MCP servers the way its sidebar does", () => {
  const page = renderSessionPage({
    title: "Resolving issues and adding DAGs in OC2",
    usage: { tokens: 428787, percent: 43 },
    cost: 39.25,
    servers: SERVERS,
    width: 37,
  })
  assert.deepEqual(texts(page.top), ["Resolving issues and adding DAGs in", "OC2", "", "Context", "428,787 tokens", "43% used", "$39.25 spent"])
  assert.equal(lineText(page.mcpTitle), "▼ MCP")
  assert.equal(page.mcpRows.length, 6)
  const row = (name, label) => `• ${name}`.padEnd(37 - label.length) + label
  assert.equal(lineText(page.mcpRows[0]), row("aws-documentation", "Connected"))
  assert.equal(lineText(page.mcpRows[2]), row("databricks-genie", "Disabled"))
  assert.equal(lineText(page.mcpRows[3]), row("wiz", "Sign in"))
  assert.equal(lineText(page.mcpRows[4]), row("broken", "Error"))
  assert.equal(lineText(page.mcpRows[5]), row("starting", "Connecting"))
  assert.equal(lineText(page.mcpRows[0]), "• aws-documentation         Connected")
  const dots = page.mcpRows.map((row) => row[0].role)
  assert.deepEqual(dots, ["success", "success", "muted", "warning", "error", "muted"])
  assert.equal(page.mcpRows[4].at(-1).role, "error", "a failed server says so in the error color")
})

test("the session page omits what it does not have and collapses more than two servers", () => {
  assert.deepEqual(texts(renderSessionPage({ width: 37 }).top), [])
  assert.equal(renderSessionPage({ width: 37 }).mcpTitle, undefined)
  assert.deepEqual(texts(renderSessionPage({ title: "T", usage: { tokens: 5 }, width: 37 }).top), ["T", "", "Context", "5 tokens"])
  assert.deepEqual(texts(renderSessionPage({ cost: 0.01, width: 37 }).top), ["Context", "$0.01 spent"])
  assert.deepEqual(texts(renderSessionPage({ usage: { tokens: 5 }, cost: 0, width: 37 }).top), ["Context", "5 tokens"])
  const closed = renderSessionPage({ servers: SERVERS, expanded: false, width: 37 })
  assert.equal(lineText(closed.mcpTitle), "▶ MCP (2 active, 2 errors)")
  assert.deepEqual(closed.mcpRows, [])
  const two = renderSessionPage({ servers: SERVERS.slice(0, 2), expanded: false, width: 37 })
  assert.equal(lineText(two.mcpTitle), "MCP", "one or two servers never collapse")
  assert.equal(two.mcpRows.length, 2)
  const one = renderSessionPage({ servers: [SERVERS[4]], expanded: false, width: 37 })
  assert.equal(lineText(one.mcpTitle), "MCP")
})

test("the session page fits every width and keeps a status label whole while shortening the name", () => {
  for (let width = 1; width <= 120; width++) {
    const page = renderSessionPage({ title: "A long session title that needs to wrap over several lines of the panel", usage: { tokens: 1, percent: 1 }, cost: 1, servers: SERVERS, width })
    for (const line of [...page.top, page.mcpTitle, ...page.mcpRows]) assert.ok(lineWidth(line) <= width, `${width}`)
  }
  const narrow = renderSessionPage({ servers: [{ name: "a-very-long-server-name", status: { status: "connected" } }], width: 24 })
  assert.match(lineText(narrow.mcpRows[0]), /^• a-very-long.*… Connected$|^• a-very.*Connected$/)
  assert.ok(lineText(narrow.mcpRows[0]).endsWith("Connected"))
})

test("context use is the latest assistant step after the last compaction and before a revert", () => {
  const step = (id, tokens, model = { providerID: "p", id: "m" }) => ({
    id,
    type: "assistant",
    model,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const models = [{ providerID: "p", id: "m", limit: { context: 1000 } }]
  const messages = [{ id: "u1", type: "user" }, step("a1", 100), { id: "u2", type: "user" }, step("a2", 250)]
  assert.deepEqual(contextUsage(messages, models), { tokens: 250, percent: 25 })
  assert.deepEqual(contextUsage(messages, models, "a2"), { tokens: 100, percent: 10 }, "stops before the revert boundary")
  assert.equal(contextUsage(messages, models, "gone"), undefined)
  const compacted = [...messages, { id: "c", type: "compaction", status: "completed" }]
  assert.equal(contextUsage(compacted, models), undefined, "nothing counts after a compaction until a new step")
  assert.deepEqual(contextUsage([...compacted, step("a3", 40)], models), { tokens: 40, percent: 4 })
  const pending = [...messages, { id: "c", type: "compaction", status: "running" }]
  assert.deepEqual(contextUsage(pending, models), { tokens: 250, percent: 25 }, "an unfinished compaction does not reset it")
  assert.deepEqual(contextUsage(messages, []), { tokens: 250, percent: undefined }, "no known model limit, no percent")
  assert.deepEqual(contextUsage(messages, undefined), { tokens: 250, percent: undefined })
  assert.equal(contextUsage([{ id: "a", type: "assistant", model: {}, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }], models), undefined)
  assert.equal(contextUsage(undefined, models), undefined)
  const cached = { id: "a", type: "assistant", model: { providerID: "p", id: "m" }, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }
  assert.equal(contextUsage([cached], models).tokens, 15, "input, output, reasoning and both cache counts")
})

test("a key is the host's first formatted shortcut, and absent when the host has none", () => {
  const host = (table) => (id) => table[id]
  assert.equal(resolveKey(host({ "q.focus": ["ctrl+g"] }), "q.focus"), "ctrl+g")
  assert.equal(resolveKey(host({ "q.focus": ["ctrl+g", "alt+g"] }), "q.focus"), "ctrl+g")
  assert.equal(resolveKey(host({ "q.focus": [] }), "q.focus"), undefined)
  assert.equal(resolveKey(host({}), "q.focus"), undefined)
  assert.equal(resolveKey(() => undefined, "q.focus"), undefined)
})

test("terminal plugin takes every displayed key from the host's formatted shortcuts, with no fallback text", () => {
  assert.match(TUI_SOURCE, /function resolveKey\(context: Context, id: string\): string \| undefined/)
  assert.match(TUI_SOURCE, /resolveHostKey\(\(key\) => context\.keymap\.shortcuts\(key\), id\)/)
  assert.match(TUI_SOURCE, /toggle: resolveKey\(context, PANEL_TOGGLE\), focus: resolveKey\(context, FOCUS\), origin: resolveKey\(context, ORIGIN\)/)
  assert.match(TUI_SOURCE, /panelHint: resolveKey\(context, FOCUS\)/)
  assert.doesNotMatch(TUI_SOURCE, /FALLBACK|LEADER_PROBES/, "no hard-coded key text to fall back on")
  assert.match(TUI_SOURCE, /<Lines lines=\{hints\(\)\} \/>/)
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
    ...renderHints({ ...FOCUSED, keys: KEYS }),
    ...renderHints({ ...FOCUSED, focused: false, keys: KEYS }),
    ...renderSessionPage({ title: "T", usage: { tokens: 1, percent: 2 }, cost: 1, servers: SERVERS, width: 40 }).top,
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
    view: undefined,
    shownRunId: undefined,
    runCursor: undefined,
    stepId: undefined,
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

test("terminal plugin mounts the side panel and the composer strip, never the host sidebar", () => {
  assert.equal(TUI_SOURCE.split("\n")[0], "/** @jsxImportSource @opentui/solid */")
  assert.equal(TUI_SOURCE.split("\n")[1], "// tui.tsx")
  assert.match(TUI_SOURCE, /Plugin\.define\(\{\s*id: "sidequest\.tui"/)
  assert.match(TUI_SOURCE, /append: "session\.panel"/)
  assert.match(TUI_SOURCE, /panel\.name === PANEL/)
  assert.match(TUI_SOURCE, /append: "session\.composer\.top"/)
  assert.match(TUI_SOURCE, /append: "app"/)
  assert.doesNotMatch(TUI_SOURCE, /sidebar\.(content|footer)/, "OpenCode's sidebar has a fixed width, but its panel can be dragged")
  assert.doesNotMatch(TUI_SOURCE, /context\.ui\.panel\.open\([^)]*presentation/)
})

test("terminal plugin keeps /dag on the palette, and binds the way back to the origin session to <leader>o", () => {
  assert.match(TUI_SOURCE, /id: GRAPH,[\s\S]*?bind: false/)
  assert.match(TUI_SOURCE, /title: "Show DAG graph"/)
  assert.match(TUI_SOURCE, /slash: \{ name: "dag" \}/)
  assert.match(TUI_SOURCE, /void ctl\.openGraph\(\)/)
  assert.match(TUI_SOURCE, /id: ORIGIN,[\s\S]*?bind: "<leader>o"/)
  assert.match(TUI_SOURCE, /slash: \{ name: "dag-origin" \}/)
  assert.match(TUI_SOURCE, /originTarget\(/)
  assert.match(TUI_SOURCE, /router\.navigate\(\{ type: "session", sessionID: target\.sessionID \}\)/)
  assert.match(TUI_SOURCE, /originHint: insideStep \? originCue\(context\) : undefined/)
  assert.match(TUI_SOURCE, /const key = resolveKey\(context, ORIGIN\)\s*return key \? `\$\{key\} origin` : "\/dag-origin"/)
  assert.doesNotMatch(TUI_SOURCE, /session\.parent/, "OpenCode's own parent command does not fire inside a step, so the plugin owns this key")
})

test("terminal plugin binds ctrl+g, <leader>b and <leader>o, and no spaced chord or other leader key", () => {
  assert.match(TUI_SOURCE, /id: PANEL_TOGGLE,[\s\S]*?bind: "<leader>b"/)
  assert.match(TUI_SOURCE, /slash: \{ name: "side-panel" \}/)
  assert.match(TUI_SOURCE, /id: FOCUS,[\s\S]*?bind: "ctrl\+g"/)
  assert.match(TUI_SOURCE, /void ctl\.toggle\(\)/)
  assert.match(TUI_SOURCE, /void ctl\.flip\(\)/)
  const bound = [...TUI_SOURCE.matchAll(/bind: "([^"]+)"/g)].map((match) => match[1])
  for (const key of bound) assert.doesNotMatch(key, /\s/, `"${key}": OpenCode's default parser rejects spaced chords`)
  assert.deepEqual(bound.filter((key) => key.includes("ctrl")), ["ctrl+g"], "the only modified key")
  // h, j, k, l and the arrows belong to OpenCode's session navigation; b takes over the sidebar toggle.
  assert.deepEqual(bound.filter((key) => key.startsWith("<leader>")).sort(), ["<leader>b", "<leader>o"])
})

test("terminal plugin keys are scoped to the focused panel, and typing a message turns the plain keys off", () => {
  assert.match(TUI_SOURCE, /enabled: \(\) => props\.panel\.focused && !typing\(\)/, "q, j or c typed into a message must not act")
  for (const [bind, id] of [
    ["j", "down"], ["down", "down.arrow"], ["k", "up"], ["up", "up.arrow"],
    ["h", "left"], ["left", "left.arrow"], ["l", "right"], ["right", "right.arrow"],
    ["return", "open"], ["y", "view.previous"], ["o", "view.next"], ["f", "fullscreen"], ["c", "cancel"], ["r", "retry"],
    ["i", "message"], ["g", "session"], ["q", "close"], ["escape", "close.escape"],
  ]) {
    assert.match(TUI_SOURCE, new RegExp(`id: \`\\$\\{PANEL\\}\\.panel\\.${id.replace(".", "\\.")}\`[^\\n]*bind: "${bind.replace(/[[\]]/g, "\\$&")}"`))
  }
  assert.match(TUI_SOURCE, /bind: "f", run: \(\) => props\.panel\.toggleFullscreen\(\)/)
  assert.match(TUI_SOURCE, /dialog\.confirm\(/)
  assert.match(TUI_SOURCE, /router\.navigate\(\{ type: "session", sessionID: target \}\)/)
})

test("esc sits in its own higher layer that stays on while typing, and backs out one level at a time", () => {
  assert.match(TUI_SOURCE, /priority: 30,\s*enabled: \(\) => props\.panel\.focused,\s*commands: \[\{ id: `\$\{PANEL\}\.panel\.close\.escape`[^\n]*bind: "escape", run: back \}\]/)
  assert.match(
    TUI_SOURCE,
    /if \(typing\(\)\) stopTyping\(\)\s*else if \(step\(\)\) ctl\.store\.patchUi\(sessionID\(\), \{ stepId: undefined \}\)\s*else ctl\.closeByUser\(sessionID\(\)\)/,
    "stop typing, then leave the step, then close",
  )
})

test("enter opens a step inside the panel, and a message goes to the step's session", () => {
  assert.match(TUI_SOURCE, /if \(step\(\)\) startTyping\(\)\s*else openStep\(\)/)
  assert.match(TUI_SOURCE, /ctl\.store\.patchUi\(sessionID\(\), \{ stepId: current\.id \}\)/)
  assert.match(TUI_SOURCE, /context\.client\.session\.prompt\(\{ sessionID: target, text \}\)/)
  assert.match(TUI_SOURCE, /setDraft\(text\)\s*ctl\.toast\(`Could not send: /, "a failed send keeps the draft")
  assert.match(TUI_SOURCE, /store\.patchUi\(sessionID, \{ view: next, stepId: undefined, interacted: true \}\)/, "changing page leaves the step")
})

test("every direction has both a letter and an arrow with the same effect", () => {
  for (const [letter, arrow, direction] of [["h", "left", "left"], ["j", "down", "down"], ["k", "up", "up"], ["l", "right", "right"]]) {
    for (const key of [letter, arrow]) {
      assert.match(TUI_SOURCE, new RegExp(`bind: "${key}", run: \\(\\) => move\\("${direction}"\\)`), `${key} moves ${direction}`)
    }
  }
})

test("the page keys step backward on y and forward on o, keys that sit well on a split ergonomic layout", () => {
  assert.match(TUI_SOURCE, /panel\.view\.previous`[^\n]*bind: "y", run: \(\) => ctl\.cycle\(-1\)/)
  assert.match(TUI_SOURCE, /panel\.view\.next`[^\n]*bind: "o", run: \(\) => ctl\.cycle\(1\)/)
  assert.doesNotMatch(TUI_SOURCE, /bind: "[\[\]]"/, "brackets are awkward on a Dactyl Manuform")
  assert.doesNotMatch(TUI_SOURCE, /bind: "p"/, "p was replaced by o")
})

test("the panel draws a light line on its left edge where the host's drag handle sits", () => {
  assert.match(TUI_SOURCE, /border=\{\["left"\]\}/)
  assert.match(TUI_SOURCE, /borderStyle="single"/)
  assert.match(TUI_SOURCE, /borderColor=\{context\.theme\.text\.base\}/, "the lightest theme color, not the dim border color")
  assert.match(TUI_SOURCE, /const width = \(\) => Math\.max\(10, props\.panel\.width - 3\)/, "one column for the line and one of padding on each side")
})

const runAt = (id, createdAt, extra = {}) =>
  run([node("a", "completed", [], { sessionID: `STEP-${id}` })], { id, name: id, createdAt, updatedAt: createdAt, ...extra })

test("a session's runs are listed newest first, whether it is their origin or one of their steps", () => {
  const [old, mid, fresh] = [runAt("old", 100), runAt("mid", 200), runAt("fresh", 300)]
  const other = runAt("other", 400, { sessionID: "S2" })
  const all = [old, fresh, other, mid]
  assert.deepEqual(runsOf(all, "S1").map((item) => item.id), ["fresh", "mid", "old"])
  assert.deepEqual(runsOf(all, "STEP-mid").map((item) => item.id), ["mid"])
  assert.deepEqual(runsOf(all, "elsewhere"), [])
  assert.equal(runsOf([old, mid, fresh], "S1")[0], newestRun([old, mid, fresh], "S1"))
  const [a, b] = [runAt("a", 100), runAt("b", 100)]
  assert.deepEqual(runsOf([a, b], "S1").map((item) => item.id), ["b", "a"])
})

test("which pages exist depends on how many runs the session has, and Session and Help always do", () => {
  assert.deepEqual(availableViews(0), ["session", "help"])
  assert.deepEqual(availableViews(1), ["session", "graph", "help"])
  assert.deepEqual(availableViews(2), ["session", "graph", "runs", "help"])
  assert.deepEqual(availableViews(9), ["session", "graph", "runs", "help"])
})

test("a picked page is kept while it still exists, else the first page, which is Session", () => {
  const all = availableViews(3)
  assert.equal(resolveView(all, "runs"), "runs")
  assert.equal(resolveView(all, undefined), "session")
  assert.equal(resolveView(availableViews(0), "graph"), "session")
  assert.equal(resolveView(availableViews(1), "runs"), "session")
})

test("cycling steps through every page, OpenCode's own included, in both directions and wraps around", () => {
  const all = availableViews(3)
  assert.deepEqual(all, ["session", "graph", "runs", "help"])
  assert.deepEqual(all.map((view) => cycleView(all, view, 1)), ["graph", "runs", "help", "session"])
  assert.deepEqual(all.map((view) => cycleView(all, view, -1)), ["help", "session", "graph", "runs"])
  assert.equal(cycleView(all, "gone", 1), "session")
  assert.equal(cycleView(["help"], "help", 1), "help")
  assert.equal(cycleView(["help"], "help", -1), "help")
  assert.equal(cycleView([], "graph", 1), undefined)
})

test("the graph shows the run chosen in the runs list while it exists, else the newest", () => {
  const [fresh, mid] = [runAt("fresh", 300), runAt("mid", 200)]
  assert.equal(shownRun([fresh, mid], { shownRunId: "mid" }), mid)
  assert.equal(shownRun([fresh, mid], { shownRunId: "gone" }), fresh)
  assert.equal(shownRun([fresh, mid], undefined), fresh)
  assert.equal(shownRun([], {}), undefined)
})

test("the focus key opens a closed panel, moves the cursor in, or gives it back", () => {
  assert.equal(focusAction({ shown: false, focused: false }), "open")
  assert.equal(focusAction({ shown: false, focused: true }), "open")
  assert.equal(focusAction({ shown: true, focused: false }), "focus")
  assert.equal(focusAction({ shown: true, focused: true }), "leave")
})

test("the view tabs bracket the current view, highlight it, and fit the panel", () => {
  const all = ["session", "graph", "runs", "help"]
  assert.equal(lineText(renderViewTabs(all, "runs", { width: 40 })), "Session  Graph  [Runs]  Help")
  assert.equal(lineText(renderViewTabs(all, "session", { width: 40 })), "[Session]  Graph  Runs  Help")
  assert.equal(lineText(renderViewTabs(["help"], "help", { width: 40 })), "[Help]")
  const line = renderViewTabs(all, "graph", { width: 40 })
  assert.equal(line.find((part) => part.text === "[Graph]").role, "accent")
  assert.equal(line.find((part) => part.text === "Runs").role, "muted")
  for (const width of [1, 5, 12, 40]) assert.ok(lineWidth(renderViewTabs(all, "graph", { width })) <= width)
})

test("the runs list has one line per run with status, progress and elapsed time, and marks the cursor", () => {
  const runs = [
    run([node("a", "completed"), node("b", "running")], { id: "r2", name: "second", status: "running", createdAt: NOW - 20_000 }),
    run([node("a", "completed"), node("b", "failed")], { id: "r1", name: "first", status: "failed", createdAt: NOW - 90_000, finishedAt: NOW - 30_000 }),
  ]
  const { lines, ranges } = renderRuns(runs, { selectedId: "r1", width: 80, now: NOW })
  const text = texts(lines)
  assert.equal(lines.length, 2)
  assert.match(text[0], /^ {2}second {2}● running {2}1\/2 ✓ {2}\d/)
  assert.match(text[1], /^> first {2}× failed {2}1\/2 ✓ {2}1× {2}\d/)
  assert.deepEqual(ranges, { r2: { start: 0, end: 1 }, r1: { start: 1, end: 2 } })
  assert.equal(lines[1].find((part) => part.text === "first").role, "selected")
  assert.equal(lines[0].find((part) => part.text === "second").role, "default")
  assert.deepEqual(texts(renderRuns([], { width: 40 }).lines), ["No runs in this session"])
  for (let width = 12; width <= 100; width++) {
    for (const line of renderRuns(runs, { selectedId: "r2", width, now: NOW }).lines) assert.ok(lineWidth(line) <= width, `${width}`)
  }
})

const HELP_KEYS = { toggle: "ctrl+x b", focus: "ctrl+g", origin: "ctrl+x o" }
const HELP_HOST = [["ctrl+x h", "previous session tab"], ["ctrl+x f", "go to the first message"]]

test("the help page explains how to run a DAG, lists the real keys, and never shows a raw leader token", () => {
  const frame = texts(renderHelp({ keys: HELP_KEYS, host: HELP_HOST, width: 80 })).join("\n")
  for (const heading of ["Run a DAG", "Pages", "With the panel focused", "In a step", "Open and focus", "Size", "OpenCode"]) {
    assert.match(frame, new RegExp(`^${heading}$`, "m"))
  }
  assert.match(frame, /Run a DAG that summarizes three files in parallel/)
  for (const key of ["ctrl+x b", "ctrl+g", "ctrl+x o", "/dag", "/dag-origin", "ctrl+x h", "ctrl+x f"]) assert.ok(frame.includes(key), key)
  assert.match(frame, /hjkl ←↓↑→ {2}move between boxes, or scroll/)
  assert.match(frame, /y {2}o {2}previous and next page/)
  assert.match(frame, /f {2}toggle fullscreen/)
  assert.match(frame, /q {2}esc {2}close the panel/)
  assert.match(frame, /enter {2}show the step's conversation in the panel/)
  assert.match(frame, /i {2}enter {2}write a message to the step/)
  assert.match(frame, /g {2}open the step's own session/)
  assert.match(frame, /esc {2}stop typing, then back to the graph/)
  assert.match(frame.replace(/\s+/g, " "), /Drag the line on the panel's left edge to resize it\. Double-click the line to reset it\./)
  assert.doesNotMatch(frame, /<leader>/)
})

test("the help page omits keys it does not have and the OpenCode section when the host binds none", () => {
  const frame = texts(renderHelp({ keys: { focus: "ctrl+g" }, host: [], width: 60 })).join("\n")
  assert.doesNotMatch(frame, /^OpenCode$/m)
  assert.match(frame, /ctrl\+g {2}move the cursor between the session and the panel/)
  assert.doesNotMatch(frame, /show or hide the panel|go back to the session/, "a key that is not bound is not advertised")
  assert.match(frame, /\/dag-origin/, "the slash command needs no key")
  assert.match(frame, /^Size$/m)
})

test("the help page wraps within every width and keeps each key intact", () => {
  for (let width = 16; width <= 120; width++) {
    const lines = renderHelp({ keys: HELP_KEYS, host: HELP_HOST, width })
    for (const line of lines) assert.ok(lineWidth(line) <= width, `${width}`)
    const joined = texts(lines).join("\n")
    // The longest key is 9 columns, so below 16 a line is cut to fit instead of keeping it whole.
    if (width < 16) continue
    for (const key of ["ctrl+g", "ctrl+x b", "ctrl+x h", "ctrl+x o", "ctrl+x f", "hjkl ←↓↑→"]) assert.ok(joined.includes(key), `${width}: ${key}`)
  }
  assert.ok(renderHelp({ keys: HELP_KEYS, host: HELP_HOST, width: 30 }).length > renderHelp({ keys: HELP_KEYS, host: HELP_HOST, width: 120 }).length)
})

test("terminal plugin shows a page per tab, cycles the available ones, and lands on the graph for a running run", () => {
  assert.match(TUI_SOURCE, /<Switch>[\s\S]*view\(\) === "session"[\s\S]*view\(\) === "graph" && run\(\)[\s\S]*view\(\) === "runs"[\s\S]*view\(\) === "help"/)
  assert.match(TUI_SOURCE, /availableViews\(runsOf\(store\.all\(\), sessionID\)\.length\)/)
  assert.match(TUI_SOURCE, /cycleView\(views, resolveView\(views, store\.ui\(sessionID\)\.view\), direction\)/)
  assert.match(TUI_SOURCE, /return store\.newest\(sessionID\)\?\.status === "running" \? \{ view: "graph", shownRunId: undefined \} : \{\}/)
  assert.match(TUI_SOURCE, /ctl\.openPanel\(sessionID, "auto", \{ view: "graph", shownRunId: undefined \}\)/)
  assert.match(TUI_SOURCE, /renderHelp\(\{ keys: panelKeys\(context\), host: hostKeys\(context\)/)
})

test("terminal plugin builds the session page from OpenCode's own data and lets the MCP title collapse", () => {
  assert.match(TUI_SOURCE, /context\.data\.session\.message\.list\(sessionID\(\)\)/)
  assert.match(TUI_SOURCE, /context\.data\.location\.model\.list\(info\(\)\?\.location\)/)
  assert.match(TUI_SOURCE, /info\(\)\?\.revert\?\.messageID/)
  assert.match(TUI_SOURCE, /context\.data\.session\.cost\(sessionID\(\)\)/)
  assert.match(TUI_SOURCE, /context\.data\.location\.mcp\.server\.list\(info\(\)\?\.location\)/)
  assert.match(TUI_SOURCE, /context\.storage\.store\("session-page", \{ initial: \{ mcpOpen: true \} \}\)/)
  assert.match(TUI_SOURCE, /if \(servers\(\)\.length <= 2\) return/)
  assert.match(TUI_SOURCE, /onMouseDown=\{toggleMcp\}/)
  assert.match(TUI_SOURCE, /context\.keymap\.dispatch\("mcp\.list"\)/)
})

test("terminal plugin flips the cursor with the panel handle and the host's pane command, and tracks focus", () => {
  assert.match(TUI_SOURCE, /focusAction\(\{ shown: openFor\(sessionID\), focused: panelFocused\(\) \}\)/)
  assert.match(TUI_SOURCE, /else if \(action === "leave"\) context\.keymap\.dispatch\("pane\.focus\.left"\)/)
  assert.match(TUI_SOURCE, /else if \(panelHandle\) panelHandle\.focus\(\)/)
  assert.match(TUI_SOURCE, /else context\.keymap\.dispatch\("pane\.focus\.right"\)/)
  assert.match(TUI_SOURCE, /ctl\.attach\(props\.panel\)/)
  assert.match(TUI_SOURCE, /createEffect\(\(\) => ctl\.setPanelFocused\(props\.panel\.focused\)\)/)
  assert.match(TUI_SOURCE, /onCleanup\(\(\) => \{\s*ctl\.attach\(undefined\)\s*ctl\.setPanelFocused\(false\)/)
})

test("a panel the user opened follows them to the next session, and one they closed or displaced does not", () => {
  assert.match(TUI_SOURCE, /let follow = false/)
  assert.match(TUI_SOURCE, /follow = true\s*openPanel\(sessionID, "manual", landingFor\(sessionID\)\)/)
  assert.match(TUI_SOURCE, /function closeByUser\(sessionID: string\) \{\s*follow = false/)
  assert.match(TUI_SOURCE, /if \(routed\(\) === previous\.sessionID\) \{\s*follow = false\s*dismiss\(previous\.sessionID\)/)
  assert.match(TUI_SOURCE, /function followRoute\(sessionID: string \| undefined\) \{\s*if \(!follow \|\| !sessionID\) return/)
  assert.match(TUI_SOURCE, /if \(disposed \|\| !follow \|\| routed\(\) !== sessionID \|\| openFor\(sessionID\)\) return/)
  assert.match(TUI_SOURCE, /ctl\.followRoute\(sessionID\)/)
})

test("terminal plugin hands focus back after an auto-open and closes an unrequested takeover", () => {
  assert.match(TUI_SOURCE, /let handBack = ctl\.store\.ui\(sessionID\(\)\)\.opened === "auto"/)
  assert.match(TUI_SOURCE, /context\.keymap\.dispatch\("pane\.focus\.left"\)/)
  assert.match(TUI_SOURCE, /props\.panel\.presentation !== "fullscreen"/)
})

test("terminal plugin lists only OpenCode keys the host actually binds, with no fallback text", () => {
  assert.match(TUI_SOURCE, /"session\.tab\.previous", "previous session tab"[\s\S]*"session\.tab\.next", "next session tab"[\s\S]*"session\.first"/)
  assert.doesNotMatch(TUI_SOURCE, /session\.sidebar\.toggle/, "the plugin owns the sidebar key, so it is not listed as an OpenCode key")
  assert.match(TUI_SOURCE, /if \(key\) entries\.push\(\[key, label\]\)/)
})

test("graph-only keys explain themselves in the other views and inside a step instead of acting", () => {
  assert.match(TUI_SOURCE, /if \(view\(\) !== "graph" \|\| step\(\)\) return needGraph\(\)/)
  assert.match(TUI_SOURCE, /ctl\.toast\(step\(\) \? "Press esc to leave the step first" : "Switch to the Graph page first"\)/)
  assert.match(TUI_SOURCE, /patchUi\(sessionID\(\), \{ shownRunId: chosen, view: "graph" \}\)/)
})

test("terminal plugin uses the fixed RPC contract and recovers on route change and reconnect", () => {
  assert.match(TUI_SOURCE, /from "\.\/rpc\.ts"/)
  assert.match(RPC_SOURCE, /id: "sidequest\.dag"/)
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

test("terminal plugin guards RPC failures and tears everything down", () => {
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
