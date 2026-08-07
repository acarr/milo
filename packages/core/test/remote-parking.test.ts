import { test } from "node:test";
import assert from "node:assert/strict";
import { JobStore } from "../src/jobs.js";
import { openDatabase } from "../src/store.js";
import { SLOT_STATES, ENTITY_LOCK_STATES, TERMINAL_STATES } from "../src/jobs.js";

/**
 * Parking a job on a remote session is the mechanism that stops a Conductor run from holding one of
 * the (default 3) local concurrency slots for its whole duration. These tests pin the invariants
 * that make that safe — they live in the queue's most safety-critical code.
 */

function freshStore(): { store: JobStore; tick: () => void } {
  const db = openDatabase(":memory:");
  let clock = 1_000;
  return { store: new JobStore(db, () => clock), tick: () => (clock += 60_000) };
}

const enqueue = (store: JobStore, entityId: string) =>
  store.enqueue({ source: "linear", entityId, triggerType: "issue.label", repo: "sandbox" }).job;

test("state sets: parked jobs hold the entity lock but NOT a local slot", () => {
  assert.ok(!SLOT_STATES.includes("remote-waiting"), "a parked job must not consume a local slot");
  assert.ok(ENTITY_LOCK_STATES.includes("remote-waiting"), "but it must still own its ticket");
  assert.ok(!TERMINAL_STATES.includes("remote-waiting"), "and it is not finished");
  for (const s of SLOT_STATES) assert.ok(ENTITY_LOCK_STATES.includes(s), `${s} must hold the entity lock too`);
});

test("parking frees the job from the queue while keeping its entity locked", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);

  assert.equal(store.get(a.id)!.state, "remote-waiting");
  // The main queue must not hand the parked job back out — the tracker owns it now.
  assert.equal(store.claimNext("w1"), undefined, "a parked job is not claimable by the main queue");

  // A second trigger for the SAME ticket must not start a rival run (which would mean a second
  // cloud workspace, a second branch, and eventually two PRs).
  store.enqueue({ source: "linear", entityId: "SBX-1", triggerType: "issue.delegate", repo: "sandbox" });
  assert.equal(store.claimNext("w1"), undefined, "per-entity lock still held while parked");
});

test("a parked job does not block OTHER entities from claiming a slot", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);

  enqueue(store, "SBX-2");
  const next = store.claimNext("w1");
  assert.equal(next?.entityId, "SBX-2", "the freed slot must be usable by other work");
});

test("willQueue does not count parked jobs against the local cap", () => {
  const { store } = freshStore();
  // Fill the local cap with parked remote jobs.
  for (const id of ["SBX-1", "SBX-2", "SBX-3"]) {
    const j = enqueue(store, id);
    store.claimNext("w1");
    store.parkOnRemote(j.id);
  }
  enqueue(store, "SBX-9");
  // Three remote runs are in flight but none is using a local slot, so this job starts immediately.
  // Counting them would tell the user "queued" for work that actually runs right away.
  assert.equal(store.willQueue("SBX-9", 3), false);
});

test("willQueue still reports a wait when the entity itself is parked", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);
  assert.equal(store.willQueue("SBX-1", 3), true, "same-entity work must still be reported as waiting");
});

test("claimRemoteWaiting hands a parked job to exactly one tracker", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);

  const first = store.claimRemoteWaiting("tracker-1");
  assert.equal(first?.id, a.id);
  assert.equal(first?.state, "remote-waiting", "tracking does not change the state — it IS still waiting");
  assert.equal(store.claimRemoteWaiting("tracker-2"), undefined, "leased to the first tracker");
});

test("a cancel-requested parked job is STILL claimable, so the remote session can be stopped", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);
  store.requestCancel(a.id);

  // The tracker is the only thing that can reach the cloud session to cancel it. Skipping
  // cancel-requested jobs here would strand the job forever with a live workspace behind it.
  assert.equal(store.claimRemoteWaiting("tracker-1")?.id, a.id);
});

test("a stalled tracker's job is reclaimed and re-claimable", () => {
  const { store, tick } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);
  store.claimRemoteWaiting("tracker-dead");

  assert.equal(store.reclaimStalledRemote(10 * 60_000), 0, "a fresh tracker is not stalled");
  tick(); // +60s
  tick(); // +120s
  tick(); // ... push past the staleness window
  assert.equal(store.reclaimStalledRemote(2 * 60_000), 1, "a tracker that stopped polling is reclaimed");
  assert.equal(store.claimRemoteWaiting("tracker-new")?.id, a.id, "another tracker can take over");
});

test("remotePoll keeps a healthy tracker's claim alive", () => {
  const { store, tick } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);
  store.claimRemoteWaiting("tracker-1");

  tick();
  tick();
  store.remotePoll(a.id); // still alive
  assert.equal(store.reclaimStalledRemote(2 * 60_000), 0, "a polling tracker must not be reclaimed");
});

test("the lease watchdog ignores parked jobs (they legitimately have no local worker)", () => {
  const { store, tick } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);

  for (let i = 0; i < 10; i++) tick(); // long past any lease + grace
  assert.equal(store.reclaimExpiredLeases(60_000), 0, "reclaimExpiredLeases must not touch remote-waiting");
  assert.equal(store.get(a.id)!.state, "remote-waiting", "and the job stays parked");
});

test("recoverOnStartup leaves parked jobs alone — the remote work is still running", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);

  const b = enqueue(store, "SBX-2");
  store.claimNext("w1"); // leaves SBX-2 in `claimed`

  const recovered = store.recoverOnStartup();
  assert.equal(recovered, 1, "only the locally-claimed job is requeued");
  assert.equal(store.get(a.id)!.state, "remote-waiting", "the parked job must NOT be requeued");
  assert.equal(store.get(b.id)!.state, "queued");
});

test("a failed tracker tick keeps the job parked WITH its session, never requeues it", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.transition(a.id, "running", { remote_workspace_id: "ws-1", remote_session_id: "sess-1" });
  store.parkOnRemote(a.id);
  store.claimRemoteWaiting("tracker-1");

  // e.g. Linear returned a proxy error page while we fetched the issue. The cloud session is fine.
  const outcome = store.retryRemoteTracking(a.id, "transient-infra", "upstream connect error");
  assert.equal(outcome, "parked");

  const j = store.get(a.id)!;
  assert.equal(j.state, "remote-waiting", "must NOT be requeued into the main queue");
  assert.equal(j.remoteSessionId, "sess-1", "the live session must survive — requeuing would orphan it");
  assert.equal(j.attempts, 1);
  assert.equal(store.claimRemoteWaiting("tracker-2")?.id, a.id, "claimable again for the next tick");
});

test("a repeatedly-failing tracker tick eventually escalates instead of spinning forever", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.parkOnRemote(a.id);

  assert.equal(store.retryRemoteTracking(a.id, "transient-infra", "boom"), "parked"); // 1
  assert.equal(store.retryRemoteTracking(a.id, "transient-infra", "boom"), "parked"); // 2
  assert.equal(store.retryRemoteTracking(a.id, "transient-infra", "boom"), "exhausted"); // 3 == maxAttempts
  assert.equal(store.get(a.id)!.state, "needs-attention");
});

test("parking preserves the remote session pointers a resume depends on", () => {
  const { store } = freshStore();
  const a = enqueue(store, "SBX-1");
  store.claimNext("w1");
  store.transition(a.id, "running", {
    remote_provider: "conductor",
    remote_workspace_id: "ws-1",
    remote_session_id: "sess-1",
    remote_url: "conductor://x",
    remote_saw_working: 1,
  });
  store.parkOnRemote(a.id);

  const j = store.get(a.id)!;
  assert.equal(j.remoteWorkspaceId, "ws-1");
  assert.equal(j.remoteSessionId, "sess-1");
  assert.equal(j.remoteSawWorking, true, "the idle/working latch must survive parking");
});
