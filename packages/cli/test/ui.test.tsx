import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// Isolate the store in a temp MILO_HOME (read at openDatabase() call time, not import time).
process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-test-"));

import { render } from "ink-testing-library";
import { openDatabase, JobStore } from "@milo/core";
import { App } from "../src/ui.js";

function storeWithJobs(): JobStore {
  const store = new JobStore(openDatabase());
  const a = store.enqueue({ source: "cli", entityId: "SBX-7", triggerType: "issue.start", repo: "milo-sandbox" });
  store.transition(a.job.id, "running", { runner: "claude" });
  store.enqueue({ source: "cli", entityId: "SBX-8", triggerType: "issue.start", repo: "milo-sandbox" });
  return store;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("TUI renders the header and job rows without a TTY", async () => {
  const { lastFrame, unmount } = render(<App store={storeWithJobs()} />);
  await delay(60); // allow the first poll tick + effects
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /milo/, "shows the milo header");
  assert.match(frame, /SBX-7/, "shows an enqueued/running job");
  assert.match(frame, /SBX-8/, "shows a second job");
  assert.match(frame, /running/, "renders job state");
});

test("TUI renders the Scheduled panel when schedules are provided", async () => {
  const schedules = [{ name: "maintenance", cron: "0 */6 * * *", kind: "maintenance", enabled: true }];
  const { lastFrame, unmount } = render(<App store={storeWithJobs()} schedules={schedules} />);
  await delay(60);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /Scheduled/, "shows the Scheduled heading");
  assert.match(frame, /maintenance/, "lists the maintenance schedule");
});
