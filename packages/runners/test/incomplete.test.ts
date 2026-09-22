import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude } from "../src/claude.js";

/**
 * A runner must say outright when its run did not finish.
 *
 * The exit code can't carry this: `claude -p` emits a terminal `result` event with `is_error:true`
 * when the API connection drops mid-response, and the CLI can still exit 0. On 2026-08-07 WAZ-1150
 * died that way at turn 140; the verification gate saw only `code === 0`, committed the
 * half-written worktree, opened PR #707, and marked the job done. `errorDetail` is the signal the
 * gate needs to draft that PR and flag the job instead.
 */

function fakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

const run = (dir: string, bin: string) =>
  runClaude({
    cwd: dir,
    prompt: "irrelevant",
    model: "opus",
    logFile: join(dir, "run.log"),
    bin,
    guards: { resultExitGraceMs: 250, inactivityMs: 1_500, maxRunMs: 5_000 },
  });

test("an is_error result is reported as errorDetail even when the CLI exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-incomplete-"));
  // The exact live shape: a synthetic API-error result, then a clean exit.
  const line = JSON.stringify({
    type: "result",
    is_error: true,
    subtype: "success",
    terminal_reason: "api_error",
    result: "API Error: Connection closed mid-response. The response above may be incomplete.",
  });
  const bin = fakeBin(dir, "claude-api-error", `console.log(${JSON.stringify(line)}); process.exit(0);`);

  const r = await run(dir, bin);
  assert.equal(r.code, 0, "the CLI really did exit 0 — which is why the exit code can't be trusted alone");
  assert.match(r.errorDetail ?? "", /Connection closed mid-response/);
  rmSync(dir, { recursive: true, force: true });
});

test("a clean run reports no errorDetail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-incomplete-"));
  const line = JSON.stringify({
    type: "result",
    is_error: false,
    result: 'Done. MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"ok"}',
  });
  const bin = fakeBin(dir, "claude-ok", `console.log(${JSON.stringify(line)}); process.exit(0);`);

  const r = await run(dir, bin);
  assert.equal(r.code, 0);
  assert.equal(r.errorDetail, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("a guard kill BEFORE any result is reported as an abandoned run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-incomplete-"));
  const bin = fakeBin(dir, "claude-silent", `setInterval(() => {}, 1000);`); // never speaks, never exits

  const r = await run(dir, bin);
  assert.notEqual(r.code, 0);
  assert.match(r.errorDetail ?? "", /killed/);
  assert.match(r.errorDetail ?? "", /inactivity/);
  rmSync(dir, { recursive: true, force: true });
});

test("a guard kill AFTER the result is not an error — the work was already done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-incomplete-"));
  const line = JSON.stringify({
    type: "result",
    is_error: false,
    result: 'MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"ok"}',
  });
  // Emits its result then hangs — the MCP-children pathology the guards exist for.
  const bin = fakeBin(dir, "claude-hangs", `console.log(${JSON.stringify(line)}); setInterval(() => {}, 1000);`);

  const r = await run(dir, bin);
  assert.equal(r.code, 0, "a post-result guard kill still counts as success");
  assert.equal(r.errorDetail, undefined, "and must not be flagged as an unfinished run");
  rmSync(dir, { recursive: true, force: true });
});

/**
 * External kills: who killed the runner, and can Milo tell?
 *
 * Node reports a signalled child as `(code=null, signal="SIGTERM")`. Every `close` handler used to
 * bind only `code`, so that collapsed to a bare `1` and the signal was discarded. Five wazzon runs
 * died with `exit 143` across two months — SIGTERM caught by claude's own handler, sent by a repo
 * cleanup script's `pkill -f "<worktree path>"` — and Milo could only say "the runner exited 143".
 */

test("a post-result guard kill reports NO signal — it is still a success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-signal-"));
  const line = JSON.stringify({
    type: "result",
    is_error: false,
    result: 'MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"ok"}',
  });
  const bin = fakeBin(dir, "claude-hangs-sig", `console.log(${JSON.stringify(line)}); setInterval(() => {}, 1000);`);

  const r = await run(dir, bin);
  // The guard kills this with SIGTERM, so Node DOES see a signal. Reporting it would make
  // runIncomplete flip every post-result guard kill to needs-attention. `signal` must mirror
  // whatever `code` does — both suppressed under completedBeforeKill.
  assert.equal(r.code, 0);
  assert.equal(r.signal, null, "a guard kill after the result must not look like an external kill");
  assert.equal(r.errorDetail, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("a runner killed by an outside signal reports that signal, with no errorDetail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-signal-"));
  // Stands in for a stray `pkill -f`: the process is signalled mid-run, before any result.
  const bin = fakeBin(dir, "claude-signalled", `setTimeout(() => process.kill(process.pid, "SIGTERM"), 50); setInterval(() => {}, 1000);`);

  const r = await run(dir, bin);
  assert.equal(r.signal, "SIGTERM");
  assert.equal(r.code, 1, "Node reports code=null for a signal death; the runner still normalizes to 1");
  assert.equal(r.errorDetail, undefined, "no guard fired — so the kill came from outside Milo");
  rmSync(dir, { recursive: true, force: true });
});

test("a runner that exits 143 under its own power is NOT reported as signalled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-signal-"));
  // What `claude` actually does: it catches SIGTERM and exits 128+15 itself. At this layer that is
  // indistinguishable from a deliberate `exit 143`, so the inference stays out of the result type.
  const bin = fakeBin(dir, "claude-143", `process.exit(143);`);

  const r = await run(dir, bin);
  assert.equal(r.code, 143);
  assert.equal(r.signal, null);
  rmSync(dir, { recursive: true, force: true });
});
