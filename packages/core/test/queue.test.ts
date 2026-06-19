import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { JobStore } from "../src/jobs.js";
import { JobQueue } from "../src/queue.js";

// Build the schema in an in-memory DB (mirrors store.ts).
function freshStore(): JobStore {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE jobs (id TEXT PRIMARY KEY, identity_key TEXT UNIQUE, source TEXT, entity_id TEXT,
      entity_ref TEXT, trigger_type TEXT, content_hash TEXT, state TEXT, mode TEXT DEFAULT 'create',
      runner TEXT, model TEXT, custom_prompt TEXT, repo TEXT, worktree_path TEXT, branch TEXT, base_branch TEXT,
      routing_instruction TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
      next_eligible_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, last_heartbeat_at INTEGER,
      declared_outcome TEXT, declared_pr_url TEXT, declared_wrote_code INTEGER, verified_outcome TEXT,
      pr_url TEXT, failure_class TEXT, failure_detail TEXT, summary TEXT,
      created_at INTEGER, updated_at INTEGER, terminal_at INTEGER);
    CREATE TABLE job_events (id TEXT PRIMARY KEY, job_id TEXT, seq INTEGER, kind TEXT, from_state TEXT,
      to_state TEXT, data TEXT, at INTEGER);
    CREATE TABLE side_effects (idempotency_key TEXT PRIMARY KEY, kind TEXT, external_id TEXT, created_at INTEGER);
    CREATE TABLE job_dependencies (dependent_entity_id TEXT, blocker_entity_id TEXT, strategy TEXT DEFAULT 'wait',
      resolved INTEGER DEFAULT 0, blocker_branch TEXT, created_at INTEGER, updated_at INTEGER,
      PRIMARY KEY (dependent_entity_id, blocker_entity_id));
  `);
  let clock = 1;
  return new JobStore(db, () => clock++);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("enqueue is idempotent on identity key", () => {
  const store = freshStore();
  const a = store.enqueue({ source: "cli", entityId: "SBX-1", triggerType: "issue.start", repo: "sandbox" });
  const b = store.enqueue({ source: "cli", entityId: "SBX-1", triggerType: "issue.start", repo: "sandbox" });
  assert.equal(a.disposition, "created");
  assert.equal(b.disposition, "deduped");
  assert.equal(a.job.id, b.job.id);
});

test("queue caps concurrency at N", async () => {
  const store = freshStore();
  for (let i = 1; i <= 6; i++) {
    store.enqueue({ source: "cli", entityId: `SBX-${i}`, triggerType: "issue.start", repo: "sandbox" });
  }
  let active = 0;
  let maxActive = 0;
  const queue = new JobQueue(
    store,
    async (job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      store.transition(job.id, "done");
      active--;
    },
    { concurrency: 2 },
  );
  await queue.drain();
  assert.equal(maxActive, 2, "never more than 2 running at once");
  assert.equal(store.countByState()["done"], 6, "all six completed");
});

test("lastImplementedForEntity returns the most recent PR'd job for an entity, else undefined", () => {
  const store = freshStore();
  assert.equal(store.lastImplementedForEntity("MILO-1"), undefined);

  // A queued job with no PR yet must not count as prior implemented work.
  store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.label", repo: "milo" });
  assert.equal(store.lastImplementedForEntity("MILO-1"), undefined);

  const a = store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.label", contentHash: "MILO-1#1", repo: "milo" });
  store.transition(a.job.id, "done", { branch: "feature/milo-1-a", base_branch: "main", pr_url: "https://github.com/o/milo/pull/1" });
  const got = store.lastImplementedForEntity("MILO-1");
  assert.equal(got?.branch, "feature/milo-1-a");
  assert.equal(got?.baseBranch, "main");
  assert.equal(got?.prUrl, "https://github.com/o/milo/pull/1");

  // A newer implemented job wins; a different entity is isolated.
  const b = store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.comment", contentHash: "comment:t2", repo: "milo" });
  store.transition(b.job.id, "done", { branch: "feature/milo-1-a", base_branch: "main", pr_url: "https://github.com/o/milo/pull/2" });
  assert.equal(store.lastImplementedForEntity("MILO-1")?.prUrl, "https://github.com/o/milo/pull/2");
  assert.equal(store.lastImplementedForEntity("MILO-2"), undefined);
});

test("dedupeIfEntityActive collapses a second revise signal into the in-flight one (once a PR exists)", () => {
  const store = freshStore();

  // Prior implemented work for the entity (a shipped PR).
  const seed = store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.label", contentHash: "seed", repo: "milo" });
  store.transition(seed.job.id, "done", { branch: "feature/milo-1", base_branch: "main", pr_url: "https://x/pull/1" });

  // First revise signal (e.g. the delegation) creates a job — nothing else is in flight yet.
  const a = store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.delegate", contentHash: "session:s1", mode: "create", repo: "milo", dedupeIfEntityActive: true });
  assert.equal(a.disposition, "created");

  // Second signal for the SAME action (e.g. the @milo comment) collapses into the in-flight job.
  const b = store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.comment", contentHash: "comment:t1", mode: "attach", repo: "milo", dedupeIfEntityActive: true });
  assert.equal(b.disposition, "deduped");
  assert.equal(b.job.id, a.job.id, "collapsed into the active job, not a new one");

  // Once the active job finishes, a genuinely new follow-up creates a fresh job again.
  store.transition(a.job.id, "done", { pr_url: "https://x/pull/1" });
  const c = store.enqueue({ source: "linear", entityId: "MILO-1", triggerType: "issue.comment", contentHash: "comment:t2", mode: "attach", repo: "milo", dedupeIfEntityActive: true });
  assert.equal(c.disposition, "created", "a later follow-up after completion still runs");
});

test("dedupeIfEntityActive does NOT collapse first-time work (no prior PR) or unflagged jobs", () => {
  const store = freshStore();

  // No prior PR for the entity → two distinct start signals both create (nothing to revise/collapse).
  const a = store.enqueue({ source: "linear", entityId: "MILO-2", triggerType: "issue.delegate", contentHash: "session:s1", repo: "milo", dedupeIfEntityActive: true });
  const b = store.enqueue({ source: "linear", entityId: "MILO-2", triggerType: "issue.comment", contentHash: "comment:t1", mode: "attach", repo: "milo", dedupeIfEntityActive: true });
  assert.equal(a.disposition, "created");
  assert.equal(b.disposition, "created", "no prior PR → not a revise → no collapse");

  // Even with prior work, a non-flagged source is never collapsed.
  store.transition(a.job.id, "done", { pr_url: "https://x/pull/9" });
  const c = store.enqueue({ source: "github", entityId: "MILO-2", triggerType: "pr.mention", contentHash: "gh:1", mode: "attach", repo: "milo" });
  const d = store.enqueue({ source: "github", entityId: "MILO-2", triggerType: "pr.mention", contentHash: "gh:2", mode: "attach", repo: "milo" });
  assert.equal(c.disposition, "created");
  assert.equal(d.disposition, "created", "unflagged jobs bypass the collapse");
});

test("queue never runs two jobs for the same entity at once", async () => {
  const store = freshStore();
  // Two jobs, SAME entity, different trigger (so distinct identity keys).
  store.enqueue({ source: "cli", entityId: "SBX-9", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-9", triggerType: "issue.comment", repo: "sandbox" });

  const concurrentEntities = new Map<string, number>();
  let collision = false;
  const queue = new JobQueue(
    store,
    async (job) => {
      const n = (concurrentEntities.get(job.entityId) ?? 0) + 1;
      concurrentEntities.set(job.entityId, n);
      if (n > 1) collision = true;
      await sleep(20);
      concurrentEntities.set(job.entityId, n - 1);
      store.transition(job.id, "done");
    },
    { concurrency: 4 }, // plenty of slots; per-entity rule must still serialize
  );
  await queue.drain();
  assert.equal(collision, false, "same entity never ran concurrently");
  assert.equal(store.countByState()["done"], 2);
});

test("claimNext holds a dependent while its blocker is unresolved (MILO-4)", () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "stacked");

  // B is gated; A is the only claimable job.
  const first = store.claimNext("w")!;
  assert.equal(first.entityId, "SBX-A", "blocker claimed first");
  assert.equal(store.claimNext("w"), undefined, "dependent stays unclaimable while blocked");

  // Resolve the gate (as the reconciler would once A finished) → B becomes claimable.
  store.resolveDependency("SBX-B", "SBX-A", "feature/sbx-a");
  const second = store.claimNext("w")!;
  assert.equal(second.entityId, "SBX-B", "dependent claimable once resolved");
  assert.equal(store.stackedBaseFor("SBX-B"), "feature/sbx-a", "blocker branch recorded for stacking");
});

test("queue sequences a blocked dependent after its blocker, never concurrently (MILO-4)", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "stacked");

  const order: string[] = [];
  let active = 0;
  let overlap = false;
  const queue = new JobQueue(
    store,
    async (job) => {
      active++;
      if (active > 1) overlap = true;
      order.push(job.entityId);
      await sleep(20);
      store.transition(job.id, "done");
      active--;
    },
    {
      concurrency: 4, // plenty of slots; the dependency gate must still serialize A→B
      // Mimic the reconciler: once the blocker is done, lift B's gate.
      onTick: () => {
        const a = store.latestJobForEntity("SBX-A");
        if (a?.state === "done") store.resolveDependency("SBX-B", "SBX-A", a.branch);
      },
    },
  );
  await queue.drain();
  assert.equal(overlap, false, "blocker and dependent never ran at the same time");
  assert.deepEqual(order, ["SBX-A", "SBX-B"], "blocker ran before dependent");
  assert.equal(store.countByState()["done"], 2, "both completed");
});
