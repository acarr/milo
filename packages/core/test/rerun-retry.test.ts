import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-rerun-"));

import { openDatabase, JobStore } from "@milo/core";

function store(): JobStore {
  return new JobStore(openDatabase());
}

test("rerun: clones a finished job into a NEW queued job that dedupe won't swallow", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-1", triggerType: "issue.start", repo: "sandbox", runner: "claude" });
  s.transition(job.id, "done", { pr_url: "https://example.com/pr/1" });

  const fresh = s.rerun(job.id);
  assert.notEqual(fresh.id, job.id, "a brand-new job id");
  assert.equal(fresh.state, "queued");
  assert.equal(fresh.attempts, 0);
  assert.equal(fresh.entityId, "SBX-1", "entity preserved (so create-vs-attach still resolves)");
  assert.equal(fresh.runner, "claude", "runner preserved");
  assert.notEqual(fresh.identityKey, job.identityKey, "a distinct identity key");
  assert.match(fresh.contentHash, /:rerun:/, "carries the rerun nonce");

  // Two reruns are themselves distinct (the nonce includes the new id).
  const second = s.rerun(job.id);
  assert.notEqual(second.id, fresh.id);
  assert.notEqual(second.identityKey, fresh.identityKey);

  assert.throws(() => s.rerun("missing"), /no job missing/);
});

test("retry: resets a failed job in place (same row) back to queued", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-2", triggerType: "issue.start", repo: "sandbox" });
  s.scheduleRetry(job.id, 1000, "transient-infra", "boom"); // attempts=1, backoff set
  s.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: "gave up" });

  const retried = s.retry(job.id);
  assert.equal(retried.id, job.id, "same job, not a clone");
  assert.equal(retried.state, "queued");
  assert.equal(retried.attempts, 0, "attempts reset");
  assert.equal(retried.nextEligibleAt, null, "backoff cleared");
  assert.equal(retried.failureClass, null);
  assert.equal(retried.failureDetail, null);
  assert.equal(retried.terminalAt, null);
});

test("retry: refuses a non-terminal-failure job (use rerun instead)", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-3", triggerType: "issue.start", repo: "sandbox" });
  s.transition(job.id, "done", { pr_url: "https://example.com/pr/3" });
  assert.throws(() => s.retry(job.id), /not retryable/);
});
