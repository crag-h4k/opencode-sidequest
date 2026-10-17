import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("npm test discovers each suite and reports a failing test", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sidequest-test-command-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: scripts.test } }))
  mkdirSync(join(directory, "test"))
  const suite = (name, assertion = "") => `import test from "node:test"; test("${name}", () => { ${assertion} });`
  writeFileSync(join(directory, "test", "first.test.mjs"), suite("first suite"))
  const second = join(directory, "test", "second.test.mjs")
  writeFileSync(second, suite("second suite"))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = () => spawnSync("npm", ["test"], { cwd: directory, env, encoding: "utf8", timeout: 30_000 })

  const passing = run()
  assert.equal(passing.status, 0, passing.stdout + passing.stderr)
  assert.match(passing.stdout, /first suite/)
  assert.match(passing.stdout, /second suite/)

  writeFileSync(second, suite("second suite", 'throw new Error("assertion sentinel")'))
  const failing = run()
  assert.equal(failing.status, 1, failing.stdout + failing.stderr)
  assert.match(failing.stdout + failing.stderr, /assertion sentinel/)
})
