import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-verify-gate-"));
const { openDatabase, JobStore, makeProcessJob, MiloConfigSchema } = await import("@milo/core");
type LinearClient = import("@milo/core").LinearClient;
type LinearIssue = import("@milo/core").LinearIssue;
type RunnerFn = import("@milo/core").RunnerFn;

/**
 * The verification gate end to end, over a real git origin + worktree and a fake `gh`:
 *  - the repo's `.milo/config.json` drives the workflow body, the model, the PR labels and the
 *    verify command;
 *  - a failing verify gets ONE attach-mode retry whose prompt carries the failure;
 *  - a retry that fixes it ships `done` with a labelled, ready PR; one that doesn't lands in
 *    `needs-attention` behind a draft `[incomplete]` PR;
 *  - a retry scheduled by the queue carries the previous attempt's error + output tail.
 */

const sh = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
};
const git = (cwd: string, ...args: string[]) => sh("git", ["-C", cwd, ...args]);

let ghDir: string;
let realPath: string | undefined;
let argvFile: string;

before(() => {
  ghDir = mkdtempSync(join(os.tmpdir(), "milo-gate-gh-"));
  writeFileSync(
    join(ghDir, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv[0] === "pr" && argv[1] === "list") { console.log("[]"); process.exit(0); }
if (argv[0] === "pr" && argv[1] === "create") {
  fs.writeFileSync(process.env.MILO_TEST_GH_ARGV, JSON.stringify(argv));
  console.log("https://github.com/acme/repo/pull/12");
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  realPath = process.env["PATH"];
  process.env["PATH"] = ghDir + delimiter + realPath;
});
after(() => {
  if (realPath !== undefined) process.env["PATH"] = realPath;
});

const issue: LinearIssue = {
  id: "uuid-1",
  identifier: "TST-1",
  title: "Add the widget",
  description: "Do the widget.",
  priorityLabel: "None",
  url: "https://linear.app/x/issue/TST-1",
  state: { id: "s", name: "Todo", type: "unstarted" },
  labels: ["milo", "class:chore"],
  comments: [],
};

const fakeLinear = {
  fetchIssue: async () => issue,
  agentSessionForIssue: async () => undefined,
  findStateId: async () => undefined,
  setIssueState: async () => undefined,
  addComment: async () => undefined,
  agentError: async () => undefined,
  agentThought: async () => true,
  agentAction: async () => true,
  agentResponse: async () => true,
} as unknown as LinearClient;

/** A real origin + clone carrying a `.milo/config.json`, plus a fresh worktree base + DB. */
function harness(repoConfig: Record<string, unknown>, opts: { now?: () => number } = {}) {
  const base = mkdtempSync(join(os.tmpdir(), "milo-gate-"));
  const origin = join(base, "origin.git");
  const repoPath = join(base, "repo");
  const worktreeBase = join(base, "worktrees");
  sh("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  sh("git", ["clone", "-q", origin, repoPath]);
  git(repoPath, "config", "user.email", "t@milo.local");
  git(repoPath, "config", "user.name", "Milo Test");
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  const setup = join(repoPath, "setup.sh");
  writeFileSync(setup, "#!/bin/bash\nexit 0\n");
  chmodSync(setup, 0o755);
  mkdirSync(join(repoPath, ".milo", "workflows"), { recursive: true });
  writeFileSync(join(repoPath, ".milo", "config.json"), JSON.stringify(repoConfig));
  writeFileSync(join(repoPath, ".milo", "workflows", "linear-issue.md"), "### Phase 1: Criteria for {{ISSUE_ID}}\nList them. Labels: {{LABELS}}.");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-qm", "init");
  git(repoPath, "push", "-q", "-u", "origin", "main");

  const config = MiloConfigSchema.parse({
    worktreeBase,
    repositories: [{ name: "test-repo", path: repoPath, teamKeys: ["TST"], setupScript: "setup.sh" }],
  });
  const store = new JobStore(openDatabase(join(base, "milo.db")), opts.now);
  argvFile = join(base, "gh-argv.json");
  process.env["MILO_TEST_GH_ARGV"] = argvFile;
  return { config, store, repoPath, worktreeBase, base };
}

const CONFIG = {
  version: 1,
  workflows: { linearIssue: "workflows/linear-issue.md" },
  labels: ["agent-authored"],
  classLabelFromTicket: true,
  verifyCommand: "test -f fixed.txt",
  model: { default: "opus", byLabel: { "class:chore": "sonnet" } },
  maxTurns: 40,
};

interface Call {
  prompt: string;
  model: string;
  maxTurns?: number;
}

/** A runner that commits a file on its first call and, on the retry, optionally adds the fix. */
function makeRunner(calls: Call[], fixOnRetry: boolean): RunnerFn {
  return async (o) => {
    calls.push({ prompt: o.prompt, model: o.model, maxTurns: o.maxTurns });
    const n = calls.length;
    if (n === 1) {
      writeFileSync(join(o.cwd, "src.ts"), "export const a = 1;\n");
      git(o.cwd, "add", "src.ts");
      git(o.cwd, "commit", "-qm", "feat: add the widget");
      return {
        code: 0,
        output: 'done\nMILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"Added the widget.","criteria":{"passed":2,"total":3}}',
        logFile: o.logFile,
      };
    }
    if (fixOnRetry) {
      writeFileSync(join(o.cwd, "fixed.txt"), "ok\n");
      git(o.cwd, "add", "fixed.txt");
      git(o.cwd, "commit", "-qm", "fix: make verify pass");
    }
    return { code: 0, output: 'MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"Fixed."}', logFile: o.logFile };
  };
}

const parseResult = (output: string) => {
  const line = output.split("\n").reverse().find((l) => l.includes("MILO_RESULT="));
  if (!line) return { outcome: "discovery" as const, wroteCode: false, prUrl: null, summary: "" };
  const j = JSON.parse(line.slice(line.indexOf("MILO_RESULT=") + 12));
  return { outcome: j.outcome, wroteCode: !!j.wroteCode, prUrl: j.prUrl ?? null, summary: j.summary ?? "", ...(j.criteria ? { criteria: j.criteria } : {}) };
};

test("verify fails once, the retry fixes it → done, labelled ready PR, verification in the body", async () => {
  const { config, store } = harness(CONFIG);
  const calls: Call[] = [];
  const processJob = makeProcessJob({ config, store, linear: fakeLinear, runners: { claude: makeRunner(calls, true) }, parseResult });

  const { job } = store.enqueue({ source: "cli", entityId: "TST-1", triggerType: "issue.start", repo: "test-repo" });
  store.claimNext("w");
  await processJob(store.get(job.id)!);

  const after = store.get(job.id)!;
  assert.equal(after.state, "done", after.failureDetail ?? "");
  assert.equal(after.verifyStatus, "passed");
  assert.match(after.verifyDetail ?? "", /test -f fixed\.txt/);
  assert.match(after.verifyDetail ?? "", /after one retry/);
  assert.equal(after.criteriaPassed, 2);
  assert.equal(after.criteriaTotal, 3);
  assert.equal(after.prUrl, "https://github.com/acme/repo/pull/12");

  // Two agent runs: the implementation, then the verify retry.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.model, "sonnet", "model.byLabel class:chore → sonnet");
  assert.equal(calls[0]!.maxTurns, 40);
  assert.match(calls[0]!.prompt, /### Phase 1: Criteria for TST-1\nList them\. Labels: agent-authored,class:chore\./, "workflow body with placeholders");
  assert.ok(!calls[0]!.prompt.includes("<previous_attempt>"));
  assert.match(calls[1]!.prompt, /<previous_attempt>[\s\S]*Verification gate failed[\s\S]*test -f fixed\.txt[\s\S]*<\/previous_attempt>/);
  assert.match(calls[1]!.prompt, /<requested_change>\nMilo's verification gate ran/);

  // The gate opened the PR with the labels, ready (not draft), describing the verification.
  assert.ok(existsSync(argvFile), "gh pr create ran");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.equal(argv[argv.indexOf("--label") + 1], "agent-authored,class:chore");
  assert.ok(!argv.includes("--draft"));
  assert.equal(argv[argv.indexOf("--title") + 1], "Add the widget");
  const body = argv[argv.indexOf("--body") + 1]!;
  assert.match(body, /## Verification\n\n- `test -f fixed\.txt` — passed/);
  assert.match(body, /## Acceptance criteria\n\n2 of 3 passed/);
  assert.match(body, /Closes TST-1/);
  // Events record the gate's phases.
  const kinds = store.events(job.id, 50).filter((e) => e.kind === "verify").map((e) => JSON.parse(e.data).phase);
  assert.deepEqual(kinds.sort(), ["failed", "initial", "retry"]);
});

test("verify still fails after the retry → needs-attention (verify-failed) behind a draft [incomplete] PR", async () => {
  const { config, store } = harness(CONFIG);
  const calls: Call[] = [];
  const processJob = makeProcessJob({ config, store, linear: fakeLinear, runners: { claude: makeRunner(calls, false) }, parseResult });

  const { job } = store.enqueue({ source: "cli", entityId: "TST-1", triggerType: "issue.start", repo: "test-repo" });
  store.claimNext("w");
  await processJob(store.get(job.id)!);

  const after = store.get(job.id)!;
  assert.equal(after.state, "needs-attention");
  assert.equal(after.failureClass, "verify-failed");
  assert.equal(after.verifiedOutcome, "incomplete");
  assert.equal(after.verifyStatus, "failed");
  assert.match(after.failureDetail ?? "", /verification failed after one retry: `test -f fixed\.txt` exited 1/);
  assert.equal(calls.length, 2, "exactly one retry, never a loop");

  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.ok(argv.includes("--draft"), "an unverified PR must arrive as a draft");
  assert.match(argv[argv.indexOf("--title") + 1]!, /^\[incomplete\] Add the widget$/);
  assert.equal(argv[argv.indexOf("--label") + 1], "agent-authored,class:chore", "labels still applied");
  const body = argv[argv.indexOf("--body") + 1]!;
  assert.match(body, /\[!WARNING\][\s\S]*verification failed after one retry/);
  assert.match(body, /## Verification\n\n- `test -f fixed\.txt` — FAILED \(exit 1\)/);
});

test("no verifyCommand configured → the gate is skipped and a clean run ships as before", async () => {
  const { config, store } = harness({ version: 1, labels: ["agent-authored"] });
  const calls: Call[] = [];
  const processJob = makeProcessJob({ config, store, linear: fakeLinear, runners: { claude: makeRunner(calls, false) }, parseResult });

  const { job } = store.enqueue({ source: "cli", entityId: "TST-1", triggerType: "issue.start", repo: "test-repo" });
  store.claimNext("w");
  await processJob(store.get(job.id)!);

  const after = store.get(job.id)!;
  assert.equal(after.state, "done");
  assert.equal(after.verifyStatus, "skipped");
  assert.equal(calls.length, 1, "no retry when nothing was verified");
  assert.equal(calls[0]!.model, "opus", "no model override → the global chain");
  assert.equal(calls[0]!.maxTurns, undefined);
  assert.match(calls[0]!.prompt, /### Phase 1: Understand and Plan/, "built-in body when no workflow file");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.equal(argv[argv.indexOf("--label") + 1], "agent-authored", "class label NOT copied when classLabelFromTicket is off");
  assert.ok(!(argv[argv.indexOf("--body") + 1] ?? "").includes("## Verification"));
});

test("a queue retry carries the previous attempt's error and output tail into the next prompt", async () => {
  let now = 1_700_000_000_000;
  const { config, store, worktreeBase } = harness({ version: 1 }, { now: () => now });
  const calls: Call[] = [];
  const runner: RunnerFn = async (o) => {
    calls.push({ prompt: o.prompt, model: o.model });
    if (calls.length === 1) {
      // Died mid-flight with no code written: the classic transient failure that gets retried.
      return { code: 1, output: "Reading files…\nRunning tests…\nAPI Error: boom at turn 12\n", logFile: o.logFile, errorDetail: "API Error: boom at turn 12" };
    }
    return { code: 0, output: 'MILO_RESULT={"outcome":"discovery","wroteCode":false,"prUrl":null,"summary":"Nothing to do."}', logFile: o.logFile };
  };
  const processJob = makeProcessJob({ config, store, linear: fakeLinear, runners: { claude: runner }, parseResult });

  const { job } = store.enqueue({ source: "cli", entityId: "TST-1", triggerType: "issue.start", repo: "test-repo" });
  store.claimNext("w");
  await processJob(store.get(job.id)!);

  const mid = store.get(job.id)!;
  assert.equal(mid.state, "queued", "scheduled for retry");
  assert.equal(mid.attempts, 1);
  assert.equal(mid.failureDetail, "API Error: boom at turn 12");
  assert.match(mid.outputTail ?? "", /Running tests…\nAPI Error: boom at turn 12/, "the output tail is stored for the next attempt");

  // A retry's teardown is fire-and-forget (`teardownIfNeeded` never blocks the caller), and in the
  // daemon the 30s backoff is what keeps it from racing the next attempt. Here `now` is a fake clock,
  // so wait for the worktree to actually be gone — otherwise attempt 2 reuses the half-torn-down
  // directory and the gate sees a vanished cwd instead of a clean discovery run.
  const worktreePath = join(worktreeBase, "TST-1");
  for (let waited = 0; existsSync(worktreePath) && waited < 10_000; waited += 25) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(!existsSync(worktreePath), "attempt 1's worktree was torn down before attempt 2");

  now += 31_000; // past the 30s backoff
  const claimed = store.claimNext("w");
  assert.equal(claimed?.id, job.id);
  await processJob(store.get(job.id)!);

  assert.equal(calls.length, 2);
  assert.ok(!calls[0]!.prompt.includes("<previous_attempt>"), "first attempt has no previous_attempt");
  const block = calls[1]!.prompt.slice(calls[1]!.prompt.indexOf("<previous_attempt>"), calls[1]!.prompt.indexOf("</previous_attempt>"));
  assert.match(block, /<attempt>1<\/attempt>/);
  assert.match(block, /<error>\nAPI Error: boom at turn 12\n  <\/error>/);
  assert.match(block, /<output_tail>\nReading files…\nRunning tests…\nAPI Error: boom at turn 12\n  <\/output_tail>/);
  assert.equal(store.get(job.id)!.state, "discovery-done");
});
