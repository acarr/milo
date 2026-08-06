import { spawn } from "node:child_process";
import { logger, withRepoGitLock } from "@milo/core";

/**
 * Reconciling a remote run back into the local worktree.
 *
 * A Conductor session does its work in a cloud workspace Milo cannot see. The only thing it leaves
 * behind that Milo *can* observe is the branch it pushed to `origin`. So after the session ends we
 * fast-forward the local worktree onto that branch — after which `resolveGroundTruth` sees
 * `commitsAhead > 0`, `dirty: false`, `pushed: true`, and the ordinary verification gate opens the
 * PR with no changes to `verify.ts` at all.
 *
 * Async `spawn` throughout, never `spawnSync`: a fetch on a large repo can take tens of seconds and
 * blocking the daemon's single event loop would starve the 30s job heartbeat (see `worktree.ts`).
 */

function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ code: 1, stdout: stdout.trim(), stderr: (stderr + String(err.message)).trim() }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

const git = (cwd: string, args: string[]) => run("git", ["-C", cwd, ...args]);

/** The main clone backing a worktree — the lock key, since worktrees share its ref store. */
async function gitCommonDir(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.code !== 0 || !r.stdout) return cwd;
  return r.stdout.replace(/\/\.git\/?$/, "");
}

export interface SyncResult {
  /** True when `branch` exists on origin and the worktree now points at it. */
  synced: boolean;
  /** Branch names on origin, for a useful error when the expected one is missing. */
  candidates: string[];
  detail?: string;
}

/** List branch names on origin (best-effort; empty on failure). */
export async function listRemoteBranches(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["ls-remote", "--heads", "origin"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.split("refs/heads/")[1]?.trim())
    .filter((b): b is string => !!b);
}

/**
 * Fast-forward `cwd` onto `origin/<branch>` so the verification gate can read the remote's work.
 *
 * Returns `synced: false` (rather than throwing) when the branch never reached origin — that is the
 * "agent committed in the cloud but never pushed" case, which the caller handles by asking the
 * session to push, then failing loudly with the workspace link rather than silently losing work.
 */
export async function syncWorktreeFromRemote(
  cwd: string,
  branch: string,
  opts: { detached?: boolean } = {},
): Promise<SyncResult> {
  const lockKey = await gitCommonDir(cwd);

  return withRepoGitLock(lockKey, async () => {
    // Fetch just this branch into its remote-tracking ref. `+` forces the update so a re-run after
    // the remote force-pushed still converges.
    const fetched = await git(cwd, [
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (fetched.code !== 0) {
      const candidates = await listRemoteBranches(cwd);
      logger.warn({ branch, err: fetched.stderr }, "conductor: branch not found on origin");
      return { synced: false, candidates, detail: fetched.stderr };
    }

    // Point the worktree at exactly what the remote produced. Safe to hard-reset: for a conductor
    // run nothing local ever wrote here — the worktree exists only to host git/gh for the gate.
    const reset = await git(cwd, ["reset", "--hard", `refs/remotes/origin/${branch}`]);
    if (reset.code !== 0) return { synced: false, candidates: [], detail: reset.stderr };

    // `ensurePr` runs `git push -u origin HEAD`, and `resolveGroundTruth` reads `@{u}` to decide
    // `pushed` — both need an upstream. A detached worktree has no branch to attach one to, so it
    // is skipped there (the gate's detached path pushes by refspec instead).
    if (!opts.detached) {
      const up = await git(cwd, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
      if (up.code !== 0) logger.warn({ branch, err: up.stderr }, "conductor: could not set upstream");
    }

    logger.info({ branch, cwd }, "conductor: synced worktree from origin");
    return { synced: true, candidates: [] };
  });
}
