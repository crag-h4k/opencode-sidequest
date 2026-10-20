// test/build.test.mjs
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { build, COMPILED, rewriteImport } from "../scripts/build.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

async function compiled() {
  const outDir = join(mkdtempSync(join(tmpdir(), "sidequest-build-")), "dist")
  await build({ outDir })
  return { outDir, read: (name) => readFileSync(join(outDir, `${name}.js`), "utf8") }
}

test("the compiled TUI entry is reactive Solid output, not the automatic JSX runtime", async () => {
  const { read } = await compiled()
  for (const name of COMPILED) {
    const code = read(name)
    // OpenCode skips node_modules when it compiles Solid, so these calls are what
    // make the panel update after its first paint: an effect per dynamic prop.
    assert.match(code, /import \{ effect as [\w$]+ \} from "@opentui\/solid"/, name)
    assert.match(code, /import \{ createComponent as [\w$]+ \} from "@opentui\/solid"/, name)
    assert.doesNotMatch(code, /jsx-runtime|jsxDEV|\b_?jsxs?\(/, name)
    assert.doesNotMatch(code, /<\/[A-Za-z]|\/>/, `${name} still contains JSX`)
  }
})

test("every relative import in the compiled file resolves, and none names a .tsx file", async () => {
  const { outDir, read } = await compiled()
  for (const name of COMPILED) {
    const code = read(name)
    assert.doesNotMatch(code, /from "[^"]+\.tsx"/, name)
    const specifiers = [...code.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((match) => match[1])
    assert.ok(specifiers.length > 0, `${name}.js imports the logic modules`)
    for (const specifier of specifiers) {
      assert.ok(existsSync(resolve(outDir, specifier)), `${name}.js imports ${specifier}`)
    }
  }
})

test("sibling imports move back to the package root and bare specifiers stay", () => {
  const outDir = join(ROOT, "dist")
  assert.equal(rewriteImport("./layout.mjs", outDir), "../layout.mjs")
  assert.equal(rewriteImport("./rpc.ts", outDir), "../rpc.ts")
  assert.equal(rewriteImport("solid-js", outDir), "solid-js")
  assert.equal(rewriteImport("@opentui/solid", outDir), "@opentui/solid")
  assert.throws(() => rewriteImport("../elsewhere.mjs", outDir), /sibling imports/)
})

test("the package points OpenCode at the compiled entry and ships it", () => {
  assert.equal(pkg.exports["./tui"], "./dist/tui.js")
  assert.ok(pkg.files.includes("dist/"))
  assert.equal(pkg.scripts.prepack, "npm run build", "npm pack and publish build first")
  assert.equal(pkg.scripts.build, "node scripts/build.mjs")
  assert.ok(COMPILED.includes("tui"), "the entry that exports['./tui'] names is built")
})
