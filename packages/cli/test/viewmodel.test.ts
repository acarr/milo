import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// Isolate the store in a temp MILO_HOME (read at openDatabase() call time, not import time).
process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-vm-test-"));

import { openDatabase, JobStore } from "@milo/core";
import { createClient } from "../src/viewmodel.js";

function seed(): JobStore {
  const store = new JobStore(openDatabase());
  const a = store.enqueue({ source: "cli", entityId: "SBX-1", triggerType: "issue.start", repo: "sandbox", runner: "claude" });
  store.transition(a.job.id, "running", { runner: "claude" });
  store.enqueue({ source: "linear", entityId: "SBX-2", triggerType: "issue.start", repo: "sandbox", runner: "codex" });
  const c = store.enqueue({ source: "github", entityId: "milo#9", triggerType: "pr.review", repo: "milo", runner: "claude" });
  store.transition(c.job.id, "done", { pr_url: "https://example.com/pr/9", runner: "claude" });
  return store;
}

test("jobs(): no filter returns all rows newest-first as denormalized JobRows", () => {
  const client = createClient({ store: seed() });
  const rows = client.jobs();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.ref).sort(), ["SBX-1", "SBX-2", "milo#9"]);
  const done = rows.find((r) => r.ref === "milo#9")!;
  assert.equal(done.state, "done");
  assert.equal(done.detail, "https://example.com/pr/9"); // detail prefers prUrl
});

test("jobs(): pseudo-state, repo, source, runner, and search filters", () => {
  const client = createClient({ store: seed() });
  assert.equal(client.jobs({ state: "active" }).length, 1); // only SBX-1 (running)
  assert.equal(client.jobs({ state: "terminal" }).length, 1); // only milo#9 (done)
  assert.equal(client.jobs({ repo: "milo" }).length, 1);
  assert.equal(client.jobs({ source: "linear" })[0]!.ref, "SBX-2");
  assert.equal(client.jobs({ runner: "codex" })[0]!.ref, "SBX-2");
  assert.equal(client.jobs({ search: "MILO" }).length, 1); // case-insensitive over ref
  assert.equal(client.jobs({ limit: 1 }).length, 1);
});

test("job(): bundles the job, its events, and dependencies", () => {
  const store = seed();
  const client = createClient({ store });
  const sbx1 = store.list({ limit: 100 }).find((j) => j.entityId === "SBX-1")!;
  const detail = client.job(sbx1.id);
  assert.ok(detail);
  assert.equal(detail!.job.entityId, "SBX-1");
  assert.ok(detail!.events.length >= 2); // queued + running transitions
  assert.deepEqual(detail!.dependencies, []);
  assert.equal(client.job("does-not-exist"), undefined);
});

test("resolveJob(): finds by job id or by latest entity ref", () => {
  const store = seed();
  const client = createClient({ store });
  const sbx2 = store.list({ limit: 100 }).find((j) => j.entityId === "SBX-2")!;
  assert.equal(client.resolveJob(sbx2.id)!.id, sbx2.id);
  assert.equal(client.resolveJob("SBX-2")!.entityId, "SBX-2");
  assert.equal(client.resolveJob("nope"), undefined);
});

test("daemon(): reports counts by state", () => {
  const client = createClient({ store: seed() });
  const d = client.daemon();
  assert.equal(d.counts["running"], 1);
  assert.equal(d.counts["done"], 1);
  assert.equal(typeof d.running, "boolean");
});

test("cancel(): queued → cancelled, active → cancel-requested, terminal → error", () => {
  const s = seed();
  const client = createClient({ store: s });
  const list = s.list({ limit: 100 });
  const running = list.find((j) => j.entityId === "SBX-1")!;
  const queued = list.find((j) => j.entityId === "SBX-2")!;
  const done = list.find((j) => j.entityId === "milo#9")!;

  const r1 = client.cancel(queued.id);
  assert.deepEqual(r1, { ok: true, value: "cancelled" });
  assert.equal(s.get(queued.id)!.state, "cancelled");

  const r2 = client.cancel(running.id);
  assert.deepEqual(r2, { ok: true, value: "cancel-requested" });
  assert.equal(s.isCancelRequested(running.id), true);

  const r3 = client.cancel(done.id);
  assert.equal(r3.ok, false);
});

test("rerun()/retry() surface store errors as ActionResult", () => {
  const client = createClient({ store: seed() });
  assert.equal(client.rerun("missing").ok, false);
  assert.equal(client.retry("missing").ok, false);
});
