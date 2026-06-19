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
