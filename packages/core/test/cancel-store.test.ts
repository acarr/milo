import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-cancel-"));

import { openDatabase, JobStore } from "@milo/core";

const store = () => new JobStore(openDatabase());

test("requestCancel flags a non-terminal job; no-op once terminal", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-1", triggerType: "issue.start", repo: "sandbox" });
  s.transition(job.id, "running", {});
  assert.equal(s.isCancelRequested(job.id), false);
  s.requestCancel(job.id);
  assert.equal(s.isCancelRequested(job.id), true);
  assert.equal(s.get(job.id)!.cancelRequested, true);

  const { job: done } = s.enqueue({ source: "cli", entityId: "SBX-2", triggerType: "issue.start", repo: "sandbox" });
  s.transition(done.id, "done", { pr_url: "https://example.com/pr/2" });
  s.requestCancel(done.id);
  assert.equal(s.isCancelRequested(done.id), false, "a finished job can't be cancelled");
});

test("cancelQueued finalizes a queued job to `cancelled`; no-op otherwise", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-3", triggerType: "issue.start", repo: "sandbox" });
  assert.equal(s.cancelQueued(job.id), true);
  assert.equal(s.get(job.id)!.state, "cancelled");
  assert.equal(s.cancelQueued(job.id), false, "no longer queued");
});

test("retry clears a prior cancel flag", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-4", triggerType: "issue.start", repo: "sandbox" });
  s.transition(job.id, "running", {});
  s.requestCancel(job.id);
  s.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: "stuck" });
  assert.equal(s.get(job.id)!.cancelRequested, true);
  s.retry(job.id);
  assert.equal(s.get(job.id)!.cancelRequested, false);
  assert.equal(s.get(job.id)!.state, "queued");
});

test("`cancelled` is a terminal state, not in the queued set", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-5", triggerType: "issue.start", repo: "sandbox" });
  s.cancelQueued(job.id);
  assert.equal(s.get(job.id)!.state, "cancelled");
  const queued = s.list({ state: "queued" }).map((j) => j.id);
  assert.ok(!queued.includes(job.id), "a cancelled job is no longer claimable");
});
