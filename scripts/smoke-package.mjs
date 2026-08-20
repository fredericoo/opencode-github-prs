import {execFileSync} from "node:child_process"
import {mkdtempSync, rmSync} from "node:fs"
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
  const expected = ["LICENSE", "README.md", "package.json", "src/github.ts", "src/tui.tsx"]
  if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error(`Unexpected package files: ${paths.join(", ")}`)

  const install = join(directory, "install")
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", install, join(directory, packed.filename)], {
    env: npmEnvironment,
    stdio: "ignore",
  })

  const entrypoint = join(install, "node_modules", "opencode-github-prs", "src", "tui.tsx")
  const script = `const plugin = await import(${JSON.stringify(entrypoint)}); if (plugin.default.id !== "fredericoo.github-prs") process.exit(1)`
  execFileSync("bun", ["-e", script], {cwd: directory, stdio: "inherit"})
} finally {
  rmSync(directory, {recursive: true, force: true})
}
