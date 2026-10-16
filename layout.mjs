// layout.mjs
// Pure rendering for the agent DAG panel: plain run data in, lines of
// { text, role } segments out. No host imports; the terminal plugin maps roles
// to theme colors.

/** @typedef {{ text: string, role: string, bold?: boolean }} Segment */
/** @typedef {Segment[]} Line */

export const ROLES = Object.freeze(["default", "muted", "info", "success", "error", "warning", "selected", "accent"])

export const STATE_GLYPH = Object.freeze({
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "×",
  skipped: "·",
  cancelled: "−",
})

export const STATE_ROLE = Object.freeze({
  pending: "muted",
  running: "info",
  completed: "success",
  failed: "error",
  skipped: "warning",
  cancelled: "muted",
})

export const RUN_ROLE = Object.freeze({
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "muted",
})

export const MAX_BOX_WIDTH = 34
export const BOX_GAP = 2
const SLOT_WIDTH = 22
const MIN_BOX_WIDTH = 12

const ROUND = Object.freeze({ tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" })
const HEAVY = Object.freeze({ tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" })

// Bit 1 = up, 2 = right, 4 = down, 8 = left.
const JUNCTION = Object.freeze({
  1: "│", 2: "─", 3: "└", 4: "│", 5: "│", 6: "┌", 7: "├", 8: "─",
  9: "┘", 10: "─", 11: "┴", 12: "┐", 13: "┤", 14: "┬", 15: "┼",
})

const ZERO_WIDTH = [
  [0x0300, 0x036f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xe0100, 0xe01ef],
]

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]

function inRanges(codePoint, ranges) {
  for (const [low, high] of ranges) {
    if (codePoint >= low && codePoint <= high) return true
  }
  return false
}

export function charWidth(codePoint) {
  if (codePoint < 0x300) return 1
  if (inRanges(codePoint, ZERO_WIDTH)) return 0
  return inRanges(codePoint, WIDE) ? 2 : 1
}

export function displayWidth(text) {
  let total = 0
  for (const char of text) total += charWidth(char.codePointAt(0))
  return total
}

/** Strips escape sequences and control characters that would corrupt a terminal row. */
export function clean(value) {
  return String(value ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
}

export function fit(text, columns, pad = false) {
  const value = clean(text)
  if (columns <= 0) return ""
  const width = displayWidth(value)
  if (width <= columns) return pad ? value + " ".repeat(columns - width) : value
  let out = ""
  let used = 0
  for (const char of value) {
    const size = charWidth(char.codePointAt(0))
    if (used + size > columns - 1) break
    out += char
    used += size
  }
  out += "…"
  used += 1
  return pad ? out + " ".repeat(Math.max(0, columns - used)) : out
}

/** Wraps on spaces, hard-splits long words, drops blank lines, and ellipsizes past maxLines. */
export function wrapText(text, columns, maxLines = Infinity) {
  const size = Math.max(1, Math.floor(columns))
  const rows = []
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    let line = ""
    for (const word of clean(paragraph).split(/ +/).filter(Boolean)) {
      if (displayWidth(word) > size) {
        if (line) rows.push(line)
        line = ""
        let chunk = ""
        for (const char of word) {
          if (displayWidth(chunk + char) > size) {
            rows.push(chunk)
            chunk = ""
          }
          chunk += char
        }
        line = chunk
        continue
      }
      if (!line) line = word
      else if (displayWidth(line) + 1 + displayWidth(word) <= size) line += ` ${word}`
      else {
        rows.push(line)
        line = word
      }
    }
    if (line) rows.push(line)
  }
  if (rows.length <= maxLines) return rows
  const kept = rows.slice(0, Math.max(1, maxLines))
  kept[kept.length - 1] = fit(`${kept[kept.length - 1]}…`, size)
  return kept
}

export function seg(text, role = "default", bold = false) {
  return bold ? { text, role, bold: true } : { text, role }
}

export const lineText = (line) => line.map((segment) => segment.text).join("")
export const lineWidth = (line) => displayWidth(lineText(line))

export function fitLine(segments, columns, pad = false) {
  if (columns <= 0) return []
  const total = lineWidth(segments)
  if (total <= columns) return pad && total < columns ? [...segments, seg(" ".repeat(columns - total))] : [...segments]
  const out = []
  let used = 0
  let role = "muted"
  const budget = columns - 1
  collect: for (const segment of segments) {
    let text = ""
    role = segment.role
    for (const char of segment.text) {
      const size = charWidth(char.codePointAt(0))
      if (used + size > budget) {
        if (text) out.push({ ...segment, text })
        break collect
      }
      text += char
      used += size
    }
    if (text) out.push({ ...segment, text })
  }
  out.push(seg("…", role))
  used += 1
  if (pad && used < columns) out.push(seg(" ".repeat(columns - used)))
  return out
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function nodeElapsed(node, now) {
  if (!Number.isFinite(node?.startedAt)) return undefined
  if (Number.isFinite(node.finishedAt)) return node.finishedAt - node.startedAt
  return node.state === "running" ? now - node.startedAt : undefined
}

export function runElapsed(run, now) {
  if (run.status === "running") return now - run.createdAt
  return (Number.isFinite(run.finishedAt) ? run.finishedAt : run.updatedAt) - run.createdAt
}

export function countNodes(run) {
  const counts = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0 }
  for (const node of run?.nodes ?? []) {
    counts.total += 1
    if (node.state !== "total" && Object.hasOwn(counts, node.state)) counts[node.state] += 1
  }
  return counts
}

/** Topological layers; a cycle or unresolvable set lands in one trailing layer. */
export function layersOf(nodes) {
  const ids = new Set(nodes.map((node) => node.id))
  const placed = new Set()
  const layers = []
  let rest = [...nodes]
  while (rest.length) {
    const layer = rest.filter((node) => (node.dependsOn ?? []).every((dep) => !ids.has(dep) || placed.has(dep)))
    if (!layer.length) {
      layers.push(rest)
      break
    }
    layers.push(layer)
    const done = new Set(layer)
    for (const node of layer) placed.add(node.id)
    rest = rest.filter((node) => !done.has(node))
  }
  return layers
}

export function edgesOf(nodes) {
  const ids = new Set(nodes.map((node) => node.id))
  const seen = new Set()
  const edges = []
  for (const node of nodes) {
    for (const from of node.dependsOn ?? []) {
      const key = `${from}\u0000${node.id}`
      if (!ids.has(from) || seen.has(key)) continue
      seen.add(key)
      edges.push({ from, to: node.id })
    }
  }
  return edges
}

function nodeSummary(node, now) {
  const elapsed = () => {
    const ms = nodeElapsed(node, now)
    return ms === undefined ? "" : formatElapsed(ms)
  }
  if (node.state === "running") return clean(node.activity) || elapsed()
  if (node.state === "failed") return clean(node.error) || elapsed()
  if (node.state === "completed") return elapsed()
  return ""
}

/** "github-copilot/gpt-6-luna" when it fits, else "gpt-6-luna"; an unset model is the host's default. */
export function modelLabel(model, max = Infinity) {
  if (!model) return "default model"
  const full = clean(model)
  if (full.length <= max) return full
  const slash = full.indexOf("/")
  return slash >= 0 ? full.slice(slash + 1) : full
}

/** A prerequisite that is not met yet shows an empty box; every other state keeps its step glyph. */
export const PREREQUISITE_GLYPH = Object.freeze({ ...STATE_GLYPH, pending: "□" })

/** "after ✓ a □ b": each prerequisite with its own state glyph, so a blocked step is obvious. */
function dependencyRow(node, byId) {
  const deps = node.dependsOn ?? []
  if (!deps.length) return [seg("no deps", "muted")]
  const parts = [seg("after", "muted")]
  for (const dep of deps) {
    const parent = byId.get(dep)
    parts.push(seg(" "), seg(PREREQUISITE_GLYPH[parent?.state] ?? "?", STATE_ROLE[parent?.state] ?? "muted"), seg(" "), seg(clean(dep)))
  }
  return parts
}

function boxRows(node, { boxWidth, selected, now, byId }) {
  const inner = boxWidth - 4
  const role = STATE_ROLE[node.state] ?? "muted"
  const chars = selected ? HEAVY : ROUND
  const border = (text) => seg(text, role)
  const attempt = node.attempt > 1 ? ` #${node.attempt}` : ""
  const summary = nodeSummary(node, now)
  const row = (content) => [border(chars.v), seg(" "), ...fitLine(content, inner, true), seg(" "), border(chars.v)]
  return [
    [border(chars.tl + chars.h.repeat(boxWidth - 2) + chars.tr)],
    row([
      seg(selected ? ">" : " ", "selected", true),
      seg(selected ? "▾" : "▸", "muted"),
      seg(" "),
      seg(clean(node.label || node.id), selected ? "selected" : "default", selected),
    ]),
    row([
      seg(`${STATE_GLYPH[node.state] ?? "?"} ${node.state}${attempt}`, role),
      ...(summary ? [seg(` ${summary}`, "muted")] : []),
    ]),
    row([seg("◇ ", "muted"), seg(modelLabel(node.model, inner - 2), node.model ? "default" : "muted")]),
    row(dependencyRow(node, byId)),
    [border(chars.bl + chars.h.repeat(boxWidth - 2) + chars.br)],
  ]
}

function connectorRows(from, to, byId, columns) {
  const grid = [0, 1, 2].map(() => new Array(columns).fill(0))
  const targets = new Set()
  for (const target of to) {
    for (const dep of byId.get(target.id)?.dependsOn ?? []) {
      const source = from.find((position) => position.id === dep)
      if (!source) continue
      const a = source.center
      const b = target.center
      grid[0][a] |= 5
      grid[1][a] |= 1
      for (let x = Math.min(a, b); x < Math.max(a, b); x++) {
        grid[1][x] |= 2
        grid[1][x + 1] |= 8
      }
      grid[1][b] |= 4
      targets.add(b)
    }
  }
  if (!targets.size) return [[]]
  return grid.map((row, y) => [
    seg(row.map((bits, x) => (y === 2 && targets.has(x) ? "▼" : JUNCTION[bits] ?? " ")).join("").trimEnd(), "muted"),
  ])
}

function compactRows(layers, columns, selectedId) {
  const lines = []
  const ranges = {}
  const centers = {}
  for (const node of layers.flat()) {
    const selected = node.id === selectedId
    ranges[node.id] = { start: lines.length, end: lines.length + 1 }
    centers[node.id] = 0
    lines.push(
      fitLine(
        [
          seg(selected ? ">" : " ", "selected", true),
          seg(` ${STATE_GLYPH[node.state] ?? "?"} `, STATE_ROLE[node.state] ?? "muted"),
          seg(clean(node.label || node.id), selected ? "selected" : "default", selected),
        ],
        columns,
      ),
    )
  }
  return { lines, ranges, centers }
}

/**
 * Layered graph of rounded boxes. Returns the lines plus each node's line range
 * so the panel can keep the selection scrolled into view.
 * @param {any} run
 * @param {{ width?: number, selectedId?: string, now?: number }} [options]
 * @returns {{ lines: Line[], ranges: Record<string, { start: number, end: number }>, centers: Record<string, number> }}
 */
export function graphLayout(run, { width = 40, selectedId, now = Date.now() } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const nodes = run?.nodes ?? []
  if (!nodes.length) return { lines: [fitLine([seg("No nodes", "muted")], columns)], ranges: {}, centers: {} }
  const layers = layersOf(nodes)
  if (columns < MIN_BOX_WIDTH) return compactRows(layers, columns, selectedId)

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const perRow = Math.max(1, Math.floor((columns + BOX_GAP) / SLOT_WIDTH))
  const lines = []
  const ranges = {}
  const centers = {}
  let previous = []
  for (const layer of layers) {
    const across = Math.min(perRow, layer.length)
    const boxWidth = Math.min(MAX_BOX_WIDTH, Math.floor((columns - BOX_GAP * (across - 1)) / across))
    for (let offset = 0; offset < layer.length; offset += across) {
      const group = layer.slice(offset, offset + across)
      const total = boxWidth * group.length + BOX_GAP * (group.length - 1)
      const left = Math.max(0, Math.floor((columns - total) / 2))
      const positions = group.map((node, index) => ({
        id: node.id,
        center: left + index * (boxWidth + BOX_GAP) + Math.floor(boxWidth / 2),
      }))
      if (lines.length) {
        if (offset === 0) lines.push(...connectorRows(previous, positions, byId, columns))
        else lines.push([seg(fit("  · same layer", columns), "muted")])
      }
      const start = lines.length
      const boxes = group.map((node) => boxRows(node, { boxWidth, selected: node.id === selectedId, now, byId }))
      const height = boxes[0].length
      for (let row = 0; row < height; row++) {
        const parts = left ? [seg(" ".repeat(left))] : []
        boxes.forEach((box, index) => {
          if (index) parts.push(seg(" ".repeat(BOX_GAP)))
          parts.push(...box[row])
        })
        lines.push(parts)
      }
      for (const node of group) ranges[node.id] = { start, end: start + height }
      for (const position of positions) centers[position.id] = position.center
      previous = positions
    }
  }
  return { lines, ranges, centers }
}

export function renderGraph(run, options) {
  return graphLayout(run, options).lines
}

export function renderEdges(run, { width = 40 } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const nodes = run?.nodes ?? []
  const edges = edgesOf(nodes)
  const lines = [fitLine([seg("Dependencies", "muted", true)], columns)]
  if (!edges.length) return [...lines, fitLine([seg("  none", "muted")], columns)]
  const targets = new Map()
  for (const edge of edges) targets.set(edge.from, [...(targets.get(edge.from) ?? []), edge.to])
  for (const node of nodes) {
    const to = targets.get(node.id)
    if (!to) continue
    for (const row of wrapText(`${node.id} → ${to.join(", ")}`, columns - 2)) {
      lines.push(fitLine([seg(`  ${row}`, "muted")], columns))
    }
  }
  return lines
}

export function renderHeader(run, { width = 40, now = Date.now() } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const counts = countNodes(run)
  const lines = [
    fitLine(
      [
        seg("dag ", "muted"),
        seg(clean(run.name || run.id), "accent", true),
        seg("  "),
        seg(run.status, RUN_ROLE[run.status] ?? "muted"),
      ],
      columns,
    ),
    fitLine(
      [
        seg(`${counts.running}●`, "info"),
        seg(" "),
        seg(`${counts.completed}/${counts.total} ✓`, "success"),
        ...(counts.failed ? [seg(`  ${counts.failed}×`, "error")] : []),
        seg(`  ${formatElapsed(runElapsed(run, now))}`, "muted"),
        ...(Number.isFinite(run.maxParallel) ? [seg(`  parallel ${run.maxParallel}`, "muted")] : []),
      ],
      columns,
    ),
  ]
  for (const row of wrapText(run.error ?? "", columns, 2)) lines.push(fitLine([seg(row, "error")], columns))
  return lines
}

/**
 * @param {any} run
 * @param {{ now?: number, panelHint?: string, originHint?: string, width?: number }} [options]
 * @returns {Line | null}
 */
export function renderStrip(run, { now = Date.now(), panelHint, originHint, width } = {}) {
  if (run?.status !== "running") return null
  const counts = countNodes(run)
  const build = (name, hint) => [
    seg("dag ", "muted"),
    seg(name, "accent"),
    seg("  "),
    seg(`${counts.running}●`, "info"),
    seg(" "),
    seg(`${counts.completed}/${counts.total} ✓`, "success"),
    ...(counts.failed ? [seg(`  ${counts.failed}×`, "error")] : []),
    seg(`  ${formatElapsed(runElapsed(run, now))}`, "muted"),
    ...(hint && panelHint ? [seg(`   ${panelHint} panel`, "muted")] : []),
    ...(hint && originHint ? [seg(`  ${originHint}`, "muted")] : []),
  ]
  const name = clean(run.name || run.id)
  const full = build(name, true)
  if (!Number.isFinite(width)) return full
  if (lineWidth(full) <= width) return full
  const bare = build(name, false)
  if (lineWidth(bare) <= width) return bare
  const room = Math.max(1, width - lineWidth(build("", false)))
  return fitLine(build(fit(name, room), false), width)
}

const VIEW_LABEL = Object.freeze({ session: "Session", graph: "Graph", runs: "Runs", help: "Help" })

/** The row of view names at the top of the panel; the current one is bracketed and highlighted. */
export function renderViewTabs(views, current, { width = 40 } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const parts = []
  views.forEach((view, index) => {
    if (index) parts.push(seg("  "))
    const label = VIEW_LABEL[view] ?? view
    parts.push(view === current ? seg(`[${label}]`, "accent", true) : seg(label, "muted"))
  })
  return fitLine(parts, columns)
}

/**
 * One line per run, newest first: name, status glyph, finished steps, failures and elapsed time.
 * Returns each run's line range so the panel can keep the cursor in view.
 * @param {any[]} runs
 * @param {{ selectedId?: string, width?: number, now?: number }} [options]
 * @returns {{ lines: Line[], ranges: Record<string, { start: number, end: number }> }}
 */
export function renderRuns(runs, { selectedId, width = 40, now = Date.now() } = {}) {
  const columns = Math.max(1, Math.floor(width))
  if (!runs?.length) return { lines: [fitLine([seg("No runs in this session", "muted")], columns)], ranges: {} }
  const lines = []
  const ranges = {}
  for (const run of runs) {
    const selected = run.id === selectedId
    const counts = countNodes(run)
    ranges[run.id] = { start: lines.length, end: lines.length + 1 }
    lines.push(
      fitLine(
        [
          seg(selected ? ">" : " ", "selected", true),
          seg(" "),
          seg(clean(run.name || run.id), selected ? "selected" : "default", selected),
          seg(`  ${STATE_GLYPH[run.status] ?? "?"} ${run.status}`, RUN_ROLE[run.status] ?? "muted"),
          seg(`  ${counts.completed}/${counts.total} ✓`, "success"),
          ...(counts.failed ? [seg(`  ${counts.failed}×`, "error")] : []),
          seg(`  ${formatElapsed(runElapsed(run, now))}`, "muted"),
        ],
        columns,
        true,
      ),
    )
  }
  return { lines, ranges }
}

/**
 * How to run a DAG, how to drive the panel, and the OpenCode keys that matter beside it. Keys are
 * passed in already formatted, so the real key shows and never `<leader>`. A key the host does not
 * bind is left out.
 * @param {{ keys?: { toggle?: string, focus?: string, origin?: string },
 *   host?: ReadonlyArray<readonly [string, string]>, width?: number }} [options]
 * @returns {Line[]}
 */
export function renderHelp({ keys = {}, host = [], width = 40 } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const lines = []
  const heading = (text) => {
    if (lines.length) lines.push([])
    lines.push(fitLine([seg(text, "default", true)], columns))
  }
  const prose = (text, indent = 2) => {
    for (const row of wrapText(text, Math.max(1, columns - indent), 12)) {
      lines.push(fitLine([seg(" ".repeat(indent) + row, "muted")], columns))
    }
  }
  const keyRow = (key, label) => {
    const shown = clean(key)
    const lead = 2 + displayWidth(shown) + 2
    if (columns - lead >= 14) {
      wrapText(label, columns - lead, 6).forEach((row, index) => {
        const head = index ? [seg(" ".repeat(lead))] : [seg("  "), seg(shown, "accent", true), seg("  ")]
        lines.push(fitLine([...head, seg(row, "muted")], columns))
      })
      return
    }
    lines.push(fitLine([seg("  "), seg(shown, "accent", true)], columns))
    prose(label, 4)
  }

  heading("Run a DAG")
  prose("Ask the agent for one, for example:")
  prose('"Run a DAG that summarizes three files in parallel, then merges them."', 4)
  prose("Give each step a model, a timeout, and a token cap so a step cannot run away. While a DAG runs, this panel opens on its graph.")
  heading("Pages")
  prose("Session is OpenCode's own landing page. Graph and Runs appear once a session has DAG runs.")
  keyRow("y  o", "previous and next page, wrapping around")
  heading("With the panel focused")
  keyRow("hjkl ←↓↑→", "move between boxes, or scroll")
  keyRow("enter", "show the step's conversation in the panel")
  keyRow("c  r", "cancel a running DAG, retry a finished one")
  keyRow("f", "toggle fullscreen")
  keyRow("q  esc", "close the panel")
  heading("In a step")
  keyRow("i  enter", "write a message to the step")
  keyRow("g", "open the step's own session")
  keyRow("esc", "stop typing, then back to the graph")
  heading("Open and focus")
  if (keys.toggle) keyRow(keys.toggle, "show or hide the panel")
  if (keys.focus) keyRow(keys.focus, "move the cursor between the session and the panel")
  keyRow("/dag", "open the panel on the newest graph")
  if (keys.origin) keyRow(keys.origin, "from a step, go back to the session that started the DAG")
  keyRow("/dag-origin", "the same, as a command")
  heading("Size")
  prose("Drag the line on the panel's left edge to resize it. Double-click the line to reset it. The width is remembered.")
  if (host.length) {
    heading("OpenCode")
    for (const [key, label] of host) keyRow(key, label)
  }
  return lines
}

const MCP_LABEL = Object.freeze({
  connected: "Connected",
  pending: "Connecting",
  failed: "Error",
  disabled: "Disabled",
  needs_auth: "Sign in",
})
const MCP_ROLE = Object.freeze({ connected: "success", failed: "error", disabled: "muted", needs_auth: "warning" })

/**
 * OpenCode's own landing page: the session title, the context window use, and the MCP servers. The
 * MCP title is returned apart from its rows so the panel can make it a click target that collapses
 * them. Servers with more than two rows collapse; fewer never do.
 * @param {{ title?: string, usage?: { tokens: number, percent?: number }, cost?: number,
 *   servers?: ReadonlyArray<{ name: string, status: { status: string } }>, expanded?: boolean, width?: number }} [options]
 * @returns {{ top: Line[], mcpTitle?: Line, mcpRows: Line[] }}
 */
export function renderSessionPage({ title, usage, cost = 0, servers = [], expanded = true, width = 40 } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const top = []
  const name = clean(title ?? "")
  if (name) for (const row of wrapText(name, columns, 3)) top.push(fitLine([seg(row, "default", true)], columns))
  if (usage || cost > 0) {
    if (top.length) top.push([])
    top.push(fitLine([seg("Context", "default", true)], columns))
    if (usage) {
      top.push(fitLine([seg(`${usage.tokens.toLocaleString("en-US")} tokens`, "muted")], columns))
      if (usage.percent !== undefined) top.push(fitLine([seg(`${usage.percent}% used`, "muted")], columns))
    }
    if (cost > 0) top.push(fitLine([seg(`$${cost.toFixed(2)} spent`, "muted")], columns))
  }
  if (!servers.length) return { top, mcpRows: [] }
  const collapsible = servers.length > 2
  const open = !collapsible || expanded
  const active = servers.filter((server) => server.status.status === "connected").length
  const errors = servers.filter((server) => server.status.status === "failed" || server.status.status === "needs_auth").length
  const mcpTitle = fitLine(
    [
      ...(collapsible ? [seg(open ? "▼ " : "▶ ")] : []),
      seg("MCP", "default", true),
      ...(open ? [] : [seg(` (${active} active${errors ? `, ${errors} error${errors > 1 ? "s" : ""}` : ""})`, "muted")]),
    ],
    columns,
  )
  const mcpRows = open
    ? servers.map((server) => {
        const state = server.status.status
        const label = MCP_LABEL[state] ?? state
        const room = Math.max(1, columns - 2 - displayWidth(label) - 1)
        const shown = fit(clean(server.name), room)
        const gap = Math.max(1, columns - 2 - displayWidth(shown) - displayWidth(label))
        return fitLine(
          [seg("•", MCP_ROLE[state] ?? "muted"), seg(" "), seg(shown), seg(" ".repeat(gap)), seg(label, state === "failed" ? "error" : "muted")],
          columns,
        )
      })
    : []
  return { top, mcpTitle, mcpRows }
}

/**
 * The top of a step opened inside the panel: its name and state, the model it was asked to use, and
 * what went wrong if it failed.
 * @param {any} node
 * @param {{ width?: number, now?: number }} [options]
 * @returns {Line[]}
 */
export function renderStepHeader(node, { width = 40, now = Date.now() } = {}) {
  if (!node) return []
  const columns = Math.max(1, Math.floor(width))
  const role = STATE_ROLE[node.state] ?? "muted"
  const elapsed = nodeElapsed(node, now)
  const lines = [
    fitLine(
      [
        seg(clean(node.label || node.id), "accent", true),
        seg("  "),
        seg(`${STATE_GLYPH[node.state] ?? "?"} ${node.state}`, role),
        ...(node.attempt > 1 ? [seg(`  attempt ${node.attempt}`, "muted")] : []),
        ...(elapsed === undefined ? [] : [seg(`  ${formatElapsed(elapsed)}`, "muted")]),
      ],
      columns,
    ),
    fitLine([seg(`◇ ${modelLabel(node.model, Math.max(1, columns - 2))}`, "muted")], columns),
  ]
  if (node.error) lines.push(...field("error", node.error, "error", columns, 3))
  return lines
}

const TOOL_HINTS = ["command", "filePath", "path", "pattern", "query", "url", "description"]

function toolSummary(input) {
  if (!input || typeof input !== "object") return ""
  for (const key of TOOL_HINTS) if (typeof input[key] === "string" && input[key]) return clean(input[key])
  const first = Object.values(input).find((value) => typeof value === "string" && value)
  return typeof first === "string" ? clean(first) : ""
}

/**
 * A step's conversation as lines: what it was asked, what it answered, and the tools it ran. The
 * newest `maxLines` are kept, so a long step shows its end.
 * @param {ReadonlyArray<any> | undefined} messages
 * @param {{ width?: number, maxLines?: number }} [options]
 * @returns {Line[]}
 */
export function renderTranscript(messages, { width = 40, maxLines = 500 } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const lines = []
  const block = (marker, markerRole, text, role = "default") => {
    const lead = marker ? displayWidth(marker) : 0
    const rows = wrapText(clean(text), Math.max(1, columns - lead), 40)
    rows.forEach((row, index) => {
      const head = marker ? (index ? [seg(" ".repeat(lead))] : [seg(marker, markerRole, true)]) : []
      lines.push(fitLine([...head, seg(row, role)], columns))
    })
  }
  const gap = () => {
    if (lines.length && lines.at(-1).length) lines.push([])
  }
  for (const message of messages ?? []) {
    if (message.type === "user") {
      gap()
      block("› ", "accent", message.text ?? "")
    } else if (message.type === "assistant") {
      gap()
      for (const part of message.content ?? []) {
        if (part.type === "text" && part.text) block("", "default", part.text)
        else if (part.type === "reasoning") lines.push(fitLine([seg("· thinking", "muted")], columns))
        else if (part.type === "tool") {
          const status = part.state?.status
          const mark = status === "completed" ? "✓" : status === "error" ? "×" : "…"
          const markRole = status === "completed" ? "success" : status === "error" ? "error" : "info"
          const hint = toolSummary(part.state?.input)
          lines.push(fitLine([seg("▸ ", "muted"), seg(clean(part.name), "default", true), seg(` ${mark}`, markRole), ...(hint ? [seg(` ${hint}`, "muted")] : [])], columns))
          if (status === "error") block("  ", "error", part.state?.error?.message ?? part.state?.error?.type ?? "error", "error")
        }
      }
      if (message.error) block("", "error", message.error.message ?? message.error.type ?? "error", "error")
    } else if (message.type === "synthetic" || message.type === "system") {
      gap()
      block("", "muted", message.text ?? "", "muted")
    }
  }
  while (lines.length && !lines.at(-1).length) lines.pop()
  return lines.slice(-Math.max(1, maxLines))
}

/**
 * Key reminder for the bottom of the panel. Each key and its label stay together: chips are packed
 * left to right and a chip that does not fit moves to the next line whole, so a narrow panel never
 * cuts a key from its label. Keys are shown as the user must press them, never as `<leader>`, and a
 * key the host does not bind is left out.
 * @param {{ view?: string, step?: boolean, typing?: boolean, running?: boolean, canOpen?: boolean,
 *   canCycle?: boolean, focused?: boolean, width?: number, maxLines?: number,
 *   keys?: { toggle?: string, focus?: string } }} [options]
 * @returns {Line[]}
 */
export function renderHints({ view = "graph", step, typing, running, canOpen, canCycle, focused, keys = {}, width = 40, maxLines = 5 } = {}) {
  const columns = Math.max(1, Math.floor(width))
  const chips = []
  if (focused && typing) {
    chips.push(["enter", "send"], ["esc", "stop typing"])
  } else if (focused && step) {
    chips.push(["jk ↑↓", "scroll"], ["i", "message"], ["g", "open session"], ["esc", "back"], ["q", "close"])
    if (keys.focus) chips.push([keys.focus, "session"])
  } else if (focused) {
    if (view === "graph") {
      chips.push(["hjkl ←↓↑→", "move"])
      if (canOpen) chips.push(["enter", "open step"])
      chips.push(running ? ["c", "cancel run"] : ["r", "retry"])
    } else if (view === "runs") {
      chips.push(["jk ↑↓", "move"], ["enter", "show run"])
    } else {
      chips.push(["jk ↑↓", "scroll"])
    }
    if (canCycle) chips.push(["y o", "change page"])
    chips.push(["f", "fullscreen"], ["q", "close"])
    if (keys.focus) chips.push([keys.focus, "session"])
  } else {
    chips.push([keys.focus ? `click or ${keys.focus}` : "click", "to focus"])
    if (keys.toggle) chips.push([keys.toggle, "close panel"])
  }

  const separator = "   "
  const lines = []
  let current = []
  let used = 0
  for (const [key, label] of chips) {
    const chip = [seg(clean(key), "accent", true), seg(` ${label}`, "muted")]
    const size = displayWidth(clean(key)) + 1 + displayWidth(label)
    if (current.length && used + separator.length + size > columns) {
      lines.push(current)
      current = []
      used = 0
    }
    if (current.length) {
      current.push(seg(separator))
      used += separator.length
    }
    current.push(...chip)
    used += size
  }
  if (current.length) lines.push(current)
  return lines.slice(0, Math.max(1, maxLines)).map((line) => fitLine(line, columns))
}

function field(label, value, role, columns, maxRows) {
  const labelWidth = 8
  const rows = wrapText(value, Math.max(1, columns - labelWidth), maxRows)
  return rows.map((row, index) => fitLine([seg(index ? " ".repeat(labelWidth) : label.padEnd(labelWidth), "muted"), seg(row, role)], columns))
}

export function renderDetail(node, { now = Date.now(), width = 40, maxLines = 12 } = {}) {
  if (!node) return []
  const columns = Math.max(1, Math.floor(width))
  const role = STATE_ROLE[node.state] ?? "muted"
  const elapsed = nodeElapsed(node, now)
  const lines = [
    fitLine(
      [
        seg(clean(node.label || node.id), "default", true),
        ...(node.label && node.label !== node.id ? [seg(` (${clean(node.id)})`, "muted")] : []),
      ],
      columns,
    ),
    fitLine(
      [
        seg(`${STATE_GLYPH[node.state] ?? "?"} ${node.state}`, role),
        ...(node.attempt > 0 ? [seg(`  attempt ${node.attempt}`, "muted")] : []),
        ...(elapsed === undefined ? [] : [seg(`  ${formatElapsed(elapsed)}`, "muted")]),
      ],
      columns,
    ),
  ]
  if (node.agent) lines.push(...field("agent", node.agent, "default", columns, 1))
  if ((node.dependsOn ?? []).length) lines.push(...field("deps", node.dependsOn.join(", "), "default", columns, 2))
  if (node.sessionID) lines.push(...field("session", node.sessionID, "muted", columns, 1))
  if (node.error) lines.push(...field("error", node.error, "error", columns, 3))
  if (node.output) lines.push(...field("output", node.output, "default", columns, 4))
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, Math.max(1, maxLines))
  kept[kept.length - 1] = fitLine([seg("…", "muted")], columns)
  return kept
}
