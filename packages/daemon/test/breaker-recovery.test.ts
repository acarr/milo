import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-breaker-recovery-"));
import { openDatabase, JobStore, type LinearClient } from "@milo/core";
import { sweepBreakerRecovery } from "../src/breaker-recovery.js";

/**
 * The sweep that makes an abandoned job recoverable.
 *
 * On 2026-09-22 four wazzon tickets were abandoned by the circuit breaker at 07:30. Docker
 * recovered 12 minutes later. None of them ever ran, and re-delegating in Linear did nothing,
 * silently. The sweep closes that loop — and, when the repo really is broken, converts the silent
 * dead end into a visible `needs-attention` with a next step attached.
 */

const COOLDOWN = 10_000;

/**
 * A store on its OWN database file. The sweep is global across repos, so tests sharing one database
 * would see each other's casualties as soon as their cooldowns elapsed.
 */
function freshStore(clock: () => number): JobStore {
  return new JobStore(openDatabase(join(mkdtempSync(join(os.tmpdir(), "milo-sweep-")), "milo.db")), clock);
}

function fakeLinear(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    agentSessionForIssue: async () => "session-1",
    agentThought: async (_s: string, body: string) => {
      calls.push(body);
      return true;
    },
    fetchIssue: async () => ({ id: "uuid-1" }),
    addComment: async () => undefined,
    ...overrides,
  } as unknown as LinearClient;
  return { client, calls };
}

/** A repo with a tripped breaker and `n` jobs it abandoned. */
function tripped(store: JobStore, repo: string, entityIds: string[]): string[] {
  for (let i = 0; i < 5; i++) store.recordRepoInfraFailure(repo, 5, COOLDOWN);
  return entityIds.map((entityId) => {
    const { job } = store.enqueue({ source: "linear", entityId, triggerType: "issue.label", repo });
    store.transition(job.id, "abandoned", { failure_class: "breaker", failure_detail: "breaker open" });
    return job.id;
  });
}

test("a still-open breaker is left completely alone", async () => {
  let clock = 1_000_000;
  const store = freshStore(() => clock);
  const ids = tripped(store, "swpA", ["SWPA-1", "SWPA-2"]);
  const { client, calls } = fakeLinear();

  assert.equal(await sweepBreakerRecovery({ store, linear: client }), 0);
  for (const id of ids) assert.equal(store.get(id)!.state, "abandoned");
  assert.deepEqual(calls, [], "nothing to say while it's still cooling down");
});

test("once the cooldown elapses the casualties are requeued, oldest first, and Linear is told", async () => {
  let clock = 2_000_000;
  const store = freshStore(() => clock);
  const ids = tripped(store, "swpB", ["SWPB-1", "SWPB-2", "SWPB-3"]);
  const { client, calls } = fakeLinear();

  clock += COOLDOWN;
  assert.equal(await sweepBreakerRecovery({ store, linear: client }), 3);

  for (const id of ids) {
    const job = store.get(id)!;
    assert.equal(job.state, "queued");
    assert.equal(job.failureClass, null);
    assert.equal(job.attempts, 0);
    assert.equal(store.countEvents(id, "breaker-requeue"), 1);
  }
  assert.equal(calls.length, 3, "one notice per job");
  assert.match(calls[0]!, /picking this back up/);
});

test("the sweep is idempotent — a second pass requeues nothing", async () => {
  let clock = 3_000_000;
  const store = freshStore(() => clock);
  tripped(store, "swpC", ["SWPC-1"]);
  const { client } = fakeLinear();

  clock += COOLDOWN;
  assert.equal(await sweepBreakerRecovery({ store, linear: client }), 1);
  // retry() clears failure_class and sets state=queued, so the row stops matching the predicate
  // immediately. The idempotency is structural — no ledger needed for the requeue itself.
  assert.equal(await sweepBreakerRecovery({ store, linear: client }), 0);
});

test("a repo that keeps failing parks the job in needs-attention after the retry cap", async () => {
  let clock = 4_000_000;
  const store = freshStore(() => clock);
  const repo = "swpD";
  const [id] = tripped(store, repo, ["SWPD-1"]);
  const { client, calls } = fakeLinear();

  // Three cycles of "cooldown elapses → requeued → repo still broken → abandoned again".
  for (let i = 0; i < 3; i++) {
    clock += COOLDOWN;
    assert.equal(await sweepBreakerRecovery({ store, linear: client, maxRequeues: 3 }), 1, `cycle ${i + 1}`);
    store.transition(id!, "abandoned", { failure_class: "breaker", failure_detail: "breaker open" });
    // A failed probe re-opens the breaker with a NEW opened_at — which is exactly why the loop
    // bound counts job_events rather than keying a side-effect on opened_at.
    store.recordRepoInfraFailure(repo, 5, COOLDOWN);
  }

  clock += COOLDOWN;
  assert.equal(await sweepBreakerRecovery({ store, linear: client, maxRequeues: 3 }), 0, "cap reached");
  const job = store.get(id!)!;
  assert.equal(job.state, "needs-attention", "a visible dead end, in a state humans actually look at");
  assert.equal(job.failureClass, "breaker");
  assert.match(job.failureDetail ?? "", new RegExp(`milo retry ${id}`));

  const giveUp = calls.filter((c) => /gave up/.test(c));
  assert.equal(giveUp.length, 1, "told once, not on every tick");

  // And it stays parked — no further sweep activity.
  clock += COOLDOWN;
  assert.equal(await sweepBreakerRecovery({ store, linear: client, maxRequeues: 3 }), 0);
  assert.equal(calls.filter((c) => /gave up/.test(c)).length, 1);
});

test("a Linear client that throws still gets the job requeued — the notice is best-effort", async () => {
  let clock = 5_000_000;
  const store = freshStore(() => clock);
  const [id] = tripped(store, "swpE", ["SWPE-1"]);
  // No agent session, and `addComment` throws — the documented shape of that call.
  const { client } = fakeLinear({
    agentSessionForIssue: async () => undefined,
    addComment: async () => {
      throw new Error("linear is down");
    },
  });

  clock += COOLDOWN;
  assert.equal(await sweepBreakerRecovery({ store, linear: client }), 1);
  assert.equal(store.get(id!)!.state, "queued", "the job moving is the point");
});
