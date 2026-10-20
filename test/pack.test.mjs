// test/pack.test.mjs
import assert from "node:assert/strict"
import test from "node:test"
import { checkPack } from "../scripts/verify-pack.mjs"

const COMPILED_TUI = [
  'import { effect as _$effect } from "@opentui/solid"',
  'import { createComponent as _$createComponent } from "@opentui/solid"',
  'import { renderHelp } from "../layout.mjs"',
  'import { AgentDag } from "../rpc.ts"',
].join("\n")

function pack({ exports, extra = {}, drop = [] } = {}) {
  const contents = {
    "dist/tui.js": COMPILED_TUI,
    "index.ts": "export default {}",
    "rpc.ts": "export const AgentDag = {}",
    "layout.mjs": "export const renderHelp = () => []",
    ...extra,
  }
  for (const name of drop) delete contents[name]
  return {
    pkg: { exports: exports ?? { ".": "./index.ts", "./tui": "./dist/tui.js", "./rpc": "./rpc.ts" } },
    files: Object.keys(contents),
    read: (path) => contents[path],
  }
}

test("a tarball with a compiled entry and resolvable imports is sound", () => {
  assert.deepEqual(checkPack(pack()), [])
})

test("an entry that exports raw TSX is rejected", () => {
  const problems = checkPack(pack({ exports: { ".": "./index.ts", "./tui": "./tui.tsx" }, extra: { "tui.tsx": "export {}" } }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /must name compiled \.js/)
})

test("a missing ./tui export is rejected", () => {
  const problems = checkPack(pack({ exports: { ".": "./index.ts" } }))
  assert.match(problems.join("\n"), /exports\["\.\/tui"\] must be a string path/)
})

test("an export whose file is not in the tarball is rejected", () => {
  const problems = checkPack(pack({ drop: ["dist/tui.js"] }))
  assert.match(problems.join("\n"), /exports\["\.\/tui"\] names \.\/dist\/tui\.js, which is not in the tarball/)
})

test("nested conditional exports are checked too", () => {
  const problems = checkPack(pack({ exports: { ".": { import: "./missing.ts" }, "./tui": "./dist/tui.js" } }))
  assert.match(problems.join("\n"), /exports\["\. \(import\)"\] names \.\/missing\.ts/)
})

test("compiled output that still uses the automatic JSX runtime is rejected", () => {
  const problems = checkPack(pack({ extra: { "dist/tui.js": `${COMPILED_TUI}\nimport { jsx } from "solid-js/h/jsx-runtime"` } }))
  assert.match(problems.join("\n"), /dist\/tui\.js still contains JSX/)
})

test("compiled output with unreplaced JSX is rejected", () => {
  const problems = checkPack(pack({ extra: { "dist/tui.js": `${COMPILED_TUI}\nconst view = <box></box>` } }))
  assert.match(problems.join("\n"), /dist\/tui\.js still contains JSX/)
})

test("an entry with no effect import would not update after the first paint", () => {
  const problems = checkPack(pack({ extra: { "dist/tui.js": 'import { renderHelp } from "../layout.mjs"\nexport default {}' } }))
  assert.match(problems.join("\n"), /does not import effect from @opentui\/solid/)
})

test("a relative import that is not in the tarball is rejected", () => {
  const problems = checkPack(pack({ drop: ["layout.mjs"] }))
  assert.match(problems.join("\n"), /dist\/tui\.js imports \.\.\/layout\.mjs, which is not in the tarball/)
})

test("an import of a .tsx file is rejected even when the file is shipped", () => {
  const problems = checkPack(pack({ extra: { "dist/tui.js": `${COMPILED_TUI}\nimport { x } from "../view.tsx"`, "view.tsx": "export {}" } }))
  assert.match(problems.join("\n"), /imports \.\.\/view\.tsx; a \.tsx file would not be compiled/)
})

test("hand-written .mjs modules are followed but not scanned for JSX", () => {
  const problems = checkPack(pack({ extra: { "layout.mjs": 'export const closing = "</b>"' } }))
  assert.deepEqual(problems, [])
})
