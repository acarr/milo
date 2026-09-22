import { test } from "node:test";
import assert from "node:assert/strict";
import { likelySignal } from "../src/proc.js";
import { runIncomplete } from "../src/pipeline.js";

/**
 * Milo was structurally blind to an external kill: every `close` handler bound only `code`, and a
 * signalled child reports `(code=null, signal="SIGTERM")`, so `code ?? 1` threw the signal away.
 * Five wazzon runs died as `exit 143` across two months with nothing saying a signal was involved.
 */

test("likelySignal reads both shapes of a signal death", () => {
  assert.equal(likelySignal(null, "SIGTERM"), "SIGTERM", "Node saw the signal directly");
  // What `claude` actually does: catch SIGTERM, exit 128+15 under its own power.
  assert.equal(likelySignal(143, null), "SIGTERM");
  assert.equal(likelySignal(137, null), "SIGKILL");
  assert.equal(likelySignal(130, null), "SIGINT");
  // An explicit signal always wins over the exit-code inference.
  assert.equal(likelySignal(143, "SIGKILL"), "SIGKILL");
});

test("likelySignal stays quiet for ordinary exits", () => {
  assert.equal(likelySignal(0, null), null);
  assert.equal(likelySignal(1, null), null);
  assert.equal(likelySignal(128, null), null, "128 itself is not 128+N");
  assert.equal(likelySignal(160, null), null, "out of signal range");
  assert.equal(likelySignal(144, null), null, "no signal 16 worth naming");
});

test("runIncomplete names an external signal, and keeps Milo's own reasons first", () => {
  // A guard kill always sets errorDetail, and it wins — so a guard's SIGTERM never reads "external".
  assert.deepEqual(
    runIncomplete({ code: 1, signal: "SIGTERM", errorDetail: "runner was killed: inactivity timeout" }),
    { reason: "runner was killed: inactivity timeout" },
  );
  // A bare signal with no errorDetail is someone else on the box.
  assert.deepEqual(runIncomplete({ code: 1, signal: "SIGTERM" }), {
    reason: "the runner was killed by SIGTERM (external)",
  });
  // A genuine exit 143 still reads as an exit code: the 128+N inference is diagnostics-only and
  // must never reach this string.
  assert.deepEqual(runIncomplete({ code: 143, signal: null }), { reason: "the runner exited 143" });
  assert.equal(runIncomplete({ code: 0, signal: null }), undefined);
  assert.equal(runIncomplete({ code: 0 }), undefined, "a runner that can't observe signals is unaffected");
});
