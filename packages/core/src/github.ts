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

// ---------------------------------------------------------------- attach-mode PR context

/** How much of `gh pr diff` the attach prompt carries verbatim. */
export const PR_DIFF_HEAD_LINES = 200;

export interface PrReviewThread {
  path: string;
  line: number | null;
  author: string;
  /** The thread's FIRST comment — the review remark itself. */
  body: string;
}

/**
 * What the attach prompt needs to iterate on a PR without re-deriving it: the diff (stat + head),
 * unresolved review threads, the latest review verdicts, and the names of failing checks. Every
 * field is best-effort — a `gh` failure yields an empty section, never a failed job.
 */
export interface PrContext {
  diffStat?: string;
  diffHead?: string;
  diffTruncated?: boolean;
  reviewThreads: PrReviewThread[];
  reviews: { author: string; state: string }[];
  failingChecks: string[];
}

/** `gh pr diff --stat` + the first `maxLines` lines of `gh pr diff`. */
export async function prDiff(
  repo: string,
  number: number,
  maxLines = PR_DIFF_HEAD_LINES,
): Promise<Pick<PrContext, "diffStat" | "diffHead" | "diffTruncated">> {
  const out: Pick<PrContext, "diffStat" | "diffHead" | "diffTruncated"> = {};
  const stat = await gh(["pr", "diff", String(number), "--repo", repo, "--stat"]);
  if (stat.code === 0 && stat.out) out.diffStat = stat.out;
  const full = await gh(["pr", "diff", String(number), "--repo", repo]);
  if (full.code === 0 && full.out) {
    const lines = full.out.split("\n");
    out.diffHead = lines.slice(0, maxLines).join("\n");
    out.diffTruncated = lines.length > maxLines;
  }
  return out;
}

/** Unresolved review threads (first 50), each reduced to its first comment. */
export async function prReviewThreads(repo: string, number: number): Promise<PrReviewThread[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return [];
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 50) {
          nodes { isResolved isOutdated path line originalLine
            comments(first: 1) { nodes { body author { login } } } }
        }
      }
    }
  }`;
  const r = await gh(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]);
  if (r.code !== 0) {
    logger.warn({ repo, number, err: r.err }, "gh api graphql reviewThreads failed");
    return [];
  }
  try {
    const nodes = (JSON.parse(r.out)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as any[];
    return nodes
      .filter((t) => !t.isResolved)
      .map((t) => {
        const first = t.comments?.nodes?.[0];
        return {
          path: t.path ?? "",
          line: (t.line ?? t.originalLine ?? null) as number | null,
          author: first?.author?.login ?? "unknown",
          body: first?.body ?? "",
        };
      })
      .filter((t) => t.body.trim());
  } catch {
    return [];
  }
}

/** The latest review state per reviewer (`gh pr view --json latestReviews`). */
export async function prLatestReviews(repo: string, number: number): Promise<{ author: string; state: string }[]> {
  const r = await gh(["pr", "view", String(number), "--repo", repo, "--json", "latestReviews"]);
  if (r.code !== 0) return [];
  try {
    return ((JSON.parse(r.out)?.latestReviews ?? []) as any[]).map((v) => ({
      author: v.author?.login ?? "unknown",
      state: v.state ?? "UNKNOWN",
    }));
  } catch {
    return [];
  }
}

/** Names of checks in the `fail` bucket (`gh pr checks --json`). */
export async function prFailingChecks(repo: string, number: number): Promise<string[]> {
  const r = await gh(["pr", "checks", String(number), "--repo", repo, "--json", "name,bucket,state"]);
  // `gh pr checks` exits 8 when checks are pending and 1 when some failed — the JSON is still valid.
  if (!r.out) return [];
  try {
    return ((JSON.parse(r.out) ?? []) as any[])
      .filter((c) => c.bucket === "fail" || /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED)$/i.test(c.state ?? ""))
      .map((c) => String(c.name ?? "unnamed check"));
  } catch {
    return [];
  }
}

/**
 * Everything the attach prompt wants about a PR, each part best-effort. The four `gh` round-trips
 * run concurrently — and, like every `gh` call in this file, off the event loop, so assembling an
 * attach prompt never stalls the daemon's heartbeat or webhook server.
 */
export async function fetchPrContext(repo: string, number: number): Promise<PrContext> {
  const [diff, reviewThreads, reviews, failingChecks] = await Promise.all([
    prDiff(repo, number),
    prReviewThreads(repo, number),
    prLatestReviews(repo, number),
    prFailingChecks(repo, number),
  ]);
  return { ...diff, reviewThreads, reviews, failingChecks };
}

/** `owner/name` + number from a PR URL, or undefined when it isn't one. */
export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? { repo: m[1]!, number: parseInt(m[2]!, 10) } : undefined;
}
