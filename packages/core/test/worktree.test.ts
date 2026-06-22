import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-worktree-"));
import { attachWorktree, createWorktree, isPermanentWorktreeError, ensurePushed, RepoConfigSchema, type RepoConfig } from "@milo/core";

const sh = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
};
const git = (cwd: string, args: string[]) => sh("git", ["-C", cwd, ...args]);

const FEATURE = "feature/test-pr-branch";

/**
 * A real origin (bare repo) + clone, mirroring Milo's setup: `repoPath` is the configured
 * dev clone, `origin` is GitHub. The clone gets a no-op setup script so attach/create never
 * runs a package-manager install.
 */
function makeRepos(): { repo: RepoConfig; repoPath: string; origin: string; worktreeBase: string } {
  const base = mkdtempSync(join(os.tmpdir(), "milo-wt-repos-"));
  const origin = join(base, "origin.git");
  const repoPath = join(base, "repo");
  const worktreeBase = join(base, "worktrees");
  sh("git", ["init", "--bare", "--initial-branch=main", origin]);
  sh("git", ["clone", origin, repoPath]);
  git(repoPath, ["config", "user.email", "test@milo.local"]);
  git(repoPath, ["config", "user.name", "Milo Test"]);

  writeFileSync(join(repoPath, "README.md"), "hello\n");
  const setup = join(repoPath, "setup.sh");
  writeFileSync(setup, "#!/bin/bash\nexit 0\n");
  chmodSync(setup, 0o755);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  git(repoPath, ["push", "-u", "origin", "main"]);

  // A "PR branch" with one commit, pushed to origin.
  git(repoPath, ["checkout", "-b", FEATURE]);
  writeFileSync(join(repoPath, "feature.txt"), "feature work\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "feature commit"]);
  git(repoPath, ["push", "-u", "origin", FEATURE]);

  const repo = RepoConfigSchema.parse({
    name: "test-repo",
    path: repoPath,
    baseBranch: "main",
    setupScript: "setup.sh",
  });
  return { repo, repoPath, origin, worktreeBase };
}

test("isPermanentWorktreeError classifies deterministic git failures, not flaky infra", () => {
  assert.equal(
    isPermanentWorktreeError("fatal: 'feature/x' is already used by worktree at '/Users/dev/repo'"),
    true,
  );
  assert.equal(isPermanentWorktreeError("fatal: 'feature/x' is already checked out at '/Users/dev/repo'"), true);
  assert.equal(isPermanentWorktreeError("/tmp/wt/SBX-1 exists but is not a git worktree"), true);
  // Transient/flaky failures keep retry + breaker behavior.
  assert.equal(
    isPermanentWorktreeError("fatal: unable to access 'https://github.com/x/y': Could not resolve host"),
    false,
  );
  assert.equal(isPermanentWorktreeError("error: RPC failed; curl 56 GnuTLS recv error"), false);
});

test("attachWorktree checks out the PR branch normally when nothing else holds it", async () => {
  const { repo, repoPath, worktreeBase } = makeRepos();
  // The dev clone sits on main — the PR branch is free. Delete the local ref so attach recreates it.
  git(repoPath, ["checkout", "main"]);
  git(repoPath, ["branch", "-D", FEATURE]);

  const wt = await attachWorktree(repo, "pr-1", FEATURE, "main", worktreeBase);
  assert.equal(wt.branch, FEATURE);
  assert.ok(!wt.detached, "no collision -> a normal branch checkout, not detached");
  assert.equal(git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"]), FEATURE);
});

test("attachWorktree falls back to a detached worktree when the branch is checked out elsewhere", async () => {
  const { repo, repoPath, worktreeBase } = makeRepos();
  // Collision: the dev clone itself has the PR branch checked out (the MILO-1/PR#2 live incident).
  git(repoPath, ["checkout", FEATURE]);

  const wt = await attachWorktree(repo, "pr-2", FEATURE, "main", worktreeBase);
  assert.equal(wt.detached, true, "collision -> detached fallback");
  assert.equal(wt.branch, FEATURE, "still logically attached to the PR branch");
  // Detached at exactly the PR head.
  const headSha = git(wt.path, ["rev-parse", "HEAD"]);
  const branchSha = git(repoPath, ["rev-parse", `origin/${FEATURE}`]);
  assert.equal(headSha, branchSha);
  assert.equal(
    spawnSync("git", ["-C", wt.path, "symbolic-ref", "-q", "HEAD"]).status !== 0,
    true,
    "HEAD is detached",
  );
  // The developer's checkout was never touched.
  assert.equal(git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]), FEATURE);
});

test("ensurePushed pushes detached-worktree commits to the PR branch by refspec", async () => {
  const { repo, repoPath, origin, worktreeBase } = makeRepos();
  git(repoPath, ["checkout", FEATURE]); // hold the branch -> force detached attach

  const wt = await attachWorktree(repo, "pr-3", FEATURE, "main", worktreeBase);
  assert.equal(wt.detached, true);

  // Milo makes a follow-up change in the detached worktree.
  git(wt.path, ["config", "user.email", "milo@milo.local"]);
  git(wt.path, ["config", "user.name", "Milo"]);
  writeFileSync(join(wt.path, "followup.txt"), "revision requested in PR feedback\n");

  const before = sh("git", ["-C", origin, "rev-parse", `refs/heads/${FEATURE}`]);
  const result = ensurePushed(wt.path, "main", FEATURE, "TEST-1: follow-up");
  assert.equal(result.pushed, true, "push succeeds from a detached worktree");
  assert.equal(result.committed, true, "the dirty change was committed");

  // The PR branch on origin advanced to the new commit, and it contains the follow-up file.
  const after = sh("git", ["-C", origin, "rev-parse", `refs/heads/${FEATURE}`]);
  assert.notEqual(after, before, "origin's PR branch advanced");
  assert.equal(after, git(wt.path, ["rev-parse", "HEAD"]), "origin matches the worktree's HEAD");
  const tree = sh("git", ["-C", origin, "ls-tree", "--name-only", `refs/heads/${FEATURE}`]);
  assert.ok(tree.includes("followup.txt"));

  // The developer's checkout (same branch) was never touched — their local ref is just behind now.
  assert.equal(git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]), FEATURE);
  assert.equal(git(repoPath, ["rev-parse", "HEAD"]), before);
});

test("createWorktree keeps the event loop responsive during setup (no spawnSync stall)", async () => {
  const { repo, repoPath, worktreeBase } = makeRepos();
  // A slow setup script stands in for a heavy real one (pnpm install, xcodegen, db seed).
  const setup = join(repoPath, "setup.sh");
  writeFileSync(setup, "#!/bin/bash\nsleep 1\nexit 0\n");
  chmodSync(setup, 0o755);

  // A blocking spawnSync would freeze this timer at 0 for the whole setup; async spawn lets it fire.
  let ticks = 0;
  const iv = setInterval(() => {
    ticks++;
  }, 50);
  try {
    const wt = await createWorktree(repo, "SBX-loop", "loop test", worktreeBase);
    assert.ok(wt.path, "worktree was created");
  } finally {
    clearInterval(iv);
  }
  assert.ok(ticks >= 5, `event loop should keep ticking during setup (got ${ticks})`);
});

test("attachWorktree reuse path reports detached state and resets to the latest head", async () => {
  const { repo, repoPath, worktreeBase } = makeRepos();
  git(repoPath, ["checkout", FEATURE]);

  const first = await attachWorktree(repo, "pr-4", FEATURE, "main", worktreeBase);
  assert.equal(first.detached, true);

  // Re-attach to the same key (e.g. a second @milo comment) — reuses the worktree.
  const second = await attachWorktree(repo, "pr-4", FEATURE, "main", worktreeBase);
  assert.equal(second.path, first.path);
  assert.equal(second.detached, true, "reuse path reports the worktree is detached");
  assert.equal(git(second.path, ["rev-parse", "HEAD"]), git(repoPath, ["rev-parse", `origin/${FEATURE}`]));
});
