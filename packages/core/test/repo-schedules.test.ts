import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MiloConfigSchema,
  discoverRepoSchedules,
  loadSchedulePrompt,
  resolvePromptScheduleJob,
  JobStore,
  openDatabase,
  type MiloConfig,
} from "@milo/core";

/** A temp repo with a `.milo/` holding the given schedules.json + prompt files. */
function makeRepo(schedulesJson: string | null, mdFiles: Record<string, string> = {}): { config: MiloConfig; repoDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "milo-sched-"));
  mkdirSync(join(repoDir, ".milo"), { recursive: true });
  if (schedulesJson !== null) writeFileSync(join(repoDir, ".milo", "schedules.json"), schedulesJson);
  for (const [name, body] of Object.entries(mdFiles)) writeFileSync(join(repoDir, ".milo", name), body);
  const config = MiloConfigSchema.parse({
    version: 2,
    repositories: [{ name: "demo", path: repoDir, baseBranch: "main", teamKeys: ["DEMO"], packageManager: "pnpm" }],
  });
  return { config, repoDir };
}

test("discoverRepoSchedules parses in-repo schedules.json into namespaced prompt defs", () => {
  const { config } = makeRepo(
    JSON.stringify([{ name: "nightly", cron: "0 22 * * *", runner: "codex", promptFile: "nightly.md" }]),
    { "nightly.md": "hello from md" },
  );
  const defs = discoverRepoSchedules(config);
  assert.equal(defs.length, 1);
  assert.equal(defs[0]!.name, "demo:nightly");
  assert.equal(defs[0]!.enabled, true);
  const intent = defs[0]!.intent as Record<string, unknown>;
  assert.equal(intent["kind"], "prompt");
  assert.equal(intent["repo"], "demo");
  assert.equal(intent["runner"], "codex");
  assert.equal(intent["promptFile"], "nightly.md");
});

test("discoverRepoSchedules skips a malformed file (and a bad cron) without throwing", () => {
  const bad = makeRepo("{ not valid json");
  assert.deepEqual(discoverRepoSchedules(bad.config), []);

  const badCron = makeRepo(JSON.stringify([{ name: "x", cron: "nope", promptFile: "x.md" }]), { "x.md": "hi" });
  assert.deepEqual(discoverRepoSchedules(badCron.config), []);

  const noFile = makeRepo(null);
  assert.deepEqual(discoverRepoSchedules(noFile.config), []);
});

test("loadSchedulePrompt reads the .md under <repo>/.milo/", () => {
  const { config } = makeRepo(JSON.stringify([{ name: "n", cron: "0 22 * * *", promptFile: "n.md" }]), {
    "n.md": "  the instruction  ",
  });
  const text = loadSchedulePrompt({ promptFile: "n.md" }, config.repositories[0]!);
  assert.equal(text, "the instruction"); // trimmed
});

test("loadSchedulePrompt throws when the file is missing", () => {
  const { config } = makeRepo(null);
  assert.throws(() => loadSchedulePrompt({ promptFile: "absent.md" }, config.repositories[0]!), /not found/);
});

test("resolvePromptScheduleJob builds a source:prompt NewJob carrying the md text", () => {
  const { config } = makeRepo(
    JSON.stringify([{ name: "nightly", cron: "0 22 * * *", runner: "codex", promptFile: "nightly.md" }]),
    { "nightly.md": "tidy the TODOs" },
  );
  const def = discoverRepoSchedules(config)[0]!;
  const job = resolvePromptScheduleJob(config, def);
  assert.equal(job.source, "prompt");
  assert.equal(job.repo, "demo");
  assert.equal(job.runner, "codex");
  assert.equal(job.customPrompt, "tidy the TODOs");
  assert.equal(job.entityId, "prompt-demo-nightly");
  assert.equal(job.entityRef, "demo:nightly");
  assert.equal(job.triggerType, "scheduled-prompt");
});

test("enqueue round-trips customPrompt through the store", () => {
  const store = new JobStore(openDatabase(":memory:"));
  const { job } = store.enqueue({
    source: "prompt",
    entityId: "prompt-demo-nightly",
    triggerType: "scheduled-prompt",
    repo: "demo",
    runner: "codex",
    customPrompt: "do the thing",
  });
  const got = store.get(job.id);
  assert.equal(got?.customPrompt, "do the thing");
  assert.equal(got?.source, "prompt");
  assert.equal(got?.runner, "codex");
});
