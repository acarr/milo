import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

process.env["MILO_HOME"] ??= mkdtempSync(join(os.tmpdir(), "milo-verify-body-"));
const { buildPrBody } = await import("@milo/core");

/**
 * The PR description Milo writes when it opens the PR itself.
 *
 * Before this, the whole body was the agent's one-sentence `MILO_RESULT` summary — so any run whose
 * summary was missing (crashed run, unparseable result line) produced a PR described as nothing but
 * `Implements WAZ-1150` (PR #707, 2026-08-07). The body is now grounded in what git can prove, so a
 * missing summary costs detail rather than the entire description.
 */

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
};

/** A real repo on `main` with `n` commits on a feature branch — buildPrBody shells out to git. */
function repoWithBranch(commits: string[]): { path: string; baseBranch: string } {
  const path = mkdtempSync(join(os.tmpdir(), "milo-body-repo-"));
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "t@t.test");
  git(path, "config", "user.name", "T");
  writeFileSync(join(path, "README.md"), "base\n");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "base");
  git(path, "switch", "-qc", "feature/thing");
  commits.forEach((subject, i) => {
    writeFileSync(join(path, `f${i}.txt`), `line one\nline two\n`);
    git(path, "add", "-A");
    git(path, "commit", "-qm", subject);
  });
  return { path, baseBranch: "main" };
}

test("a body with a summary still reports the commits and diffstat git can prove", () => {
  const { path, baseBranch } = repoWithBranch(["feat: add the widget", "test: cover the widget"]);
  const body = buildPrBody({
    worktreePath: path,
    baseBranch,
    ref: "TST-1",
    summary: "Added the widget and covered it with tests.",
    closes: "TST-1",
  });

  assert.match(body, /## Summary\n\nAdded the widget and covered it with tests\./);
  assert.match(body, /## Commits/);
  assert.match(body, /- feat: add the widget/);
  assert.match(body, /- test: cover the widget/);
  assert.match(body, /## Files changed\n\n.*2 files changed/);
  assert.match(body, /Closes TST-1/);
  assert.ok(!body.includes("[!WARNING]"), "a clean run carries no warning");
});

test("no summary still yields a description of the work, not just `Implements <REF>`", () => {
  const { path, baseBranch } = repoWithBranch(["fix(api): stop leaking friends-only ratings"]);
  const body = buildPrBody({ worktreePath: path, baseBranch, ref: "TST-2", summary: "", closes: "TST-2" });

  assert.match(body, /left no summary/, "it says the summary is missing rather than pretending");
  assert.match(body, /- fix\(api\): stop leaking friends-only ratings/, "the commits carry the description");
  assert.match(body, /## Files changed/);
  assert.ok(body.length > 120, `body should be substantive, got ${body.length} chars`);
});

test("an unfinished run is captioned as such, up front", () => {
  const { path, baseBranch } = repoWithBranch(["feat: half of the moderation work"]);
  const body = buildPrBody({
    worktreePath: path,
    baseBranch,
    ref: "TST-3",
    summary: "",
    closes: "TST-3",
    incomplete: { reason: "API Error: Connection closed mid-response." },
  });

  assert.match(body, /^> \[!WARNING\]/, "the warning leads the body");
  assert.match(body, /This run did not finish/);
  assert.match(body, /API Error: Connection closed mid-response\./, "it names the actual reason");
  assert.match(body, /draft/i);
  assert.match(body, /- feat: half of the moderation work/, "partial work is still described");
});

test("a long branch lists a bounded number of commits and says how many were elided", () => {
  const subjects = Array.from({ length: 25 }, (_, i) => `chore: step ${i + 1}`);
  const { path, baseBranch } = repoWithBranch(subjects);
  const body = buildPrBody({ worktreePath: path, baseBranch, ref: "TST-4", summary: "Many steps." });

  assert.match(body, /- chore: step 1$/m, "oldest first");
  assert.match(body, /…and 5 more/);
  assert.ok(!body.includes("chore: step 25"), "the tail is elided, not printed");
});

test("a worktree git can't read degrades to the summary instead of throwing", () => {
  const body = buildPrBody({
    worktreePath: mkdtempSync(join(os.tmpdir(), "milo-not-a-repo-")),
    baseBranch: "main",
    ref: "TST-5",
    summary: "Something happened.",
    closes: "TST-5",
  });
  assert.match(body, /## Summary\n\nSomething happened\./);
  assert.match(body, /Closes TST-5/);
});
