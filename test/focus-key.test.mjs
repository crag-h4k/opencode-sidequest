import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { lineText, renderHelp, renderHints } from "../layout.mjs"
import { resolveKey as resolveHostKey } from "../panel-state.mjs"

// Run the real command registration without mounting OpenTUI or the controller's effects.
const source = ts.createSourceFile("tui.tsx", readFileSync(new URL("../tui.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = new Set(["Host", "panelKeys", "resolveKey"])
const constants = new Set(["PANEL_TOGGLE", "FOCUS", "GRAPH", "ORIGIN"])
const declarations = source.statements.filter((node) =>
  (ts.isFunctionDeclaration(node) && functions.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => constants.has(item.name.getText(source)))),
)
const compiled = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function host(options, shortcuts = {}) {
  const layers = []
  let flips = 0
  const context = {
    options,
    keymap: {
      layer: (factory) => layers.push(factory()),
      shortcuts: (id) => shortcuts[id] ?? [],
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(`${compiled}\nmodule.exports = { Host, panelKeys }`, {
    module,
    usePlugin: () => context,
    useTerminalDimensions: () => () => ({ width: 160, height: 50 }),
    createEffect: () => {},
    createMemo: (fn) => fn,
    on: () => {},
    onCleanup: () => {},
    resolveHostKey,
  })
  module.exports.Host({ ctl: { flip: () => flips++ } })
  return {
    focus: layers.flatMap((layer) => layer.commands).find((command) => command.id === "sidequest.dag.focus"),
    keys: module.exports.panelKeys(context),
    flips: () => flips,
  }
}

test("focus defaults to ctrl+g and still invokes the pane focus action", () => {
  const subject = host({})
  assert.equal(subject.focus.bind, "ctrl+g")
  subject.focus.run()
  assert.equal(subject.flips(), 1)
})

test("focusKey replaces the default binding without changing the command or action", () => {
  for (const focusKey of ["<leader>p", "alt+p"]) {
    const subject = host({ focusKey })
    assert.equal(subject.focus.bind, focusKey)
    subject.focus.run()
    assert.equal(subject.flips(), 1)
  }
})

test("custom focus hints and help use the host's formatted shortcut", () => {
  const subject = host({ focusKey: "<leader>p" }, { "sidequest.dag.focus": ["ctrl+g p"] })
  assert.equal(subject.keys.focus, "ctrl+g p")
  const footer = renderHints({ view: "session", focused: false, keys: subject.keys, width: 160 }).map(lineText).join("\n")
  const help = renderHelp({ keys: subject.keys, width: 160 }).map(lineText).join("\n")
  assert.match(footer, /ctrl\+g p to focus/)
  assert.match(help, /ctrl\+g p/)
  assert.doesNotMatch(footer + help, /<leader>/)
  assert.equal(host({ focusKey: "<leader>p" }).keys.focus, undefined, "an unregistered shortcut has no hint")
})
