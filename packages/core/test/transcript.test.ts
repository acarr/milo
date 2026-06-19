import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// logsDir() reads MILO_HOME at call time — point it at a throwaway dir.
process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-tx-"));

import { makeEventFileSink, readEvents, tailEvents } from "@milo/core";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("sink persists redacted events; readEvents replays them", async () => {
  let t = 1000;
  const { sink, close } = makeEventFileSink("job-A", () => t++);
  sink({ kind: "narration", text: "starting work" });
  sink({ kind: "tool", tool: "Bash", text: "git push https://x:ghp_ABCDEFGHIJKLMNOPQRSTUVWX@github.com" });
  sink({ kind: "file-change", tool: "Edit", text: "edited src/index.ts" });
  close();
  await delay(50); // let the buffered write stream flush

  const events = readEvents("job-A");
  assert.equal(events.length, 3);
  assert.equal(events[0]!.kind, "narration");
  assert.equal(events[0]!.at, 1000);
  assert.equal(events[1]!.tool, "Bash");
  assert.match(events[1]!.text, /«redacted»/, "the token is redacted");
  assert.doesNotMatch(events[1]!.text, /ghp_/, "no raw token leaks");
  assert.equal(events[2]!.kind, "file-change");
});

test("readEvents returns [] for a job with no transcript", () => {
  assert.deepEqual(readEvents("never-ran"), []);
});

test("tailEvents replays existing events then streams appends", async () => {
  let t = 2000;
  const { sink, close } = makeEventFileSink("job-B", () => t++);
  sink({ kind: "narration", text: "first" });
  await delay(40); // flush the initial line before tailing

  const seen: string[] = [];
  const stop = tailEvents("job-B", (e) => seen.push(e.text), 40);
  await delay(120); // initial replay + a couple of polls

  sink({ kind: "narration", text: "second" });
  await delay(160); // a few more polls pick up the append

  stop();
  close();
  assert.deepEqual(seen, ["first", "second"]);
});
