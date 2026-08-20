import {spawn} from "node:child_process"
import {accessSync, constants} from "node:fs"
import {delimiter, extname, isAbsolute, join, relative, resolve} from "node:path"

const QUERY = `
query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    url
    defaultBranchRef{name}
    branch:pullRequests(headRefName:$branch,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{...PR}}
  }
}
fragment PR on PullRequest{
  number title url isDraft state updatedAt isCrossRepository
  reviewDecision
  latestOpinionatedReviews(first:20){nodes{state}}
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}
}
`

const RECENT = 14 * 24 * 60 * 60 * 1000
const SILENT =
  /no git remotes|not a git repository|known GitHub host|could not determine|ENOENT|Executable not found|not found in \$PATH/i

export type PullRequest = {
  number: number
  title: string
  url: string
  isDraft: boolean
  state: "OPEN" | "MERGED" | "CLOSED"
  updatedAt: string
  isCrossRepository: boolean
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  latestOpinionatedReviews: {nodes: Array<{state: string}>}
  commits: {nodes: Array<{commit: {statusCheckRollup: {state: string} | null}} | null>}
}

export type PullRequestResult = {
  status: "ready" | "error" | "absent"
  prs: PullRequest[]
  unread: number[]
  repo?: string
  error?: string
  onDefault?: boolean
}

export type CommandResult = {code: number; stdout: string; stderr: string}
export type Runner = (command: string, args: string[], cwd: string) => Promise<CommandResult>

export type Tone = "success" | "error" | "warning" | "info" | "subdued"
export type Badge = {glyph?: string; text: string; tone: Tone}

export function resolveExecutable(name: string, unsafeDirectory?: string): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  const names = process.platform === "win32" && !extname(name) ? extensions.map((extension) => name + extension) : [name]

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, "")
    if (!cleanDirectory || !isAbsolute(cleanDirectory)) continue
    for (const candidateName of names) {
      const candidate = join(cleanDirectory, candidateName)
      if (unsafeDirectory) {
        const fromUnsafeDirectory = relative(resolve(unsafeDirectory), resolve(candidate))
        if (fromUnsafeDirectory === "" || (!fromUnsafeDirectory.startsWith("..") && !isAbsolute(fromUnsafeDirectory))) {
          continue
        }
      }
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
        return candidate
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return undefined
}

export function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
}

export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function normalizePullRequest(value: unknown): PullRequest | undefined {
  const raw = object(value)
  if (!raw) return undefined
  if (typeof raw.number !== "number" || typeof raw.title !== "string" || typeof raw.url !== "string") return undefined
  if (typeof raw.isDraft !== "boolean" || typeof raw.updatedAt !== "string" || typeof raw.isCrossRepository !== "boolean") {
    return undefined
  }
  if (raw.state !== "OPEN" && raw.state !== "MERGED" && raw.state !== "CLOSED") return undefined
  const url = safeUrl(raw.url)
  if (!url) return undefined

  const reviews = object(raw.latestOpinionatedReviews)?.nodes
  const reviewNodes = Array.isArray(reviews)
    ? reviews.flatMap((review) => {
        const state = object(review)?.state
        return typeof state === "string" ? [{state}] : []
      })
    : []

  const commits = object(raw.commits)?.nodes
  const commitNodes = Array.isArray(commits)
    ? commits.map((node) => {
        const commit = object(object(node)?.commit)
        if (!commit) return null
        const rollup = object(commit.statusCheckRollup)
        return {commit: {statusCheckRollup: typeof rollup?.state === "string" ? {state: rollup.state} : null}}
      })
    : []

  const decision = raw.reviewDecision
  return {
    number: raw.number,
    title: sanitizeText(raw.title),
    url,
    isDraft: raw.isDraft,
    state: raw.state,
    updatedAt: raw.updatedAt,
    isCrossRepository: raw.isCrossRepository,
    reviewDecision:
      decision === "APPROVED" || decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED" ? decision : null,
    latestOpinionatedReviews: {nodes: reviewNodes},
    commits: {nodes: commitNodes},
  }
}

export function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {cwd, stdio: ["ignore", "pipe", "pipe"]})
    } catch (error) {
      resolve({code: -1, stdout: "", stderr: String(error)})
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({code: -1, stdout, stderr: stderr || `${command} timed out`})
    }, 20_000)

    child.stdout?.on("data", (chunk) => (stdout += chunk))
    child.stderr?.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => finish({code: -1, stdout, stderr: stderr || String(error)}))
    child.on("close", (code) => finish({code: code ?? -1, stdout, stderr}))
  })
}

async function fetchUnread(directory: string, execute: Runner, gh: string): Promise<number[]> {
  const result = await execute(gh, ["api", "--paginate", "/repos/{owner}/{repo}/notifications"], directory)
  if (result.code !== 0) return []

  try {
    const threads: unknown = JSON.parse(result.stdout.trim().replace(/\]\s*\[/g, ","))
    if (!Array.isArray(threads)) return []
    return threads.flatMap((thread) => {
      const raw = object(thread)
      const subject = object(raw?.subject)
      if (raw?.unread !== true || subject?.type !== "PullRequest") return []
      const number = Number(String(subject.url ?? "").match(/\/pulls\/(\d+)$/)?.[1])
      return Number.isFinite(number) ? [number] : []
    })
  } catch {
    return []
  }
}

export async function fetchPullRequests(
  directory: string,
  branch: string,
  execute: Runner = run,
  gh = execute === run ? resolveExecutable("gh", directory) : "gh",
): Promise<PullRequestResult> {
  if (!gh) return {status: "absent", prs: [], unread: []}
  const [result, unread] = await Promise.all([
    execute(
      gh,
      ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `branch=${branch}`, "-f", `query=${QUERY}`],
      directory,
    ),
    fetchUnread(directory, execute, gh),
  ])

  if (result.code !== 0) {
    const message = sanitizeText((result.stderr || result.stdout || "gh failed").trim().split("\n")[0] ?? "gh failed")
    return {status: SILENT.test(message) ? "absent" : "error", error: message, prs: [], unread}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return {status: "error", error: "Unreadable gh response", prs: [], unread}
  }

  const root = object(parsed)
  const repository = object(object(root?.data)?.repository)
  if (!repository) {
    const errors = root?.errors
    const message = Array.isArray(errors) ? object(errors[0])?.message : undefined
    const text = sanitizeText(typeof message === "string" ? message : "Repository not found")
    return {status: SILENT.test(text) ? "absent" : "error", error: text, prs: [], unread}
  }

  const defaultBranch = object(repository.defaultBranchRef)?.name
  const onDefault = !branch || branch === defaultBranch
  const nodes = object(repository.branch)?.nodes
  const prs = onDefault
    ? []
    : (Array.isArray(nodes) ? nodes.flatMap((node) => normalizePullRequest(node) ?? []) : []).filter(
        (pr) => !pr.isCrossRepository && (pr.state === "OPEN" || Date.now() - new Date(pr.updatedAt).getTime() < RECENT),
      )

  return {
    status: "ready",
    prs,
    unread,
    onDefault,
    repo: typeof repository.url === "string" ? safeUrl(repository.url) : undefined,
  }
}

function stateBadge(pr: PullRequest): Badge | undefined {
  if (pr.state === "MERGED") return {text: "merged", tone: "subdued"}
  if (pr.state === "CLOSED") return {text: "closed", tone: "subdued"}
  if (pr.isDraft) return {text: "draft", tone: "subdued"}
  return undefined
}

function reviewBadge(pr: PullRequest): Badge | undefined {
  if (pr.state !== "OPEN") return undefined
  const latest = pr.latestOpinionatedReviews.nodes
  if (latest.some((review) => review.state === "CHANGES_REQUESTED")) return {glyph: "✗", text: "changes", tone: "error"}
  if (pr.reviewDecision === "APPROVED") return {glyph: "✓", text: "approved", tone: "success"}
  const approvals = latest.filter((review) => review.state === "APPROVED").length
  if (approvals > 0) return {glyph: "○", text: `${approvals} approved`, tone: "warning"}
  if (pr.reviewDecision === "REVIEW_REQUIRED") return {glyph: "○", text: "review", tone: "subdued"}
  return undefined
}

function checksBadge(pr: PullRequest): Badge | undefined {
  if (pr.state !== "OPEN") return undefined
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state
  if (!rollup) return undefined
  if (rollup === "SUCCESS") return {glyph: "✓", text: "checks", tone: "success"}
  if (rollup === "FAILURE" || rollup === "ERROR") return {glyph: "✗", text: "checks", tone: "error"}
  return {glyph: "○", text: "checks", tone: "warning"}
}

export function badges(pr: PullRequest, unread: boolean): Badge[] {
  const all = [stateBadge(pr), reviewBadge(pr), checksBadge(pr)]
  if (unread) all.push({glyph: "●", text: "unread", tone: "info"})
  return all.filter((badge): badge is Badge => badge !== undefined)
}

export function truncate(value: string, max: number): string {
  const safeValue = sanitizeText(value)
  return safeValue.length > max ? safeValue.slice(0, max - 1).trimEnd() + "…" : safeValue
}
