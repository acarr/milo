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

// --- requeueTerminal: re-arming a job the breaker abandoned ------------------------------------
// `enqueue` used to dedupe onto ANY terminal row — both arms of its `if` returned the same thing,
// so the terminal check was dead code. A breaker-abandoned ticket could never be re-triggered:
// re-labelling it, re-delegating it, editing it all hit the same constant identity key, silently.

/** Abandon a job the way the pipeline's breaker gate does. */
function breakerAbandoned(s: JobStore, entityId: string) {
  const { job } = s.enqueue({ source: "cli", entityId, triggerType: "issue.start", repo: "sandbox" });
  s.transition(job.id, "abandoned", { failure_class: "breaker", failure_detail: "breaker open" });
  return job;
}

test("requeueTerminal re-arms an abandoned job IN PLACE, keeping its identity and history", () => {
  const s = store();
  const original = breakerAbandoned(s, "SBX-RQ1");
  s.recordEvent(original.id, "breaker-requeue", { attempt: 1 });

  const res = s.enqueue({ source: "cli", entityId: "SBX-RQ1", triggerType: "issue.start", repo: "sandbox", requeueTerminal: true });

  assert.equal(res.disposition, "requeued", "the declared-but-never-produced disposition finally has a producer");
  assert.equal(res.job.id, original.id, "same row — the transcript the user is watching survives");
  assert.equal(res.job.identityKey, original.identityKey, "identity stays derivable from the row");
  assert.equal(res.job.state, "queued");
  assert.equal(res.job.attempts, 0);
  assert.equal(res.job.failureClass, null);
  assert.equal(res.job.terminalAt, null);
  assert.equal(s.countEvents(original.id, "breaker-requeue"), 1, "job_events survives the reset");
});

test("requeueTerminal touches ONLY abandoned — every other terminal state really happened", () => {
  const s = store();
  for (const [entityId, state] of [
    ["SBX-RQ2", "done"],
    ["SBX-RQ3", "failed"],
    ["SBX-RQ4", "needs-attention"],
    ["SBX-RQ5", "cancelled"],
    ["SBX-RQ6", "discovery-done"],
  ] as const) {
    const { job } = s.enqueue({ source: "cli", entityId, triggerType: "issue.start", repo: "sandbox" });
    s.transition(job.id, state);
    const res = s.enqueue({ source: "cli", entityId, triggerType: "issue.start", repo: "sandbox", requeueTerminal: true });
    assert.equal(res.disposition, "deduped", `${state} must still need an explicit rerun`);
    assert.equal(res.job.state, state, "and must not be moved");
  }
});

test("requeueTerminal does not resurrect a job the user cancelled before the breaker hit it", () => {
  const s = store();
  const { job } = s.enqueue({ source: "cli", entityId: "SBX-RQ7", triggerType: "issue.start", repo: "sandbox" });
  s.requestCancel(job.id); // cancel lands while it's still queued…
  s.transition(job.id, "abandoned", { failure_class: "breaker", failure_detail: "breaker open" }); // …then the breaker trips

  const res = s.enqueue({ source: "cli", entityId: "SBX-RQ7", triggerType: "issue.start", repo: "sandbox", requeueTerminal: true });
  assert.equal(res.disposition, "deduped", "the user said stop; it stays stopped");
  assert.equal(res.job.state, "abandoned");
});

test("WITHOUT the flag an abandoned job still dedupes — this is what protects the pollers", () => {
  const s = store();
  const original = breakerAbandoned(s, "SBX-RQ8");

  // The Linear label trigger re-emits the same constant content hash EVERY poll tick. If a poll
  // requeued abandoned jobs, an open breaker would livelock: requeue → claim → abandon → requeue.
  for (let i = 0; i < 3; i++) {
    const res = s.enqueue({ source: "cli", entityId: "SBX-RQ8", triggerType: "issue.start", repo: "sandbox" });
    assert.equal(res.disposition, "deduped");
    assert.equal(res.job.state, "abandoned");
  }
  assert.equal(s.get(original.id)!.state, "abandoned");
});
