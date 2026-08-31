import { spawn } from "node:child_process";
import { logger } from "./logger.js";

/**
 * Run a child process WITHOUT blocking the event loop. The gate's work is network-bound —
 * `git push`, `gh pr list`, `gh pr create` — and every job finalize runs several. Under `spawnSync`
 * that froze the single daemon event loop for the whole sequence, starving the job heartbeat and the
 * webhook server (a Linear delegation POST would connect and then never get a reply). Same reasoning
 * as `worktree.ts`'s `run` and `github.ts`'s `gh`.
 */
function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    // `error` fires when the binary can't be spawned (e.g. ENOENT) — mirror spawnSync's failure shape.
    child.on("error", (e) => resolve({ code: 1, out: `${out}${e.message}`.trim() }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.trim() }));
  });
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
export async function resolveGroundTruth(
  worktreePath: string,
  baseBranch: string,
  branch: string,
): Promise<GroundTruth> {
  const countAhead = async () => {
    let r = await git(worktreePath, ["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
    if (r.code !== 0) r = await git(worktreePath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
    const n = parseInt(r.out, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const commitsAhead = await countAhead();
  const dirty = (await git(worktreePath, ["status", "--porcelain"])).out !== "";

  const hasUpstream =
    (await git(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).code === 0;
  let pushed = false;
  if (hasUpstream) {
    const ahead = parseInt((await git(worktreePath, ["rev-list", "--count", "@{u}..HEAD"])).out, 10);
    pushed = Number.isFinite(ahead) ? ahead === 0 : false;
  }

  const prRes = await gh(worktreePath, ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state"]);
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
export async function ensurePushed(
  worktreePath: string,
  baseBranch: string,
  branch: string,
  message: string,
): Promise<EnsurePushedResult> {
  const gt = await resolveGroundTruth(worktreePath, baseBranch, branch);
  let committed = false;
  if (gt.dirty) {
    await git(worktreePath, ["add", "-A"]);
    const c = await git(worktreePath, ["commit", "-m", message]);
    committed = c.code === 0;
    if (!committed) logger.warn({ out: c.out }, "commit during attach push reported an issue");
  }
  const detached = (await git(worktreePath, ["symbolic-ref", "-q", "HEAD"])).code !== 0;
  const target = detached ? `HEAD:refs/heads/${branch}` : "HEAD";
  const push = await git(worktreePath, ["push", "origin", target]);
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
async function commitSubjects(worktreePath: string, baseBranch: string): Promise<string[]> {
  for (const base of [`origin/${baseBranch}`, baseBranch]) {
    const r = await git(worktreePath, ["log", "--reverse", "--format=%s", `${base}..HEAD`]);
    if (r.code === 0) return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return [];
}

/** `28 files changed, 11895 insertions(+), 393 deletions(-)` — or undefined if git can't say. */
async function diffStat(worktreePath: string, baseBranch: string): Promise<string | undefined> {
  for (const base of [`origin/${baseBranch}`, baseBranch]) {
    const r = await git(worktreePath, ["diff", "--shortstat", `${base}...HEAD`]);
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
export async function buildPrBody(input: {
  worktreePath: string;
  baseBranch: string;
  ref: string;
  summary: string;
  closes?: string;
  incomplete?: { reason: string };
}): Promise<string> {
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

  const commits = await commitSubjects(worktreePath, baseBranch);
  if (commits.length) {
    const listed = commits.slice(0, MAX_LISTED_COMMITS).map((c) => `- ${c}`);
    if (commits.length > MAX_LISTED_COMMITS) listed.push(`- …and ${commits.length - MAX_LISTED_COMMITS} more`);
    parts.push(`## Commits\n\n${listed.join("\n")}`);
  }

  const stat = await diffStat(worktreePath, baseBranch);
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
export async function ensurePr(input: EnsurePrInput): Promise<EnsurePrResult> {
  const { worktreePath, baseBranch, branch, ref, title, summary, closes, incomplete } = input;
  const gt = await resolveGroundTruth(worktreePath, baseBranch, branch);
  if (gt.prUrl) return { prUrl: gt.prUrl, remediated: false };

  logger.warn({ ref, branch, incomplete: incomplete?.reason }, "code present but no PR — Milo is opening it directly");

  if (gt.dirty) {
    await git(worktreePath, ["add", "-A"]);
    const message = incomplete ? `${ref}: ${title} (partial — run did not finish)` : `${ref}: ${title}`;
    const c = await git(worktreePath, ["commit", "-m", message]);
    if (c.code !== 0) logger.warn({ out: c.out }, "commit during remediation reported an issue");
  }
  const push = await git(worktreePath, ["push", "-u", "origin", "HEAD"]);
  if (push.code !== 0) logger.warn({ out: push.out }, "push during remediation reported an issue");

  // Built AFTER the commit above, so the diffstat and commit list describe everything being shipped.
  const body = await buildPrBody({ worktreePath, baseBranch, ref, summary, closes, incomplete });
  const create = await gh(worktreePath, [
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
    const again = await resolveGroundTruth(worktreePath, baseBranch, branch);
    if (again.prUrl) return { prUrl: again.prUrl, remediated: true };
    throw new Error(`Failed to open PR during remediation: ${create.out}`);
  }
  return { prUrl: urlMatch[0], remediated: true };
}
