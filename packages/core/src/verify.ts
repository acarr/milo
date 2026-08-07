import { spawnSync } from "node:child_process";
import { logger } from "./logger.js";

function sh(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const git = (wt: string, args: string[]) => sh("git", args, wt);
const gh = (wt: string, args: string[]) => sh("gh", args, wt);

export interface GroundTruth {
  codeChanged: boolean;
  commitsAhead: number;
  dirty: boolean;
  pushed: boolean;
  prUrl: string | null;
  prState: string | null;
}

/** Resolve the real state of the worktree/branch — never trust the agent's self-report. */
export function resolveGroundTruth(worktreePath: string, baseBranch: string, branch: string): GroundTruth {
  const countAhead = () => {
    let r = git(worktreePath, ["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
    if (r.code !== 0) r = git(worktreePath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
    const n = parseInt(r.out, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const commitsAhead = countAhead();
  const dirty = git(worktreePath, ["status", "--porcelain"]).out !== "";

  const hasUpstream = git(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).code === 0;
  let pushed = false;
  if (hasUpstream) {
    const ahead = parseInt(git(worktreePath, ["rev-list", "--count", "@{u}..HEAD"]).out, 10);
    pushed = Number.isFinite(ahead) ? ahead === 0 : false;
  }

  const prRes = gh(worktreePath, ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state"]);
  let prUrl: string | null = null;
  let prState: string | null = null;
  if (prRes.code === 0) {
    try {
      const prs = JSON.parse(prRes.out) as { url: string; state: string }[];
      if (prs.length) {
        prUrl = prs[0]!.url;
        prState = prs[0]!.state;
      }
    } catch {
      /* ignore */
    }
  }

  return { codeChanged: commitsAhead > 0 || dirty, commitsAhead, dirty, pushed, prUrl, prState };
}

export interface EnsurePushedResult {
  pushed: boolean;
  committed: boolean;
}

/**
 * Attach mode: the PR already exists, so we must NOT create another — just make sure any
 * follow-up work is committed and pushed to the existing branch (which updates the PR).
 *
 * Works from a normal (branch checked out) worktree and from a DETACHED one (the fallback when the
 * branch is checked out elsewhere): detached HEAD can't push as plain `HEAD`, so commits are pushed
 * to the PR branch by refspec (`HEAD:refs/heads/<branch>`).
 */
export function ensurePushed(worktreePath: string, baseBranch: string, branch: string, message: string): EnsurePushedResult {
  const gt = resolveGroundTruth(worktreePath, baseBranch, branch);
  let committed = false;
  if (gt.dirty) {
    git(worktreePath, ["add", "-A"]);
    const c = git(worktreePath, ["commit", "-m", message]);
    committed = c.code === 0;
    if (!committed) logger.warn({ out: c.out }, "commit during attach push reported an issue");
  }
  const detached = git(worktreePath, ["symbolic-ref", "-q", "HEAD"]).code !== 0;
  const target = detached ? `HEAD:refs/heads/${branch}` : "HEAD";
  const push = git(worktreePath, ["push", "origin", target]);
  if (push.code !== 0) {
    logger.warn({ out: push.out }, "push during attach reported an issue");
    return { pushed: false, committed };
  }
  return { pushed: true, committed };
}

export interface EnsurePrInput {
  worktreePath: string;
  baseBranch: string;
  branch: string;
  ref: string; // e.g. SBX-1 (used for the commit message / logs)
  title: string;
  summary: string;
  /** Issue/ticket id to auto-close on merge (`Closes <id>`). Omit for jobs with no ticket (scheduled prompts). */
  closes?: string;
  /**
   * Set when the run did not finish cleanly. The PR is opened as a draft and says so up front —
   * the "code never lives without a PR" guarantee still holds, but nobody should read a crashed
   * run's half-written worktree as a finished implementation.
   */
  incomplete?: { reason: string };
}

export interface EnsurePrResult {
  prUrl: string;
  remediated: boolean; // true if Milo had to create/push it itself
}

/** Commit subjects on `branch` that aren't on the base, oldest first. */
function commitSubjects(worktreePath: string, baseBranch: string): string[] {
  for (const base of [`origin/${baseBranch}`, baseBranch]) {
    const r = git(worktreePath, ["log", "--reverse", "--format=%s", `${base}..HEAD`]);
    if (r.code === 0) return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return [];
}

/** `28 files changed, 11895 insertions(+), 393 deletions(-)` — or undefined if git can't say. */
function diffStat(worktreePath: string, baseBranch: string): string | undefined {
  for (const base of [`origin/${baseBranch}`, baseBranch]) {
    const r = git(worktreePath, ["diff", "--shortstat", `${base}...HEAD`]);
    if (r.code === 0 && r.out) return r.out;
  }
  return undefined;
}

const MAX_LISTED_COMMITS = 20;

/**
 * Build the PR description Milo writes when it opens the PR itself.
 *
 * The agent's `summary` is one or two sentences at best, and is missing entirely whenever its run
 * died or its `MILO_RESULT` line didn't parse — which is how PRs like #707 ended up described as
 * nothing but `Implements WAZ-1150`. So the body is grounded in what git can prove happened
 * (commits, diffstat) and treats the agent's summary as a bonus rather than the whole story.
 */
export function buildPrBody(input: {
  worktreePath: string;
  baseBranch: string;
  ref: string;
  summary: string;
  closes?: string;
  incomplete?: { reason: string };
}): string {
  const { worktreePath, baseBranch, ref, summary, closes, incomplete } = input;
  const parts: string[] = [];

  if (incomplete) {
    parts.push(
      `> [!WARNING]\n` +
        `> **This run did not finish.** ${incomplete.reason}\n` +
        `>\n` +
        `> Milo opened this PR as a **draft** so the work isn't lost, but nothing here has been\n` +
        `> confirmed complete or verified. Review the diff before trusting it.`,
    );
  }

  parts.push(`## Summary\n\n${summary.trim() || `Milo's agent left no summary for ${ref}. What it changed, from git:`}`);

  const commits = commitSubjects(worktreePath, baseBranch);
  if (commits.length) {
    const listed = commits.slice(0, MAX_LISTED_COMMITS).map((c) => `- ${c}`);
    if (commits.length > MAX_LISTED_COMMITS) listed.push(`- …and ${commits.length - MAX_LISTED_COMMITS} more`);
    parts.push(`## Commits\n\n${listed.join("\n")}`);
  }

  const stat = diffStat(worktreePath, baseBranch);
  if (stat) parts.push(`## Files changed\n\n${stat}`);

  if (closes) parts.push(`Closes ${closes}`);
  parts.push(`_PR opened by Milo's verification gate._`);
  return parts.join("\n\n");
}

/**
 * Guarantee that written code has an open PR. If the agent already opened one, returns it.
 * Otherwise Milo commits (if dirty), pushes (if needed), and opens the PR itself — so code is
 * never left without a PR (the classic failure mode of naive coding agents), with no dependence on the model.
 */
export function ensurePr(input: EnsurePrInput): EnsurePrResult {
  const { worktreePath, baseBranch, branch, ref, title, summary, closes, incomplete } = input;
  const gt = resolveGroundTruth(worktreePath, baseBranch, branch);
  if (gt.prUrl) return { prUrl: gt.prUrl, remediated: false };

  logger.warn({ ref, branch, incomplete: incomplete?.reason }, "code present but no PR — Milo is opening it directly");

  if (gt.dirty) {
    git(worktreePath, ["add", "-A"]);
    const message = incomplete ? `${ref}: ${title} (partial — run did not finish)` : `${ref}: ${title}`;
    const c = git(worktreePath, ["commit", "-m", message]);
    if (c.code !== 0) logger.warn({ out: c.out }, "commit during remediation reported an issue");
  }
  const push = git(worktreePath, ["push", "-u", "origin", "HEAD"]);
  if (push.code !== 0) logger.warn({ out: push.out }, "push during remediation reported an issue");

  // Built AFTER the commit above, so the diffstat and commit list describe everything being shipped.
  const body = buildPrBody({ worktreePath, baseBranch, ref, summary, closes, incomplete });
  const create = gh(worktreePath, [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    incomplete ? `[incomplete] ${title}` : title,
    "--body",
    body,
    ...(incomplete ? ["--draft"] : []),
  ]);
  const urlMatch = create.out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (!urlMatch) {
    // Re-resolve in case the PR was actually created but output parsing failed.
    const again = resolveGroundTruth(worktreePath, baseBranch, branch);
    if (again.prUrl) return { prUrl: again.prUrl, remediated: true };
    throw new Error(`Failed to open PR during remediation: ${create.out}`);
  }
  return { prUrl: urlMatch[0], remediated: true };
}
