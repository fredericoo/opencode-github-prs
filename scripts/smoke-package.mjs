import {execFileSync} from "node:child_process"
import {mkdtempSync, readFileSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

const directory = mkdtempSync(join(tmpdir(), "opencode-github-prs-"))
const npmEnvironment = {...process.env, npm_config_dry_run: "false"}

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
      encoding: "utf8",
      env: npmEnvironment,
    }),
  )[0]
  const paths = packed.files.map((file) => file.path).sort()
  const expected = ["LICENSE", "README.md", "dist/tui.js", "package.json"]
  if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error(`Unexpected package files: ${paths.join(", ")}`)

  const install = join(directory, "install")
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", install, join(directory, packed.filename)], {
    env: npmEnvironment,
    stdio: "ignore",
  })

  const entrypoint = join(install, "node_modules", "opencode-github-prs", "dist", "tui.js")
  // OpenCode does not compile Solid JSX under node_modules. An entrypoint that
  // reaches for the JSX runtime was not compiled, and renders once and never updates.
  if (/jsx(-dev)?-runtime/.test(readFileSync(entrypoint, "utf8"))) throw new Error("Entrypoint is not compiled Solid output")
  const script = `const plugin = await import(${JSON.stringify(entrypoint)}); if (plugin.default.id !== "fredericoo.github-prs") process.exit(1)`
  execFileSync("bun", ["-e", script], {cwd: directory, stdio: "inherit"})
} finally {
  rmSync(directory, {recursive: true, force: true})
}
