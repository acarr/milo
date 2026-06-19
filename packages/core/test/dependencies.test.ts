import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { JobStore } from "../src/jobs.js";
import { MiloConfigSchema } from "../src/config.js";
import {
  resolveDependencyStrategy,
  reconcileDependencies,
  discoverDependencies,
  syncDependencies,
  dependencyHold,
} from "../src/dependencies.js";

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

const config = MiloConfigSchema.parse({});

test("strategy: labels override the configured default", () => {
  assert.equal(resolveDependencyStrategy(config, []), "wait", "conservative default");
  assert.equal(resolveDependencyStrategy(config, ["stacked"]), "stacked");
  assert.equal(resolveDependencyStrategy(config, ["milo:stacked"]), "stacked");
  assert.equal(resolveDependencyStrategy(config, ["wait-for-merge"]), "wait");
  const stackedDefault = MiloConfigSchema.parse({ dependencies: { defaultStrategy: "stacked" } });
  assert.equal(resolveDependencyStrategy(stackedDefault, []), "stacked");
});

const fakeLinear = {
  fetchIssue: async (id: string) => ({ id: `uuid-${id}`, labels: [] }),
  addComment: async () => {},
} as any;

test("reconcile (stacked): resolves with the blocker's branch once it's done", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "stacked");

  // Blocker still in flight → stays gated.
  store.transition(store.latestJobForEntity("SBX-A")!.id, "running");
  await reconcileDependencies({ config, store, linear: fakeLinear });
  assert.equal(store.dependenciesFor("SBX-B")[0]!.resolved, false);

  // Blocker done with a head branch → resolves, recording the branch to stack on.
  store.transition(store.latestJobForEntity("SBX-A")!.id, "done", { branch: "feature/sbx-a", pr_url: "x" });
  await reconcileDependencies({ config, store, linear: fakeLinear });
  assert.equal(store.dependenciesFor("SBX-B")[0]!.resolved, true);
  assert.equal(store.stackedBaseFor("SBX-B"), "feature/sbx-a");
});

test("reconcile (wait): a discovery-only blocker resolves with no PR to wait on", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "wait");
  store.transition(store.latestJobForEntity("SBX-A")!.id, "discovery-done");
  await reconcileDependencies({ config, store, linear: fakeLinear });
  assert.equal(store.dependenciesFor("SBX-B")[0]!.resolved, true);
});

test("reconcile: a failed blocker is dropped so the dependent never deadlocks", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "stacked");
  store.recordSideEffect("dep-notice:SBX-B:SBX-A", "dep-notice"); // we announced the sequencing

  let commented = "";
  const linear = { ...fakeLinear, addComment: async (_id: string, body: string) => { commented = body; } } as any;
  store.transition(store.latestJobForEntity("SBX-A")!.id, "needs-attention");
  await reconcileDependencies({ config, store, linear });

  assert.equal(store.hasDependency("SBX-B", "SBX-A"), false, "edge dropped");
  assert.match(commented, /no longer sequencing/, "thread corrected since we'd announced it");
});

test("reconcile: disabling the feature clears existing gates so dependents aren't stranded", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "wait");

  // The gate holds B while the feature is on…
  assert.equal(store.claimNext("w")!.entityId, "SBX-A");
  assert.equal(store.claimNext("w"), undefined, "B gated while enabled");

  // …but turning the feature off clears recorded gates on the next reconcile (claimNext's SQL
  // doesn't read config, so a stale edge would otherwise strand B forever).
  const disabled = MiloConfigSchema.parse({ dependencies: { enabled: false } });
  await reconcileDependencies({ config: disabled, store, linear: fakeLinear });
  assert.equal(store.hasDependency("SBX-B", "SBX-A"), false, "gate cleared");
  assert.equal(store.claimNext("w")!.entityId, "SBX-B", "dependent claimable again");
});

test("discover: a terminally-failed blocker is never recorded (no record/drop churn)", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.transition(store.latestJobForEntity("SBX-A")!.id, "needs-attention"); // blocker failed terminally

  const linear = {
    ...fakeLinear,
    blockedBy: async (id: string) =>
      id === "SBX-B"
        ? { issueId: "uuid-SBX-B", blockers: [{ identifier: "SBX-A", stateType: "started" }] }
        : { issueId: `uuid-${id}`, blockers: [] },
  } as any;

  await discoverDependencies({ config, store, linear });
  assert.equal(store.hasDependency("SBX-B", "SBX-A"), false, "edge never recorded for a failed blocker");
});

test("reconcile (wait): a blocker PR closed without merging drops the gate; a merged one resolves it", async () => {
  const store = freshStore();
  store.enqueue({ source: "cli", entityId: "SBX-A", triggerType: "issue.start", repo: "sandbox" });
  store.enqueue({ source: "cli", entityId: "SBX-B", triggerType: "issue.start", repo: "sandbox" });
  store.recordDependency("SBX-B", "SBX-A", "wait");
  store.transition(store.latestJobForEntity("SBX-A")!.id, "done", {
    branch: "feature/sbx-a",
    pr_url: "https://github.com/acme/repo/pull/1",
  });

  // PR closed without merging → waiting would deadlock → gate dropped.
  await reconcileDependencies({ config, store, linear: fakeLinear, fetchPr: (() => ({ state: "CLOSED" })) as any });
  assert.equal(store.hasDependency("SBX-B", "SBX-A"), false, "gate dropped");

  // PR merged → gate resolves.
  store.recordDependency("SBX-B", "SBX-A", "wait");
  await reconcileDependencies({ config, store, linear: fakeLinear, fetchPr: (() => ({ state: "MERGED" })) as any });
  assert.equal(store.dependenciesFor("SBX-B")[0]!.resolved, true, "merged PR resolves the gate");

  // PR still open → keep gating.
  store.recordDependency("SBX-B", "SBX-C", "wait");
  store.enqueue({ source: "cli", entityId: "SBX-C", triggerType: "issue.start", repo: "sandbox" });
  store.transition(store.latestJobForEntity("SBX-C")!.id, "done", {
    branch: "feature/sbx-c",
    pr_url: "https://github.com/acme/repo/pull/2",
  });
  await reconcileDependencies({ config, store, linear: fakeLinear, fetchPr: (() => ({ state: "OPEN" })) as any });
  assert.equal(store.dependenciesFor("SBX-B").find((d) => d.blockerEntityId === "SBX-C")!.resolved, false, "open PR keeps gating");
});

// ---- Enqueue-time dependency holds (MILO-15): webhook/poll ingress race ----

test("dependencyHold: applies only to Linear create-mode work when the feature is on", () => {
  const now = 1_000;
  assert.equal(dependencyHold(config, { source: "linear", mode: "create" }, now), now + 60_000);
  assert.equal(dependencyHold(config, { source: "linear" }, now), now + 60_000, "undefined mode defaults to create");
  assert.equal(dependencyHold(config, { source: "linear", mode: "attach" }, now), undefined, "revisions never need sequencing");
  assert.equal(dependencyHold(config, { source: "github", mode: "attach" }, now), undefined);
  assert.equal(dependencyHold(config, { source: "cli" }, now), undefined, "CLI path syncs inline instead");
  const off = MiloConfigSchema.parse({ dependencies: { enabled: false } });
  assert.equal(dependencyHold(off, { source: "linear" }, now), undefined);
  const zero = MiloConfigSchema.parse({ dependencies: { holdMs: 0 } });
  assert.equal(dependencyHold(zero, { source: "linear" }, now), undefined, "holdMs 0 disables holds");
});

test("hold: a held job is unclaimable until cleared; clearing never touches retry backoff", () => {
  const store = freshStore();
  store.enqueue({ source: "linear", entityId: "SBX-H", triggerType: "issue.delegate", repo: "sandbox", holdUntil: 10_000 });
  assert.equal(store.claimNext("w"), undefined, "held job can't be claimed");

  const job = store.latestJobForEntity("SBX-H")!;
  store.clearEnqueueHold(job.id);
  assert.equal(store.claimNext("w")!.entityId, "SBX-H", "claimable once the hold clears");

  // A retrying job's backoff lives in the same column — clearEnqueueHold must never shorten it.
  const retry = store.enqueue({ source: "linear", entityId: "SBX-R", triggerType: "issue.delegate", repo: "sandbox" }).job;
  store.scheduleRetry(retry.id, 10_000, "transient-infra", "test backoff"); // attempts→1, eligible far in the future
  store.clearEnqueueHold(retry.id);
  const after = store.get(retry.id)!;
  assert.ok(after.nextEligibleAt !== null && after.nextEligibleAt >= 10_000, "retry backoff untouched");
});

test("discovery: clears the hold when the issue has no blockers (the common case)", async () => {
  const store = freshStore();
  store.enqueue({ source: "linear", entityId: "SBX-1", triggerType: "issue.delegate", repo: "sandbox", holdUntil: 10_000 });
  const linear = { ...fakeLinear, blockedBy: async (id: string) => ({ issueId: `uuid-${id}`, blockers: [] }) } as any;

  assert.equal(store.claimNext("w"), undefined, "held until discovery runs");
  await discoverDependencies({ config, store, linear });
  assert.equal(store.claimNext("w")!.entityId, "SBX-1", "hold released — nothing to sequence on");
});

test("discovery: keeps the hold when a blocker exists in Linear but isn't tracked by Milo yet", async () => {
  const store = freshStore();
  // Only the DEPENDENT has arrived (webhook ordering: dependent's delivery beat the blocker's).
  store.enqueue({ source: "linear", entityId: "SBX-B", triggerType: "issue.delegate", repo: "sandbox", holdUntil: 10_000 });
  const linear = {
    ...fakeLinear,
    blockedBy: async (id: string) =>
      id === "SBX-B"
        ? { issueId: "uuid-SBX-B", blockers: [{ identifier: "SBX-A", stateType: "unstarted" }] }
        : { issueId: `uuid-${id}`, blockers: [] },
  } as any;

  await discoverDependencies({ config, store, linear });
  assert.equal(store.hasDependency("SBX-B", "SBX-A"), false, "no edge — blocker untracked");
  assert.equal(store.claimNext("w"), undefined, "hold kept: the blocker's own webhook may be moments away");
});

test("discovery: a Linear outage leaves the hold to expire into parallel (never deadlocks)", async () => {
  const store = freshStore();
  store.enqueue({ source: "linear", entityId: "SBX-1", triggerType: "issue.delegate", repo: "sandbox", holdUntil: 50 });
  const linear = { ...fakeLinear, blockedBy: async () => { throw new Error("503"); } } as any;

  await discoverDependencies({ config, store, linear });
  assert.equal(store.claimNext("w"), undefined, "still held — discovery couldn't run");
  // The store's test clock advances one tick per now() call (claimNext calls it once per attempt) —
  // keep trying until the hold expiry (t=50) passes; well before 100 ticks the job must come free.
  let claimed;
  for (let i = 0; i < 100 && !claimed; i++) claimed = store.claimNext("w");
  assert.ok(claimed, "hold expired → parallel fallback");
});

test("webhook ordering race regression (MILO-15): dependent delivered before its blocker still sequences", async () => {
  const store = freshStore();
  const linear = {
    ...fakeLinear,
    blockedBy: async (id: string) =>
      id === "SBX-B"
        ? { issueId: "uuid-SBX-B", blockers: [{ identifier: "SBX-A", stateType: "unstarted" }] }
        : { issueId: `uuid-${id}`, blockers: [] },
  } as any;
  const deps = { config, store, linear };

  // Webhook 1: the DEPENDENT lands first and triggers a sync.
  store.enqueue({ source: "linear", entityId: "SBX-B", triggerType: "issue.delegate", repo: "sandbox", holdUntil: 10_000 });
  await syncDependencies(deps);
  assert.equal(store.claimNext("w"), undefined, "dependent held — blocker not yet tracked");

  // Webhook 2: the BLOCKER lands moments later and triggers another sync.
  store.enqueue({ source: "linear", entityId: "SBX-A", triggerType: "issue.delegate", repo: "sandbox", holdUntil: 10_000 });
  await syncDependencies(deps);

  assert.equal(store.hasDependency("SBX-B", "SBX-A"), true, "edge recorded once both are tracked");
  const first = store.claimNext("w");
  assert.equal(first!.entityId, "SBX-A", "blocker runs first");
  assert.equal(store.claimNext("w"), undefined, "dependent stays gated by the edge while the blocker is active");

  // Blocker finishes (stacked default in this config is 'wait'; use a discovery-done blocker so it
  // resolves without a PR) → reconcile lifts the gate → dependent claimable.
  store.transition(first!.id, "discovery-done");
  await reconcileDependencies(deps);
  assert.equal(store.claimNext("w")!.entityId, "SBX-B", "dependent claimable after the blocker completes");
});
