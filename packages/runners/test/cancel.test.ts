import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude } from "../src/claude.js";

/** Cancel = an AbortSignal that kills the detached runner tree (the mechanism `milo cancel` drives). */

function fakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

test("an aborted signal kills the runner promptly and resolves non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-cancel-"));
  // A runner that would otherwise run forever (no result, never exits).
  const bin = fakeBin(dir, "claude-forever", `setInterval(() => {}, 1000);`);

  const ctrl = new AbortController();
  const started = Date.now();
  const t = setTimeout(() => ctrl.abort(), 200);

  const run = await runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    signal: ctrl.signal,
    // Generous guards so it's the ABORT (not a guard) that ends the run.
    guards: { resultExitGraceMs: 30_000, inactivityMs: 30_000, maxRunMs: 30_000 },
  });

  clearTimeout(t);
  assert.ok(Date.now() - started < 10_000, "the abort killed the runner promptly");
  assert.notEqual(run.code, 0, "a cancelled run is not a success (the pipeline skips the gate anyway)");
  rmSync(dir, { recursive: true, force: true });
});

test("an already-aborted signal kills before any work happens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-cancel-"));
  const bin = fakeBin(dir, "claude-forever2", `setInterval(() => {}, 1000);`);
  const ctrl = new AbortController();
  ctrl.abort(); // pre-aborted (cancel requested during setup)

  const started = Date.now();
  const run = await runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    signal: ctrl.signal,
    guards: { resultExitGraceMs: 30_000, inactivityMs: 30_000, maxRunMs: 30_000 },
  });

  assert.ok(Date.now() - started < 10_000, "killed immediately");
  assert.notEqual(run.code, 0);
  rmSync(dir, { recursive: true, force: true });
});
