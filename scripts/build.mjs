// scripts/build.mjs
// Compiles tui.tsx into dist/tui.js with the same Solid transform OpenCode
// applies to a plugin loaded from a path. OpenCode skips everything under
// node_modules, so an installed package has to ship the compiled form. Without it
// the side panel paints once and never updates: pages do not change, the footer
// hints stay on their first text, and the MCP list does not collapse.
//
// Only the TSX file is compiled. Its relative imports point back at the package
// root, so the logic modules exist once.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Basenames of the root-level .tsx files that ship compiled. */
export const COMPILED = ["tui"]

// The transform OpenCode itself applies to path-loaded plugins. It is not in the
// package's export map, so load it by file URL from the installed package.
async function loadTransform() {
  const entry = fileURLToPath(import.meta.resolve("@opentui/solid"))
  const module = await import(pathToFileURL(join(dirname(entry), "scripts", "solid-transform.js")).href)
  return module.transformSolidSource
}

function toSpecifier(path) {
  const posix = path.split(sep).join("/")
  return posix.startsWith(".") ? posix : `./${posix}`
}

/**
 * Where a relative import in a root-level .tsx file points once the file moves to outDir.
 * @param {string} specifier  as written in the source
 * @param {string} outDir
 */
export function rewriteImport(specifier, outDir) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier
  const name = specifier.replace(/^\.\//, "").replace(/\.tsx$/, "")
  if (specifier.endsWith(".tsx") && COMPILED.includes(name)) return `./${name}.js`
  if (!specifier.startsWith("./")) throw new Error(`Cannot rewrite ${specifier}: only sibling imports are supported`)
  return toSpecifier(relative(outDir, join(ROOT, specifier)))
}

/**
 * @param {{ outDir?: string }} [options]
 * @returns {Promise<string[]>} the files written
 */
export async function build({ outDir = join(ROOT, "dist") } = {}) {
  const transform = await loadTransform()
  await mkdir(outDir, { recursive: true })
  const written = []
  for (const name of COMPILED) {
    const filename = join(ROOT, `${name}.tsx`)
    const code = await transform(await readFile(filename, "utf8"), {
      filename,
      resolvePath: (specifier) => rewriteImport(specifier, outDir),
    })
    const target = join(outDir, `${name}.js`)
    await writeFile(target, `// Generated from ${name}.tsx by scripts/build.mjs. Do not edit.\n${code}\n`)
    written.push(target)
  }
  return written
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const file of await build()) console.log(relative(ROOT, file))
}
