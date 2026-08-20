/** @jsxImportSource @opentui/solid */

import {spawn} from "node:child_process"
import {join} from "node:path"

import {Plugin} from "@opencode-ai/plugin/tui"
import type {Context} from "@opencode-ai/plugin/tui/context"
import {createEffect, createMemo, For, on, onCleanup, Show} from "solid-js"

import {
  badges,
  fetchPullRequests,
  resolveExecutable,
  safeUrl,
  truncate,
  type PullRequest,
  type PullRequestResult,
  type Tone,
} from "./github.js"

type Entry = Omit<PullRequestResult, "status"> & {at: number; status: PullRequestResult["status"] | "loading"}
type Cache = Record<string, Entry>

function openInBrowser(url: string) {
  const trustedUrl = safeUrl(url)
  if (!trustedUrl) return

  const [command, args] =
    process.platform === "darwin"
      ? ["/usr/bin/open", [trustedUrl]]
      : process.platform === "win32"
        ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", trustedUrl]]
        : [resolveExecutable("xdg-open"), [trustedUrl]]
  if (!command) return

  try {
    const child = spawn(command, args, {detached: true, stdio: "ignore"})
    child.on("error", () => {})
    child.unref()
  } catch {
    // OSC-8 links remain usable when the platform URL opener is unavailable.
  }
}

function View(props: {context: Context; sessionID: string}) {
  const context = props.context
  const theme = context.theme
  const limit = Math.min(100, Math.max(1, Number(context.options.limit) || 8))
  const refresh = Math.max(15, Number(context.options.refresh) || 60) * 1000

  const [collapsed, setCollapsed] = context.storage.store("collapsed", {initial: {value: false}})
  const [cache, setCache] = context.storage.memory("cache", {initial: {} as Cache})

  const location = createMemo(() => context.data.session.get(props.sessionID)?.location ?? context.location)
  const directory = createMemo(() => location()?.directory)
  const branch = createMemo(() => context.data.location.vcs.info(location())?.branch?.current ?? "")
  const key = createMemo(() => `${directory() ?? ""}\u0000${branch()}`)
  const entry = createMemo(() => cache[key()])

  const tone = (value: Tone) => (value === "subdued" ? theme.text.subdued : theme.text.feedback[value].default)

  const load = async (maxAge: number) => {
    const dir = directory()
    if (!dir) return
    const id = key()
    const current = cache[id]
    if (current?.status === "loading" && Date.now() - current.at < 60_000) return
    if (current && Date.now() - current.at < maxAge) return

    setCache((draft) => {
      draft[id] = {...(current ?? {prs: [], unread: []}), status: "loading", at: Date.now()}
    })
    const result = await fetchPullRequests(dir, branch())
    setCache((draft) => {
      draft[id] = {...result, at: Date.now()}
    })
  }

  createEffect(
    on(directory, () => {
      const value = location()
      if (value) void context.data.location.vcs.sync(value)
    }),
  )
  createEffect(on(key, () => void load(refresh)))

  const timer = setInterval(() => void load(refresh), refresh)
  onCleanup(() => clearInterval(timer))

  const onFocus = () => void load(15_000)
  context.renderer.on("focus", onFocus)
  onCleanup(() => context.renderer.off("focus", onFocus))

  const prs = createMemo(() => entry()?.prs ?? [])
  const unread = createMemo(() => new Set(entry()?.unread ?? []))
  const shown = createMemo(() => prs().slice(0, limit))
  const hidden = createMemo(() => Math.max(0, prs().length - limit))
  const visible = createMemo(() => {
    const value = entry()
    if (!value || value.status === "absent") return false
    if (value.status === "error" || value.prs.length > 0) return true
    return value.status === "ready" && value.onDefault === false
  })

  const dot = (pr: PullRequest) => {
    if (pr.state === "MERGED") return theme.hue.purple[500]
    if (pr.state === "CLOSED") return theme.text.feedback.error.default
    if (pr.isDraft) return theme.text.subdued
    return theme.text.feedback.success.default
  }

  return (
    <Show when={visible()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.default} onMouseDown={() => setCollapsed((draft) => (draft.value = !draft.value))}>
            {collapsed.value ? "▶" : "▼"} <b>{prs().length === 1 ? "Pull request" : "Pull requests"}</b>
            <Show when={prs().length > 1}>
              <span style={{fg: theme.text.subdued}}> ({prs().length})</span>
            </Show>
          </text>
          <text flexShrink={0} fg={theme.text.subdued} onMouseDown={() => void load(0)}>
            {entry()?.status === "loading" ? "·" : "↻"}
          </text>
        </box>

        <Show when={!collapsed.value}>
          <Show when={entry()?.status === "error"}>
            <text fg={theme.text.feedback.error.subdued} wrapMode="word">
              {truncate(entry()?.error ?? "gh failed", 120)}
            </text>
          </Show>

          <Show when={entry()?.status !== "error" && prs().length === 0}>
            <text fg={theme.text.subdued} wrapMode="word">
              {entry()?.status === "loading" ? "Loading…" : "None open for this branch"}
            </text>
          </Show>

          <For each={shown()}>
            {(pr) => (
              <box flexDirection="row" gap={1} onMouseUp={() => openInBrowser(pr.url)}>
                <text flexShrink={0} fg={dot(pr)}>
                  •
                </text>
                <text fg={theme.text.default} wrapMode="word">
                  <a href={pr.url}>{truncate(pr.title, 64)}</a>
                  <span style={{fg: theme.text.subdued}}>{" #" + pr.number}</span>
                  <For each={badges(pr, unread().has(pr.number))}>
                    {(badge) => (
                      <>
                        <span style={{fg: theme.text.subdued}}> · </span>
                        <Show when={badge.glyph}>
                          <span style={{fg: tone(badge.tone)}}>{badge.glyph} </span>
                        </Show>
                        <span style={{fg: theme.text.subdued}}>{badge.text}</span>
                      </>
                    )}
                  </For>
                </text>
              </box>
            )}
          </For>

          <Show when={hidden() > 0 && entry()?.repo}>
            <text fg={theme.text.subdued} onMouseUp={() => openInBrowser(`${entry()?.repo}/pulls`)}>
              <a href={`${entry()?.repo}/pulls`}>+{hidden()} more</a>
            </text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "fredericoo.github-prs",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <View context={context} sessionID={props.sessionID} />,
    })
  },
})
