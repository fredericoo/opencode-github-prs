import solidPlugin from "@opentui/solid/bun-plugin"

// OpenCode compiles Solid JSX for plugins it loads from a local directory, but
// not for anything under node_modules. An installed package that ships raw TSX
// loads without error and never re-renders, so the published entrypoint has to
// be compiled ahead of time.
const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
