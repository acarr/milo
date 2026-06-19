import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-watchdog-"));
import { openDatabase, JobStore } from "@milo/core";

// Each test gets its own DB file so requeued jobs from one don't leak into another.
const freshDb = () => openDatabase(join(mkdtempSync(join(os.tmpdir(), "milo-wd-")), "milo.db"));

test("reclaimExpiredLeases requeues active jobs with an expired lease, leaves fresh ones", () => {
  let clock = 1_000_000;
  const store = new JobStore(freshDb(), () => clock);

  const a = store.enqueue({ source: "cli", entityId: "SBX-1", triggerType: "issue.start", repo: "r" });
  const b = store.enqueue({ source: "cli", entityId: "SBX-2", triggerType: "issue.start", repo: "r" });

  // Claim both → leases expire at clock + 60s.
  store.claimNext("w", 60_000);
  store.claimNext("w", 60_000);
  assert.equal(store.get(a.job.id)!.state, "claimed");

  // 70s later, with no heartbeat, both leases are expired — but grace is 30s, so 70s < 60+30.
  clock += 70_000;
  assert.equal(store.reclaimExpiredLeases(30_000), 0);

  // Heartbeat job A (simulating a live worker); B stays stranded.
  store.heartbeat(a.job.id, 60_000);

  // Advance past lease + grace: B is reclaimed, A (just heartbeated) is not.
  clock += 60_000;
  const reclaimed = store.reclaimExpiredLeases(30_000);
  assert.equal(reclaimed, 1);
  assert.equal(store.get(b.job.id)!.state, "queued"); // requeued
  assert.equal(store.get(a.job.id)!.state, "claimed"); // still held

  // The reclaim is auditable.
  const evt = store.events(b.job.id).find((e) => e.kind === "reclaimed");
  assert.ok(evt, "records a reclaimed event");
});

test("reclaimExpiredLeases ignores terminal jobs", () => {
  let clock = 5_000_000;
  const store = new JobStore(freshDb(), () => clock);
  const a = store.enqueue({ source: "cli", entityId: "SBX-3", triggerType: "issue.start", repo: "r" });
  store.claimNext("w", 60_000);
  store.transition(a.job.id, "done");
  clock += 1_000_000;
  assert.equal(store.reclaimExpiredLeases(30_000), 0);
  assert.equal(store.get(a.job.id)!.state, "done");
});
