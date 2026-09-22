import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-breaker-"));
import { openDatabase, JobStore } from "@milo/core";

test("breaker opens after N consecutive infra failures, then half-opens after cooldown", () => {
  let clock = 1_000_000;
  const store = new JobStore(openDatabase(), () => clock);
  const repo = "repoA";

  assert.equal(store.repoHealth(repo).breakerState, "closed");

  // 4 failures: still closed; 5th: opens.
  for (let i = 0; i < 4; i++) store.recordRepoInfraFailure(repo, 5, 30_000);
  assert.equal(store.repoHealth(repo).breakerState, "closed");
  store.recordRepoInfraFailure(repo, 5, 30_000);
  assert.equal(store.isRepoBreakerOpen(repo), true);

  // Within cooldown → still open.
  clock += 10_000;
  assert.equal(store.isRepoBreakerOpen(repo), true);

  // After cooldown → half-open (a single probe is allowed).
  clock += 30_000;
  assert.equal(store.repoHealth(repo).breakerState, "half-open");
  assert.equal(store.isRepoBreakerOpen(repo), false);
});

test("a failed probe in half-open re-opens; a success closes the breaker", () => {
  let clock = 5_000_000;
  const store = new JobStore(openDatabase(), () => clock);
  const repo = "repoB";
  for (let i = 0; i < 5; i++) store.recordRepoInfraFailure(repo, 5, 10_000);
  clock += 10_000; // → half-open
  assert.equal(store.repoHealth(repo).breakerState, "half-open");

  // failed probe → straight back to open
  store.recordRepoInfraFailure(repo, 5, 10_000);
  assert.equal(store.isRepoBreakerOpen(repo), true);

  // cooldown → half-open, then a success closes + resets the counter
  clock += 10_000;
  assert.equal(store.repoHealth(repo).breakerState, "half-open");
  store.recordRepoSuccess(repo);
  const h = store.repoHealth(repo);
  assert.equal(h.breakerState, "closed");
  assert.equal(h.consecutiveInfraFailures, 0);
});

test("recordRepoSuccess resets the failure count before the breaker trips", () => {
  const store = new JobStore(openDatabase());
  const repo = "repoC";
  store.recordRepoInfraFailure(repo, 5);
  store.recordRepoInfraFailure(repo, 5);
  store.recordRepoSuccess(repo);
  assert.equal(store.repoHealth(repo).consecutiveInfraFailures, 0);
  // counting restarts from zero
  for (let i = 0; i < 4; i++) store.recordRepoInfraFailure(repo, 5);
  assert.equal(store.isRepoBreakerOpen(repo), false);
});

// --- Breaker recovery: finding the casualties ---------------------------------------------------
// The breaker abandons jobs it never attempted. Nothing used to bring them back: recordRepoSuccess
// only fires when some OTHER job for the repo succeeds, and after a storm the casualties are
// usually the only work there is.

/** Abandon a job exactly the way the pipeline's breaker gate does. */
function abandonByBreaker(store: JobStore, entityId: string, repo: string): string {
  const { job } = store.enqueue({ source: "linear", entityId, triggerType: "issue.label", repo });
  store.transition(job.id, "abandoned", {
    failure_class: "breaker",
    failure_detail: `repo ${repo} circuit breaker open`,
  });
  return job.id;
}

test("breaker casualties surface only once the breaker is no longer open", () => {
  let clock = 9_000_000;
  const store = new JobStore(openDatabase(), () => clock);
  const repo = "recoverA";
  for (let i = 0; i < 5; i++) store.recordRepoInfraFailure(repo, 5, 10_000);
  for (const id of ["RCA-1", "RCA-2", "RCA-3"]) abandonByBreaker(store, id, repo);

  // The rows are findable immediately — it's the BREAKER STATE that gates the sweep, and a caller
  // checking repoHealth() is what performs the lazy open → half-open flip.
  assert.ok(store.breakerAbandonedRepos().includes(repo));
  assert.equal(store.repoHealth(repo).breakerState, "open", "still cooling down");

  clock += 10_000;
  assert.equal(store.repoHealth(repo).breakerState, "half-open", "cooldown elapsed → probe allowed");
  const casualties = store.breakerAbandoned(repo);
  assert.deepEqual(casualties.map((j) => j.entityId), ["RCA-1", "RCA-2", "RCA-3"], "oldest first — they queued first");
});

test("only breaker casualties are swept up — not failures, cancels, or ancient rows", () => {
  let clock = 20_000_000;
  const store = new JobStore(openDatabase(), () => clock);
  const repo = "recoverB";

  // A real failure, not the breaker: retrying it is not this sweep's business.
  const failed = store.enqueue({ source: "linear", entityId: "RCB-1", triggerType: "issue.label", repo }).job;
  store.transition(failed.id, "failed", { failure_class: "transient-infra", failure_detail: "git fetch died" });

  // Deterministic failures never reach `abandoned` at all, but assert the class filter anyway.
  const logic = store.enqueue({ source: "linear", entityId: "RCB-2", triggerType: "issue.label", repo }).job;
  store.transition(logic.id, "needs-attention", { failure_class: "logic", failure_detail: "branch checked out" });

  // Cancelled between claim and the breaker gate: the user said stop, so it stays stopped.
  const toCancel = store.enqueue({ source: "linear", entityId: "RCB-3", triggerType: "issue.label", repo }).job;
  store.requestCancel(toCancel.id); // only takes on a non-terminal row, which is the real sequence
  store.transition(toCancel.id, "abandoned", { failure_class: "breaker", failure_detail: "breaker open" });

  // A casualty from a PREVIOUS episode. Without the window guard, the first sweep after deploying
  // would resurrect months of history at once.
  abandonByBreaker(store, "RCB-4", repo);
  clock += 48 * 60 * 60_000; // …two days pass

  const live = abandonByBreaker(store, "RCB-5", repo);

  assert.deepEqual(store.breakerAbandoned(repo).map((j) => j.id), [live], "exactly one recoverable job");
  assert.ok(store.breakerAbandonedRepos().includes(repo));
  // Age the live one out too, and the repo drops off the sweep's list entirely.
  clock += 1_000;
  assert.deepEqual(store.breakerAbandoned(repo, 500), []);
  assert.ok(!store.breakerAbandonedRepos(500).includes(repo));
});

test("countEvents survives retry() — it is the loop bound a side-effect ledger cannot be", () => {
  const store = new JobStore(openDatabase());
  const repo = "recoverC";
  const id = abandonByBreaker(store, "RCC-1", repo);

  assert.equal(store.countEvents(id, "breaker-requeue"), 0);
  store.recordEvent(id, "breaker-requeue", { repo, attempt: 1 });
  store.retry(id); // clears state/attempts/failure_class — but must NOT clear job_events
  assert.equal(store.countEvents(id, "breaker-requeue"), 1);
  store.recordEvent(id, "breaker-requeue", { repo, attempt: 2 });
  assert.equal(store.countEvents(id, "breaker-requeue"), 2);
  assert.equal(store.countEvents(id, "some-other-kind"), 0);
});
