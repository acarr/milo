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
