// scripts/verify-pack.mjs
// Packs the package the way `npm publish` does, then checks the tarball itself
// instead of the working tree. OpenCode applies its Solid transform only to files
// outside node_modules, so an installed package has to ship the compiled terminal
// half. A tarball that exports raw TSX, or compiled output whose imports do not
// resolve, installs cleanly and then paints once and never updates.
//
// Convention the check relies on: a generated file ends in .js and is checked for
// leftover JSX; hand-written modules end in .mjs or .ts and are only followed.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, posix, relative, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const TUI_EXPORT = "./tui"
const SOLID_EFFECT = /import\s*\{[^}]*\beffect as [\w$]+[^}]*\}\s*from\s*"@opentui\/solid"/
const JSX_LEFTOVERS = /jsx-runtime|jsxDEV|\b_?jsxs?\(|<\/[A-Za-z]|\/>/
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g

/** String leaves of an exports map, with the key path that leads to each. */
function exportTargets(exports, key = ".") {
  if (typeof exports === "string") return [[key, exports]]
  if (!exports || typeof exports !== "object") return []
  return Object.entries(exports).flatMap(([name, value]) =>
    exportTargets(value, name.startsWith(".") ? name : `${key} (${name})`),
  )
}

/**
 * @param {{ pkg: any, files: string[], read: (path: string) => string }} pack
 *   files are tarball paths relative to the package root, with forward slashes
 * @returns {string[]} problems; empty when the tarball is sound
 */
export function checkPack({ pkg, files, read }) {
  const problems = []
  const present = new Set(files)

  for (const [key, target] of exportTargets(pkg.exports)) {
    if (!present.has(posix.normalize(target))) {
      problems.push(`exports["${key}"] names ${target}, which is not in the tarball`)
    }
  }

  const entry = pkg.exports?.[TUI_EXPORT]
  if (typeof entry !== "string") {
    problems.push(`exports["${TUI_EXPORT}"] must be a string path to compiled JavaScript`)
    return problems
  }
  if (!/\.js$/.test(entry)) {
    problems.push(
      `exports["${TUI_EXPORT}"] is ${entry}; it must name compiled .js, because OpenCode does not compile Solid JSX under node_modules`,
    )
    return problems
  }

  const entryPath = posix.normalize(entry)
  const seen = new Set()
  const queue = [entryPath]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file) || !present.has(file)) continue
    seen.add(file)
    const code = read(file)
    if (JSX_LEFTOVERS.test(code)) problems.push(`${file} still contains JSX or the automatic JSX runtime`)
    if (file === entryPath && !SOLID_EFFECT.test(code)) {
      problems.push(`${file} does not import effect from @opentui/solid, so its output would not update after the first paint`)
    }
    for (const [, specifier] of code.matchAll(RELATIVE_IMPORT)) {
      if (specifier.endsWith(".tsx")) {
        problems.push(`${file} imports ${specifier}; a .tsx file would not be compiled once installed`)
        continue
      }
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier))
      if (!present.has(resolved)) {
        problems.push(`${file} imports ${specifier}, which is not in the tarball`)
        continue
      }
      if (resolved.endsWith(".js")) queue.push(resolved)
    }
  }
  return problems
}

/**
 * Runs npm pack (which fires prepack and so the build), unpacks the tarball into a
 * scratch directory, and checks it.
 * @param {{ root?: string }} [options]
 */
export function packAndCheck({ root = ROOT } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "verify-pack-"))
  try {
    execFileSync("npm", ["pack", "--silent", "--pack-destination", scratch], { cwd: root, stdio: ["ignore", "ignore", "inherit"] })
    const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"))
    if (!tarball) throw new Error("npm pack produced no tarball")
    const unpacked = join(scratch, "unpacked")
    mkdirSync(unpacked)
    execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", unpacked])
    const base = join(unpacked, "package")
    const files = readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join("/"))
    const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"))
    const problems = checkPack({ pkg, files, read: (path) => readFileSync(join(base, path), "utf8") })
    return { tarball, files, problems }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { tarball, files, problems } = packAndCheck()
  if (problems.length) {
    for (const problem of problems) console.error(`verify-pack: ${problem}`)
    process.exit(1)
  }
  console.log(`verify-pack: ${tarball} is sound (${files.length} files)`)
}
