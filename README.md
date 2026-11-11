# opencode-github-prs

See the pull request for your current branch without leaving OpenCode 2.

```text
▼ Pull request                                      ↻
  • Add pull request status #42 · ✓ approved · ✓ checks · ● unread
```

The sidebar shows the PR title, number, draft or merged state, review decision,
check status, and unread GitHub notifications. It refreshes every minute, when
the terminal regains focus, or when you select the refresh control.

## Install

Requirements:

- OpenCode 2 beta
- [GitHub CLI](https://cli.github.com/) available as `gh`
- An authenticated GitHub CLI session (`gh auth login`)

The initial release supports github.com PRs opened from a branch in the same
repository. Fork-based PRs and GitHub Enterprise are not yet supported.

Install the plugin globally:

```sh
opencode2 plugin add opencode-github-prs
```

OpenCode adds the TUI-only package to your global `cli.json`. Restart OpenCode
if an existing TUI does not load it immediately.

## Configure

The defaults show up to eight PRs and refresh every 60 seconds. To change them,
replace the plugin's string entry in `~/.config/opencode/cli.json` with:

```json
{
  "plugins": [
    {
      "package": "opencode-github-prs",
      "options": {
        "limit": 8,
        "refresh": 60
      }
    }
  ]
}
```

`limit` is capped at 100. `refresh` is measured in seconds and has a minimum of
15. The section stays hidden on the repository's default branch and outside a
GitHub checkout.

## Develop

```sh
npm install
npm run check
```

To load a checkout, build it and add the checkout directory to `cli.json`:

```sh
npm run build
```

```json
{
  "plugins": ["/path/to/opencode-github-prs"]
}
```

OpenCode ignores a path to a single file such as `src/tui.tsx`. Run
`npm run build` again after changing the source.

The package ships compiled output because OpenCode compiles Solid JSX only for
plugins outside `node_modules`. An installed package that ships raw TSX loads
without error and never updates. For the same reason, installing straight from
Git does not work: the repository holds no build output.

OpenCode 2 and its plugin API are currently beta. This package tracks the beta
API and may need compatible releases as that API changes.

## License

[MIT](LICENSE)
