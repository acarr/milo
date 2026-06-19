import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-pipeline-class-"));
import {
  openDatabase,
  JobStore,
  makeProcessJob,
  MiloConfigSchema,
  type LinearClient,
  type LinearIssue,
} from "@milo/core";

// Worktree-setup failure classification (MILO-14): deterministic precondition failures must go
// straight to needs-attention without burning retries or counting toward the circuit breaker;
// flaky-infra failures must keep the existing retry + breaker behavior.

const issue: LinearIssue = {
  id: "uuid-1",
  identifier: "TST-1",
  title: "test issue",
  description: "",
  priorityLabel: "None",
  url: "https://linear.app/x/issue/TST-1",
  state: { id: "s", name: "Todo", type: "unstarted" },
  labels: [],
  comments: [],
};

const fakeLinear = {
  fetchIssue: async () => issue,
  agentSessionForIssue: async () => undefined,
  findStateId: async () => undefined,
  setIssueState: async () => undefined,
  addComment: async () => undefined,
  agentError: async () => undefined,
} as unknown as LinearClient;

const noopRunner = async () => ({ code: 0, output: "", logFile: "" });
const parseResult = () => ({ outcome: "discovery" as const, wroteCode: false, prUrl: null, summary: "" });

function setup(repoPath: string) {
  const base = mkdtempSync(join(os.tmpdir(), "milo-pipeline-wtb-"));
  const worktreeBase = join(base, "worktrees");
  const config = MiloConfigSchema.parse({
    worktreeBase,
    repositories: [{ name: "test-repo", path: repoPath, teamKeys: ["TST"] }],
  });
  const store = new JobStore(openDatabase(join(mkdtempSync(join(os.tmpdir(), "milo-pipeline-db-")), "milo.db")));
  const processJob = makeProcessJob({
    config,
    store,
    linear: fakeLinear,
    runners: { claude: noopRunner },
    parseResult,
  });
  return { config, store, processJob, worktreeBase };
}

test("a permanent worktree failure goes straight to needs-attention and never touches the breaker", async () => {
  // The repo path is a real directory (so nothing earlier fails), and the worktree target exists
  // as a plain file -> createWorktree throws the deterministic "exists but is not a git worktree".
  const repoPath = mkdtempSync(join(os.tmpdir(), "milo-fake-repo-"));
  const { store, processJob, worktreeBase } = setup(repoPath);
  mkdirSync(worktreeBase, { recursive: true });
  writeFileSync(join(worktreeBase, "TST-1"), "not a worktree");

  const { job } = store.enqueue({ source: "cli", entityId: "TST-1", triggerType: "issue.start", repo: "test-repo" });
  store.claimNext("test-worker");
  await processJob(store.get(job.id)!);

  const after = store.get(job.id)!;
  assert.equal(after.state, "needs-attention", "no retry loop for a deterministic failure");
  assert.equal(after.failureClass, "logic");
  assert.match(after.failureDetail ?? "", /exists but is not a git worktree/);
  // The circuit breaker was never touched.
  const health = store.repoHealth("test-repo");
  assert.equal(health.consecutiveInfraFailures, 0);
  assert.equal(health.breakerState, "closed");
});

test("a flaky-infra worktree failure keeps retry + breaker accounting", async () => {
  // The repo path doesn't exist -> git fetch fails with a non-permanent error.
  const { store, processJob } = setup("/nonexistent/path/to/repo");

  const { job } = store.enqueue({ source: "cli", entityId: "TST-2", triggerType: "issue.start", repo: "test-repo" });
  store.claimNext("test-worker");
  await processJob(store.get(job.id)!);

  const after = store.get(job.id)!;
  // scheduleRetry puts the job back to queued with attempts++ and a backoff window.
  assert.equal(after.state, "queued", "transient failures are rescheduled, not parked");
  assert.equal(after.attempts, 1);
  assert.equal(after.failureClass, "transient-infra");
  assert.ok(store.events(job.id).some((e) => e.kind === "retry"), "a retry was recorded");
  // ...and count toward the breaker.
  assert.equal(store.repoHealth("test-repo").consecutiveInfraFailures, 1);
});
