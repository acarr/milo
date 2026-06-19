import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-cfg-"));

import { configPath, loadConfig } from "@milo/core";
import { removeRepoConfig } from "../src/repo-setup/config-writer.js";
import { updateSettings } from "../src/init/config-init.js";

const CONFIG = {
  version: 2,
  concurrency: 3,
  trust: { autoMerge: false, linearActors: ["alice"], githubActors: [], webhookSecrets: { linear: "s" } },
  schedules: [{ name: "x", cron: "* * * * *", intent: { kind: "maintenance" }, enabled: true }],
  linearToken: "tok",
  repositories: [
    { name: "a", path: "/a", routing: { bug: "fix it" }, teamKeys: ["AAA"] },
    { name: "b", path: "/b" },
  ],
};

const seed = () => writeFileSync(configPath(), JSON.stringify(CONFIG));

test("removeRepoConfig removes by name and preserves everything else", () => {
  seed();
  assert.equal(removeRepoConfig("a"), true);
  const { config } = loadConfig();
  assert.equal(config.repositories.length, 1);
  assert.equal(config.repositories[0]!.name, "b");
  assert.deepEqual(config.trust.linearActors, ["alice"], "unmanaged trust list preserved");
  assert.equal(config.linearToken, "tok", "credential preserved");
  assert.equal(config.schedules.length, 1, "schedules preserved");
  assert.equal(removeRepoConfig("missing"), false);
});

test("updateSettings patches bidirectionally and preserves unmanaged keys + repos", () => {
  seed();
  updateSettings({ webhookEnabled: true, autoMerge: true, defaultRunner: "codex", concurrency: 5 });
  let config = loadConfig().config;
  assert.equal(config.webhook.enabled, true);
  assert.equal(config.trust.autoMerge, true);
  assert.equal(config.runnerDefaults.default, "codex");
  assert.equal(config.concurrency, 5);
  assert.deepEqual(config.trust.linearActors, ["alice"], "unmanaged trust list preserved");
  assert.equal(config.repositories.length, 2, "repos preserved");
  assert.equal((config.repositories[0] as { routing?: Record<string, string> }).routing?.["bug"], "fix it");

  updateSettings({ webhookEnabled: false }); // bidirectional — can turn back off
  config = loadConfig().config;
  assert.equal(config.webhook.enabled, false);
  assert.equal(config.runnerDefaults.default, "codex", "earlier patch preserved");
});
