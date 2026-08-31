import { spawn, spawnSync } from "node:child_process";
import { logger } from "./logger.js";

/** A pull request as Milo cares about it for attach-mode work. */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headRefName: string; // the PR's branch
  baseRefName: string; // the branch it targets
  state: string; // OPEN | MERGED | CLOSED
  url: string;
  isCrossRepository: boolean;
  author: string;
  assignees: string[];
  labels: string[];
  updatedAt: string;
}

/**
 * Shell out to `gh` WITHOUT blocking the event loop. Every call here is a network round-trip to
 * github.com (~0.5s each, far worse on a flaky link), and the GitHub poller makes one per open PR
 * per cycle — dozens. Under `spawnSync` that froze the single daemon event loop for the whole poll,
 * which starved the webhook server: Linear's delegation POST connected but never got a reply, timed
 * out, and the agent session ended up `stale` with no job ever enqueued. Same reasoning as
 * `worktree.ts`'s `run` — keep the loop free while the child runs.
 */
function gh(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    // `error` fires when the binary can't be spawned (e.g. ENOENT) — mirror spawnSync's failure shape.
    child.on("error", (e) => resolve({ code: 1, out: out.trim(), err: (err + String(e.message)).trim() }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }));
  });
}

const PR_FIELDS =
  "number,title,body,headRefName,baseRefName,state,url,isCrossRepository,author,assignees,labels,updatedAt";

function normalizePr(r: any): PullRequest {
  return {
    number: r.number,
    title: r.title ?? "",
    body: r.body ?? "",
    headRefName: r.headRefName,
    baseRefName: r.baseRefName,
    state: r.state,
    url: r.url,
    isCrossRepository: !!r.isCrossRepository,
    author: r.author?.login ?? "unknown",
    assignees: (r.assignees ?? []).map((a: any) => a.login),
    labels: (r.labels ?? []).map((l: any) => l.name),
    updatedAt: r.updatedAt ?? "",
  };
}

/** Fetch a single PR's details from `repo` (owner/name). */
export async function fetchPr(repo: string, number: number): Promise<PullRequest | undefined> {
  const r = await gh(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
  if (r.code !== 0) {
    logger.warn({ repo, number, err: r.err }, "gh pr view failed");
    return undefined;
  }
  try {
    return normalizePr(JSON.parse(r.out));
  } catch {
    return undefined;
  }
}

/** List open PRs in `repo` (owner/name). */
export async function listOpenPrs(repo: string, limit = 50): Promise<PullRequest[]> {
  const r = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    PR_FIELDS,
  ]);
  if (r.code !== 0) {
    logger.warn({ repo, err: r.err }, "gh pr list failed");
    return [];
  }
  try {
    return (JSON.parse(r.out) as any[]).map(normalizePr);
  } catch {
    return [];
  }
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
}

/** Fetch a PR's issue-comments (used to detect `@milo` mentions). */
export async function prComments(repo: string, number: number): Promise<PrComment[]> {
  const r = await gh([
    "api",
    `repos/${repo}/issues/${number}/comments`,
    "--jq",
    ".[] | {author: .user.login, body: .body, createdAt: .created_at}",
  ]);
  if (r.code !== 0) return [];
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as PrComment;
      } catch {
        return null;
      }
    })
    .filter((c): c is PrComment => c !== null);
}

/** Post a comment on a PR. Returns true on success. */
export async function addPrComment(repo: string, number: number, body: string): Promise<boolean> {
  const r = await gh(["pr", "comment", String(number), "--repo", repo, "--body", body]);
  if (r.code !== 0) logger.warn({ repo, number, err: r.err }, "gh pr comment failed");
  return r.code === 0;
}

/**
 * Resolve the `owner/name` GitHub slug for a local repo path (from its origin remote).
 * Deliberately still synchronous: unlike the `gh` calls above this is a LOCAL git read (~5ms,
 * no network), and it is reached from the synchronous `resolveRepo` router that most callers
 * depend on. Making it async would ripple through the whole config/router surface to buy
 * nothing — it is not what was blocking the loop.
 */
export function githubSlugForPath(repoPath: string): string | undefined {
  const r = spawnSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return undefined;
  const url = (r.stdout ?? "").trim();
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : undefined;
}
