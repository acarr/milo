import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude } from "../src/claude.js";

/**
 * Run-guard tests (MILO-16) drive the real runClaude against fake "claude" binaries that reproduce
 * the pathologies seen live: a CLI that finishes its work but never exits (MCP children holding it
 * open), and a CLI that goes silent. The `bin` option is the test seam; guard timeouts are tiny so
 * the suite stays fast.
 */

function fakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

/** A stream-json result line like claude -p emits, carrying a MILO_RESULT for the parser. */
const RESULT_LINE = JSON.stringify({
  type: "result",
  result: 'Done. MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"x"}',
});

test("guard: resolves soon after the result event even if the process never exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-guards-"));
  // Emits its result, then hangs forever — the exact live failure mode (hung MCP children).
  const bin = fakeBin(dir, "claude-hangs-after-result", `
    console.log(${JSON.stringify(RESULT_LINE)});
    setInterval(() => {}, 1000); // never exit
  `);

  const started = Date.now();
  const run = await runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    guards: { resultExitGraceMs: 250, inactivityMs: 30_000, maxRunMs: 30_000 },
  });

  assert.ok(Date.now() - started < 15_000, "resolved without waiting for process exit");
  assert.equal(run.code, 0, "a post-result guard kill still counts as a successful run");
  assert.match(run.output, /MILO_RESULT/, "the result text was captured before the kill");
  rmSync(dir, { recursive: true, force: true });
});

test("guard: kills a runner that goes silent (inactivity timeout)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-guards-"));
  // Prints nothing, never exits — a wedged CLI.
  const bin = fakeBin(dir, "claude-silent", `setInterval(() => {}, 1000);`);

  const started = Date.now();
  const run = await runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    guards: { resultExitGraceMs: 30_000, inactivityMs: 300, maxRunMs: 30_000 },
  });

  assert.ok(Date.now() - started < 15_000, "did not hang on a silent runner");
  assert.notEqual(run.code, 0, "a kill without a result is not a success (verification gate decides)");
  rmSync(dir, { recursive: true, force: true });
});

test("guard: enforces the wall-clock cap on a runner that streams forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-guards-"));
  // Keeps chattering (so inactivity never fires) but never finishes.
  const bin = fakeBin(dir, "claude-chatty", `
    setInterval(() => console.log(JSON.stringify({ type: "system", msg: "still going" })), 100);
  `);

  const started = Date.now();
  const run = await runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    guards: { resultExitGraceMs: 30_000, inactivityMs: 30_000, maxRunMs: 600 },
  });

  assert.ok(Date.now() - started < 15_000, "wall-clock cap fired");
  assert.notEqual(run.code, 0, "an over-cap kill is not a success");
  rmSync(dir, { recursive: true, force: true });
});

test("guard: a clean run that exits on its own is untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-guards-"));
  const bin = fakeBin(dir, "claude-clean", `
    console.log(${JSON.stringify(RESULT_LINE)});
    process.exit(0);
  `);

  const run = await runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    guards: { resultExitGraceMs: 5_000, inactivityMs: 30_000, maxRunMs: 30_000 },
  });

  assert.equal(run.code, 0);
  assert.match(run.output, /MILO_RESULT/);
  rmSync(dir, { recursive: true, force: true });
});
