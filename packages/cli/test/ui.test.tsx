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

test("TUI renders the header and job rows (default jobs view)", async () => {
  const { lastFrame, unmount } = render(<App store={storeWithJobs()} />);
  await delay(60);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /milo/, "shows the milo header");
  assert.match(frame, /SBX-7/, "shows an enqueued/running job");
  assert.match(frame, /SBX-8/, "shows a second job");
  assert.match(frame, /running/, "renders job state");
  assert.match(frame, /views · q quit/, "shows the jobs footer hints");
});

test("pressing 2 switches to the Scheduled view", async () => {
  const schedules = [{ name: "maintenance", cron: "0 */6 * * *", kind: "maintenance", enabled: true }];
  const { lastFrame, stdin, unmount } = render(<App store={storeWithJobs()} schedules={schedules} />);
  await delay(40);
  stdin.write("2");
  await delay(60);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /Scheduled/, "shows the Scheduled heading");
  assert.match(frame, /maintenance/, "lists the maintenance schedule");
});

test("Enter drills into a job's detail view", async () => {
  const { lastFrame, stdin, unmount } = render(<App store={storeWithJobs()} />);
  await delay(40);
  stdin.write("\r"); // Enter on the selected (newest) job
  await delay(60);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /events:/, "the detail view lists events");
  assert.match(frame, /attempt 0\/3/, "shows attempt count");
});

test("t opens the transcript view", async () => {
  const { lastFrame, stdin, unmount } = render(<App store={storeWithJobs()} />);
  await delay(40);
  stdin.write("t");
  await delay(60);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /transcript/, "shows the transcript view");
});

test("system view renders via key 3", async () => {
  const { lastFrame, stdin, unmount } = render(<App store={storeWithJobs()} />);
  await delay(40);
  stdin.write("3");
  await delay(60);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /System/, "shows the system view heading");
  assert.match(frame, /doctor/, "lists the doctor section");
});
