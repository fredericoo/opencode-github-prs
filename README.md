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

To load a checkout directly, add the absolute entrypoint path to `cli.json`:

```json
{
  "plugins": ["/path/to/opencode-github-prs/src/tui.tsx"]
}
```

OpenCode 2 and its plugin API are currently beta. This package tracks the beta
API and may need compatible releases as that API changes.

## License

[MIT](LICENSE)
