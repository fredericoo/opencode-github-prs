import {describe, expect, it} from "vitest"
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {
  badges,
  fetchPullRequests,
  resolveExecutable,
  safeUrl,
  sanitizeText,
  truncate,
  type CommandResult,
  type PullRequest,
  type Runner,
} from "./github.js"

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "Add pull request status",
    url: "https://github.com/fredericoo/opencode-github-prs/pull/42",
    isDraft: false,
    state: "OPEN",
    updatedAt: new Date().toISOString(),
    isCrossRepository: false,
    reviewDecision: "REVIEW_REQUIRED",
    latestOpinionatedReviews: {nodes: []},
    commits: {nodes: [{commit: {statusCheckRollup: {state: "PENDING"}}}]},
    ...overrides,
  }
}

function runner(graphql: CommandResult, notifications: CommandResult = {code: 0, stdout: "[]", stderr: ""}): Runner {
  return async (_command, args) => (args.includes("graphql") ? graphql : notifications)
}

function response(nodes: unknown[], defaultBranch = "main"): CommandResult {
  return {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      data: {
        repository: {
          url: "https://github.com/fredericoo/opencode-github-prs",
          defaultBranchRef: {name: defaultBranch},
          branch: {nodes},
        },
      },
    }),
  }
}

describe("fetchPullRequests", () => {
  it("returns pull requests for the checked-out branch", async () => {
    const result = await fetchPullRequests("/repo", "feat/status", runner(response([pr()])))

    expect(result.status).toBe("ready")
    expect(result.prs).toHaveLength(1)
    expect(result.prs[0]?.number).toBe(42)
    expect(result.onDefault).toBe(false)
  })

  it("hides pull requests on the default branch", async () => {
    const result = await fetchPullRequests("/repo", "main", runner(response([pr()])))

    expect(result).toMatchObject({status: "ready", prs: [], onDefault: true})
  })

  it("filters cross-repository pull requests with matching branch names", async () => {
    const result = await fetchPullRequests(
      "/repo",
      "feat/status",
      runner(response([pr({isCrossRepository: true}), pr({number: 43})])),
    )

    expect(result.prs.map(({number}) => number)).toEqual([43])
  })

  it("rejects unsafe URLs and strips display-control characters", async () => {
    const result = await fetchPullRequests(
      "/repo",
      "feat/status",
      runner(response([pr({number: 41, url: "javascript:alert(1)"}), pr({title: "Ready\u202eFAILED\n"})])),
    )

    expect(result.prs).toHaveLength(1)
    expect(result.prs[0]?.title).toBe("ReadyFAILED")
  })

  it("marks non-GitHub directories as absent", async () => {
    const result = await fetchPullRequests(
      "/repo",
      "feat/status",
      runner({code: 1, stdout: "", stderr: "fatal: not a git repository"}),
    )

    expect(result.status).toBe("absent")
  })

  it("keeps GitHub API failures visible", async () => {
    const result = await fetchPullRequests(
      "/repo",
      "feat/status",
      runner({code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded"}),
    )

    expect(result).toMatchObject({status: "error", error: "HTTP 403: API rate limit exceeded"})
  })

  it("adds GitHub notification state without failing when notifications are unavailable", async () => {
    const notifications = {
      code: 0,
      stderr: "",
      stdout: JSON.stringify([
        {unread: true, subject: {type: "PullRequest", url: "https://api.github.com/repos/a/b/pulls/42"}},
      ]),
    }
    const withUnread = await fetchPullRequests("/repo", "feat/status", runner(response([pr()]), notifications))
    const withoutUnread = await fetchPullRequests(
      "/repo",
      "feat/status",
      runner(response([pr()]), {code: 1, stdout: "", stderr: "forbidden"}),
    )

    expect(withUnread.unread).toEqual([42])
    expect(withoutUnread.unread).toEqual([])
    expect(withoutUnread.prs).toHaveLength(1)
  })

  it("combines paginated notification responses", async () => {
    const page = (number: number) =>
      JSON.stringify([{unread: true, subject: {type: "PullRequest", url: `https://api.github.com/repos/a/b/pulls/${number}`}}])
    const notifications = {code: 0, stderr: "", stdout: `${page(41)}\n${page(42)}`}

    const result = await fetchPullRequests("/repo", "feat/status", runner(response([pr()]), notifications))

    expect(result.unread).toEqual([41, 42])
  })
})

describe("badges", () => {
  it("shows review, checks, and unread status", () => {
    expect(badges(pr(), true)).toEqual([
      {glyph: "○", text: "review", tone: "subdued"},
      {glyph: "○", text: "checks", tone: "warning"},
      {glyph: "●", text: "unread", tone: "info"},
    ])
  })

  it("prefers a latest changes-requested review over an aggregate approval", () => {
    const result = badges(
      pr({reviewDecision: "APPROVED", latestOpinionatedReviews: {nodes: [{state: "CHANGES_REQUESTED"}]}}),
      false,
    )

    expect(result[0]).toEqual({glyph: "✗", text: "changes", tone: "error"})
  })

  it("shows merged state without live review or check badges", () => {
    expect(badges(pr({state: "MERGED"}), false)).toEqual([{text: "merged", tone: "subdued"}])
  })
})

describe("truncate", () => {
  it("shortens long titles", () => {
    expect(truncate("A title that is too long", 12)).toBe("A title tha…")
  })
})

describe("untrusted display values", () => {
  it("allows only HTTPS links", () => {
    expect(safeUrl("https://github.com/example/repo/pull/1")).toBe("https://github.com/example/repo/pull/1")
    expect(safeUrl("http://github.example.com/repo/pull/1")).toBeUndefined()
  })

  it("removes terminal and bidi controls", () => {
    expect(sanitizeText("safe\u001b[31m\u061c\u200e\u202etext")).toBe("safe[31mtext")
  })
})

describe("resolveExecutable", () => {
  it("ignores relative PATH entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-github-prs-path-"))
    const previousDirectory = process.cwd()
    const path = process.env.PATH
    try {
      mkdirSync(join(directory, "bin"))
      writeFileSync(join(directory, "bin", "gh"), "#!/bin/sh\n")
      chmodSync(join(directory, "bin", "gh"), 0o755)
      process.chdir(directory)
      process.env.PATH = "bin"
      expect(resolveExecutable("gh")).toBeUndefined()
    } finally {
      process.chdir(previousDirectory)
      process.env.PATH = path
      rmSync(directory, {recursive: true, force: true})
    }
  })

  it("ignores executables inside the checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-github-prs-checkout-"))
    const bin = join(directory, "bin")
    const path = process.env.PATH
    try {
      mkdirSync(bin)
      writeFileSync(join(bin, "gh"), "#!/bin/sh\n")
      chmodSync(join(bin, "gh"), 0o755)
      process.env.PATH = bin
      expect(resolveExecutable("gh", directory)).toBeUndefined()
    } finally {
      process.env.PATH = path
      rmSync(directory, {recursive: true, force: true})
    }
  })
})
