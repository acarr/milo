import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { RepoConfig } from "./config.js";
import { logger } from "./logger.js";

export interface Worktree {
  path: string;
  branch: string;
  baseBranch: string;
  /**
   * True when the worktree is detached at the branch's head commit instead of having the branch
   * checked out — the fallback when the branch is already checked out in another worktree (e.g.
   * the developer's main tree). Pushes from a detached worktree go by refspec (`HEAD:<branch>`).
   */
  detached?: boolean;
}

/**
 * True for git/worktree failures that are deterministic preconditions, not flaky infrastructure —
 * retrying can never fix them, so they must not burn retries or trip the per-repo circuit breaker.
 */
export function isPermanentWorktreeError(message: string): boolean {
  return (
    /already used by worktree/i.test(message) ||
    /already checked out at/i.test(message) ||
    /exists but is not a git worktree/i.test(message)
  );
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; inherit?: boolean } = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function git(repoPath: string, args: string[], inherit = false) {
  return run("git", ["-C", repoPath, ...args], { inherit });
}

export function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function branchName(issueId: string, title: string): string {
  return `feature/${issueId.toLowerCase()}-${branchSlug(title)}`;
}

/**
 * Create (or reuse) a git worktree for an issue and run the repo's environment setup.
 *
 * `baseOverride` (MILO-4 stacked mode) bases the new branch off another branch on `origin` — the
 * blocker's head — instead of the repo's default base, so the dependent's PR stacks on the
 * blocker's. It must be a branch already pushed to `origin`.
 */
export function createWorktree(
  repo: RepoConfig,
  issueId: string,
  title: string,
  worktreeBasePath: string,
  baseOverride?: string,
  branchOverride?: string,
): Worktree {
  const worktreePath = join(worktreeBasePath, issueId);
  const branch = branchOverride ?? branchName(issueId, title);
  const base = baseOverride ?? repo.baseBranch;

  if (existsSync(join(worktreePath, ".git"))) {
    logger.info({ worktreePath }, "Reusing existing worktree");
    const dirty = git(worktreePath, ["status", "--short"]).stdout;
    if (dirty) logger.warn("Worktree has uncommitted changes");
    return { path: worktreePath, branch, baseBranch: base };
  }
  if (existsSync(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree`);
  }

  mkdirSync(worktreeBasePath, { recursive: true });
  logger.info({ branch, base }, "Creating worktree");
  const fetched = git(repo.path, ["fetch", "origin", base, "--quiet"]);
  if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr}`);

  let add = git(repo.path, ["worktree", "add", "-b", branch, worktreePath, `origin/${base}`]);
  if (add.code !== 0) {
    // Branch may already exist — attach to it.
    add = git(repo.path, ["worktree", "add", worktreePath, branch]);
    if (add.code !== 0) throw new Error(`Failed to create worktree: ${add.stderr}`);
  }

  runSetup(repo, worktreePath, issueId);
  return { path: worktreePath, branch, baseBranch: base };
}

/**
 * Attach mode: create a worktree checked out on an existing PR's head branch (for follow-up
 * commits) rather than a fresh feature branch. Same-repo PRs only — cross-repo (fork) heads
 * aren't on `origin` and are rejected by the caller.
 */
export function attachWorktree(
  repo: RepoConfig,
  key: string,
  headBranch: string,
  baseBranch: string,
  worktreeBasePath: string,
): Worktree {
  const worktreePath = join(worktreeBasePath, key);

  if (existsSync(join(worktreePath, ".git"))) {
    logger.info({ worktreePath }, "Reusing existing attach worktree");
    git(worktreePath, ["fetch", "origin", headBranch, "--quiet"]);
    git(worktreePath, ["reset", "--hard", `origin/${headBranch}`]);
    const detached = git(worktreePath, ["symbolic-ref", "-q", "HEAD"]).code !== 0;
    return { path: worktreePath, branch: headBranch, baseBranch, detached };
  }
  if (existsSync(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree`);
  }

  mkdirSync(worktreeBasePath, { recursive: true });
  logger.info({ headBranch, baseBranch }, "Attaching worktree to existing PR branch");
  const fetched = git(repo.path, ["fetch", "origin", headBranch, "--quiet"]);
  if (fetched.code !== 0) throw new Error(`git fetch ${headBranch} failed: ${fetched.stderr}`);

  // -B resets/creates the local branch to the fetched head, then checks it out in a new worktree.
  const add = git(repo.path, [
    "worktree",
    "add",
    "--track",
    "-B",
    headBranch,
    worktreePath,
    `origin/${headBranch}`,
  ]);
  if (add.code !== 0) {
    // The branch being checked out elsewhere (typically the developer's own working tree) is a
    // deterministic collision — fall back to a DETACHED worktree at the fetched head. Follow-up
    // commits land on the PR branch via a refspec push (HEAD:<branch>), so Milo can still revise
    // the PR without touching the developer's checkout.
    if (isPermanentWorktreeError(add.stderr)) {
      logger.warn(
        { headBranch, detail: add.stderr },
        "branch is checked out in another worktree — attaching detached at its head",
      );
      const detachedAdd = git(repo.path, ["worktree", "add", "--detach", worktreePath, `origin/${headBranch}`]);
      if (detachedAdd.code !== 0) throw new Error(`Failed to attach worktree: ${detachedAdd.stderr}`);
      runSetup(repo, worktreePath, key);
      return { path: worktreePath, branch: headBranch, baseBranch, detached: true };
    }
    throw new Error(`Failed to attach worktree: ${add.stderr}`);
  }

  runSetup(repo, worktreePath, key);
  return { path: worktreePath, branch: headBranch, baseBranch };
}

function runSetup(repo: RepoConfig, worktreePath: string, issueId: string): void {
  if (repo.setupScript) {
    const script = isAbsolute(repo.setupScript) ? repo.setupScript : join(repo.path, repo.setupScript);
    if (existsSync(script)) {
      logger.info({ script }, "Running repo setup script");
      const r = run("bash", [script, worktreePath, `milo-${issueId}`, repo.path, "milo"], {
        inherit: true,
      });
      if (r.code !== 0) throw new Error(`Setup script failed (exit ${r.code})`);
      return;
    }
    logger.warn({ script }, "Configured setupScript not found — falling back to generic setup");
  }

  // Generic setup: copy env files, install deps.
  for (const envFile of [".env", ".env.local"]) {
    const src = join(repo.path, envFile);
    if (existsSync(src)) {
      copyFileSync(src, join(worktreePath, envFile));
      logger.info({ envFile }, "Copied env file");
    }
  }
  const pm = repo.packageManager;
  logger.info({ pm }, "Installing dependencies");
  const install = run(pm, ["install"], { cwd: worktreePath, inherit: true });
  if (install.code !== 0) throw new Error(`${pm} install failed (exit ${install.code})`);
}

/** Tear down a worktree via the repo's teardown script, or `git worktree remove`. */
export function teardownWorktree(repo: RepoConfig, worktreePath: string): void {
  if (!existsSync(worktreePath)) return;
  if (repo.teardownScript) {
    const script = isAbsolute(repo.teardownScript)
      ? repo.teardownScript
      : join(repo.path, repo.teardownScript);
    if (existsSync(script)) {
      logger.info("Tearing down worktree via teardown script");
      const r = run("bash", [script, worktreePath], { inherit: true });
      if (r.code !== 0) logger.warn(`Teardown script exited ${r.code}`);
      return;
    }
  }
  logger.info("Removing worktree");
  const rm = git(repo.path, ["worktree", "remove", worktreePath, "--force"]);
  if (rm.code !== 0) {
    run("rm", ["-rf", worktreePath]);
  }
  git(repo.path, ["worktree", "prune"]);
}
