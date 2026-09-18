import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

process.env["MILO_HOME"] ??= mkdtempSync(join(os.tmpdir(), "milo-verify-run-"));
const { runVerifyCommand, runVerification, changedFiles, outputTail, describeVerification, buildPrBody } = await import("@milo/core");

// The verify step of the gate: real shell commands in a real directory, with a real timeout.

test("a passing command reports passed with its output tail", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "milo-vr-"));
  const r = await runVerifyCommand("echo one; echo two; echo three", dir, { timeoutMs: 10_000, tailLines: 2 });
  assert.equal(r.passed, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.outputTail, "two\nthree", "only the last N lines are kept");
  assert.ok(r.durationMs >= 0);
});

test("a failing command reports its exit code and stderr in the tail", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "milo-vr-"));
  const r = await runVerifyCommand("echo starting; echo 'error TS2322: bad' 1>&2; exit 3", dir, { timeoutMs: 10_000 });
  assert.equal(r.passed, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.outputTail, /error TS2322: bad/);
  assert.equal(r.timedOut, undefined);
});

test("a command that overruns the timeout is killed and reported as timed out", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "milo-vr-"));
  const started = Date.now();
  const r = await runVerifyCommand("echo working; sleep 30", dir, { timeoutMs: 400 });
  assert.equal(r.passed, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000, "did not wait for the sleep");
  assert.match(r.outputTail, /working/);
});

test("runVerification runs the plan in order and stops at the first failure", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "milo-vr-"));
  const marker = join(dir, "third-ran");
  const r = await runVerification(
    [{ command: "true" }, { command: "false" }, { command: `touch ${JSON.stringify(marker)}` }],
    dir,
    { timeoutMs: 10_000 },
  );
  assert.equal(r.passed, false);
  assert.equal(r.outcomes.length, 2, "the third command never ran");
  assert.equal(r.outcomes[0]!.passed, true);
  assert.equal(r.outcomes[1]!.passed, false);
  assert.equal(spawnSync("test", ["-f", marker]).status, 1);

  const ok = await runVerification([{ command: "true" }, { command: "echo fine" }], dir, { timeoutMs: 10_000 });
  assert.equal(ok.passed, true);
  assert.equal(ok.outcomes.length, 2);
  assert.match(describeVerification(ok.outcomes), /^✓ `true` \(exit 0, \d+s\)\n✓ `echo fine` \(exit 0, \d+s\)$/);
});

test("changedFiles lists committed AND uncommitted paths against origin/<base>", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "milo-cf-"));
  const origin = join(root, "origin.git");
  const wt = join(root, "wt");
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: wt, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, wt]);
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "T");
  writeFileSync(join(wt, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("push", "-q", "-u", "origin", "main");
  git("switch", "-qc", "feature/x");
  spawnSync("mkdir", ["-p", join(wt, "packages/ios")]);
  writeFileSync(join(wt, "packages/ios/A.swift"), "x");
  git("add", "-A");
  git("commit", "-qm", "ios change");
  writeFileSync(join(wt, "untracked.ts"), "y"); // dirty tree

  const files = await changedFiles(wt, "main");
  assert.ok(files.includes("packages/ios/A.swift"), `committed file listed: ${files}`);
  assert.ok(files.includes("untracked.ts"), `uncommitted file listed: ${files}`);
  assert.ok(!files.includes("README.md"), "base files are not 'changed'");
});

test("outputTail keeps the last N lines and caps very long tails", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
  const tail = outputTail(lines, 50);
  assert.equal(tail.split("\n").length, 50);
  assert.match(tail, /^line 71\n/);
  assert.match(tail, /line 120$/);
  assert.equal(outputTail("a\r\nb\r\n", 5), "a\nb");
  const huge = "x".repeat(20_000);
  assert.ok(outputTail(huge, 5, 1_000).length <= 1_001);
});

test("buildPrBody carries the gate's verification lines and the criteria tally", async () => {
  const body = await buildPrBody({
    worktreePath: process.cwd(),
    baseBranch: "main",
    ref: "WAZ-1",
    summary: "Did it.",
    closes: "WAZ-1",
    criteria: { passed: 3, total: 4 },
    verification: [
      { command: "pnpm typecheck", passed: true, exitCode: 0, outputTail: "", durationMs: 12_000 },
      { command: "make test-ios-unit", passed: false, exitCode: 65, outputTail: "boom", durationMs: 90_000 },
    ],
  });
  assert.match(body, /## Acceptance criteria\n\n3 of 4 passed/);
  assert.match(body, /## Verification\n\n- `pnpm typecheck` — passed\n- `make test-ios-unit` — FAILED \(exit 65\)/);
  assert.ok(body.indexOf("## Verification") < body.indexOf("Closes WAZ-1"));
});
