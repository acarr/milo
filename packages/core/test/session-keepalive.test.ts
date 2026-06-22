import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-keepalive-"));
import { openDatabase, JobStore } from "@milo/core";
import { withSetupKeepalive } from "../src/pipeline.js";

const freshStore = () => new JobStore(openDatabase(join(mkdtempSync(join(os.tmpdir(), "milo-ka-")), "milo.db")));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- store.willQueue (gates the "queued" ack) ----

test("willQueue is false when a slot is free and the entity is idle (→ starts now, no queued ack)", () => {
  const store = freshStore();
  store.enqueue({ source: "linear", entityId: "SBX-1", triggerType: "issue.delegate", repo: "r" });
  // 1 non-terminal job, cap 3 → nothing ahead → won't wait.
  assert.equal(store.willQueue("SBX-1", 3), false);
});

test("willQueue is true once `concurrency` other jobs are already ahead (cap full → queued ack)", () => {
  const store = freshStore();
  for (const id of ["SBX-1", "SBX-2", "SBX-3", "SBX-4"]) {
    store.enqueue({ source: "linear", entityId: id, triggerType: "issue.delegate", repo: "r" });
  }
  // 4 non-terminal, the 4th has 3 ahead → waits at cap 3, but not at cap 4.
  assert.equal(store.willQueue("SBX-4", 3), true);
  assert.equal(store.willQueue("SBX-4", 4), false);
});

test("willQueue is true when the same entity is already actively running (serialization wait)", () => {
  const store = freshStore();
  store.enqueue({ source: "linear", entityId: "SBX-1", triggerType: "issue.delegate", repo: "r" });
  store.claimNext("w"); // SBX-1 → claimed (active)
  // Even with the cap nowhere near full, a re-delegation of SBX-1 must wait behind the active run.
  assert.equal(store.willQueue("SBX-1", 10), true);
  // A different idle entity with a free slot does NOT wait.
  assert.equal(store.willQueue("SBX-2", 10), false);
});

// ---- withSetupKeepalive (keeps the session alive during long setup) ----

test("withSetupKeepalive posts nothing for a fast setup", async () => {
  let posts = 0;
  const result = await withSetupKeepalive(() => posts++, async () => "done", 1000);
  assert.equal(result, "done");
  assert.equal(posts, 0); // setup finished long before the first 1000ms tick
});

test("withSetupKeepalive posts periodically during a slow setup, then stops", async () => {
  let posts = 0;
  await withSetupKeepalive(() => posts++, async () => await delay(130), 30);
  assert.ok(posts >= 1, `expected ≥1 keepalive during a slow setup, got ${posts}`);
  const settled = posts;
  await delay(100);
  assert.equal(posts, settled, "interval must be cleared once setup resolves");
});

test("withSetupKeepalive is a transparent no-op when post is undefined", async () => {
  const result = await withSetupKeepalive(undefined, async () => 42, 5);
  assert.equal(result, 42);
});
