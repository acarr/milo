import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ProgressStreamer,
  sanitize,
  shouldPost,
  summarize,
  buildActivity,
  type ProgressPoster,
  type RunnerEvent,
} from "@milo/core";

function recordingPoster() {
  const calls: { type: "thought" | "action"; a: string; b?: string }[] = [];
  const poster: ProgressPoster & { calls: typeof calls; failNext: boolean } = {
    calls,
    failNext: false,
    async thought(body: string) {
      calls.push({ type: "thought", a: body });
      if (poster.failNext) return false;
      return true;
    },
    async action(action: string, parameter: string) {
      calls.push({ type: "action", a: action, b: parameter });
      if (poster.failNext) return false;
      return true;
    },
  };
  return poster;
}

test("sanitize collapses whitespace, redacts secrets, and bounds length", () => {
  assert.equal(sanitize("a   b\n c"), "a b c");
  assert.match(sanitize("token lin_oauth_ABC123def456"), /«redacted»/);
  assert.match(sanitize("ghp_0123456789012345678901234567890123"), /«redacted»/);
  const long = sanitize("x".repeat(500), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("…"));
});

test("shouldPost filters by signal + verbosity", () => {
  const read: RunnerEvent = { kind: "tool", tool: "Read", text: "Read a.ts" };
  const edit: RunnerEvent = { kind: "file-change", tool: "Edit", text: "Edit a.ts" };
  const bash: RunnerEvent = { kind: "tool", tool: "Bash", text: "$ ls" };
  const testCmd: RunnerEvent = { kind: "tool", tool: "Bash", text: "$ pnpm test" };
  const narr: RunnerEvent = { kind: "narration", text: "Now implementing the endpoint handler" };
  const filler: RunnerEvent = { kind: "narration", text: "ok" };

  // file-change always surfaces; low-signal reads only in verbose
  assert.equal(shouldPost(edit, "normal"), true);
  assert.equal(shouldPost(read, "normal"), false);
  assert.equal(shouldPost(read, "verbose"), true);

  // quiet only surfaces milestone-ish commands / narration
  assert.equal(shouldPost(bash, "quiet"), false);
  assert.equal(shouldPost(testCmd, "quiet"), true);
  assert.equal(shouldPost(bash, "normal"), true);

  // terse filler narration is dropped
  assert.equal(shouldPost(narr, "normal"), true);
  assert.equal(shouldPost(filler, "normal"), false);
});

test("buildActivity: single event maps to its natural activity; a burst coalesces to a thought", () => {
  const one = buildActivity([{ kind: "file-change", tool: "Edit", text: "Edit src/a.ts" }]);
  assert.deepEqual(one, { type: "action", action: "Edit", parameter: "Edit src/a.ts" });

  const narr = buildActivity([{ kind: "narration", text: "Writing the tests" }]);
  assert.deepEqual(narr, { type: "thought", body: "Writing the tests" });

  const burst = buildActivity([
    { kind: "file-change", tool: "Edit", text: "Edit a.ts" },
    { kind: "file-change", tool: "Write", text: "Write b.ts" },
    { kind: "tool", tool: "Bash", text: "$ pnpm test" },
  ]);
  assert.equal(burst.type, "thought");
});

test("summarize counts files and steps and leads with the latest narration", () => {
  const s = summarize([
    { kind: "narration", text: "Wiring up the route" },
    { kind: "file-change", tool: "Edit", text: "Edit a.ts" },
    { kind: "file-change", tool: "Edit", text: "Edit b.ts" },
    { kind: "tool", tool: "Bash", text: "$ pnpm test" },
  ]);
  assert.match(s, /Wiring up the route/);
  assert.match(s, /edited 2 files/);
  assert.match(s, /ran 1 step/);
});

test("streamer posts the first event immediately, coalesces the rest within the interval", async () => {
  let t = 1_000_000;
  const poster = recordingPoster();
  const s = new ProgressStreamer(poster, { minIntervalMs: 60_000, now: () => t });

  s.handle({ kind: "file-change", tool: "Edit", text: "Edit a.ts" }); // immediate
  await s.settled();
  assert.equal(poster.calls.length, 1);
  assert.deepEqual(poster.calls[0], { type: "action", a: "Edit", b: "Edit a.ts" });

  // Two more inside the window get buffered, not posted.
  s.handle({ kind: "file-change", tool: "Write", text: "Write b.ts" });
  s.handle({ kind: "tool", tool: "Bash", text: "$ pnpm test" });
  assert.equal(poster.calls.length, 1);

  // stop() flushes the pending burst as a single coalesced thought.
  await s.stop();
  assert.equal(poster.calls.length, 2);
  assert.equal(poster.calls[1]!.type, "thought");
});

test("streamer drops filtered noise and never throws on poster failure", async () => {
  let t = 1_000_000;
  const poster = recordingPoster();
  poster.failNext = true;
  const s = new ProgressStreamer(poster, { minIntervalMs: 1_000, now: () => t });

  s.handle({ kind: "tool", tool: "Read", text: "Read a.ts" }); // filtered out (normal verbosity)
  assert.equal(poster.calls.length, 0);

  s.handle({ kind: "file-change", tool: "Edit", text: "Edit a.ts" }); // posts, but fails
  await s.settled();
  assert.equal(poster.calls.length, 1);
  // A failed post backs the cadence off (likely a Linear rate limit).
  assert.ok(s.currentIntervalMs > 1_000);

  await s.stop(); // must not throw
});

test("disabled streamer posts nothing", async () => {
  const poster = recordingPoster();
  const s = new ProgressStreamer(poster, { enabled: false });
  s.handle({ kind: "file-change", tool: "Edit", text: "Edit a.ts" });
  await s.stop();
  assert.equal(poster.calls.length, 0);
});
