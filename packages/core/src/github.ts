import { spawnSync } from "node:child_process";
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

function gh(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
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
export function fetchPr(repo: string, number: number): PullRequest | undefined {
  const r = gh(["pr", "view", String(number), "--repo", repo, "--json", PR_FIELDS]);
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
export function listOpenPrs(repo: string, limit = 50): PullRequest[] {
  const r = gh([
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
export function prComments(repo: string, number: number): PrComment[] {
  const r = gh([
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
export function addPrComment(repo: string, number: number, body: string): boolean {
  const r = gh(["pr", "comment", String(number), "--repo", repo, "--body", body]);
  if (r.code !== 0) logger.warn({ repo, number, err: r.err }, "gh pr comment failed");
  return r.code === 0;
}

/** Resolve the `owner/name` GitHub slug for a local repo path (from its origin remote). */
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
