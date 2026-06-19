import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogs, pruneWorktrees } from "@milo/core";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "milo-maint-"));
}

test("rotateLogs deletes logs older than the cutoff, keeps recent ones", () => {
  const dir = tmp();
  const old = join(dir, "old.log");
  const fresh = join(dir, "fresh.log");
  writeFileSync(old, "x");
  writeFileSync(fresh, "y");
  const longAgo = Date.now() / 1000 - 30 * 86_400; // 30 days ago, in seconds
  utimesSync(old, longAgo, longAgo);

  const deleted = rotateLogs(dir, 14);
  assert.equal(deleted, 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("rotateLogs ignores non-.log files", () => {
  const dir = tmp();
  const keep = join(dir, "notes.txt");
  writeFileSync(keep, "z");
  const longAgo = Date.now() / 1000 - 30 * 86_400;
  utimesSync(keep, longAgo, longAgo);
  assert.equal(rotateLogs(dir, 14), 0);
  assert.equal(existsSync(keep), true);
});

test("pruneWorktrees removes stale, non-active dirs and spares active/recent ones", () => {
  const base = tmp();
  const stale = join(base, "SBX-stale");
  const active = join(base, "SBX-active");
  const recent = join(base, "SBX-recent");
  for (const d of [stale, active, recent]) mkdirSync(d);
  const old = Date.now() / 1000 - 10 * 3600; // 10h ago
  utimesSync(stale, old, old);
  utimesSync(active, old, old); // old but active → spared

  const removed = pruneWorktrees(base, new Set([active]), 6 * 3600_000);
  assert.deepEqual(removed, [stale]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(active), true); // active path spared
  assert.equal(existsSync(recent), true); // too recent (just created) spared
});
