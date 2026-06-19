import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-init-"));
import { loadConfig, configPath, MiloConfigSchema } from "@milo/core";
import { writeBaseConfig } from "../src/init/config-init.js";
import { runDoctor } from "../src/doctor.js";

const freshHome = () => {
  process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-init-"));
};

test("writeBaseConfig creates a minimal config that loadConfig parses", () => {
  freshHome();
  assert.equal(existsSync(configPath()), false);

  const parsed = writeBaseConfig({});
  assert.equal(existsSync(configPath()), true);

  // Parsed result has every schema default applied…
  assert.equal(parsed.version, 2);
  assert.equal(parsed.concurrency, 3);
  assert.equal(parsed.runnerDefaults.default, "claude");
  assert.equal(parsed.webhook.enabled, false);
  assert.deepEqual(parsed.repositories, []);

  // …but the file on disk stays minimal (defaults are not materialized).
  const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).sort(), ["repositories", "version"]);

  // And the canonical loader accepts it.
  const { config } = loadConfig();
  assert.equal(config.version, 2);
});

test("writeBaseConfig records explicit choices (worktreeBase, codex, webhook, autoMerge, creds)", () => {
  freshHome();
  const parsed = writeBaseConfig({
    worktreeBase: "/data/worktrees",
    defaultRunner: "codex",
    enableWebhook: true,
    autoMerge: true,
    linearClientId: "id-1",
    linearClientSecret: "sec-1",
  });
  assert.equal(parsed.worktreeBase, "/data/worktrees");
  assert.equal(parsed.runnerDefaults.default, "codex");
  assert.equal(parsed.webhook.enabled, true);
  assert.equal(parsed.trust.autoMerge, true);
  assert.equal(parsed.linearClientId, "id-1");

  const { config } = loadConfig();
  assert.equal(config.runnerDefaults.default, "codex");
  assert.equal(config.webhook.enabled, true);
});

test("writeBaseConfig merges over an existing config without clobbering anything", () => {
  freshHome();
  // Simulate an existing, populated config (repos, token, trust list).
  const existing = {
    version: 2,
    linearToken: "tok-keep",
    trust: { githubActors: ["alice"], autoMerge: false },
    repositories: [
      { name: "repo-a", path: "/repos/a", teamKeys: ["AAA"] },
    ],
  };
  writeBaseConfig({}); // create the file (and its directory) first
  writeFileSync(configPath(), JSON.stringify(existing, null, 2));

  // Re-run init's writer with new choices — existing values must survive.
  const parsed = writeBaseConfig({ enableWebhook: true, autoMerge: true });
  assert.equal(parsed.linearToken, "tok-keep", "credentials preserved");
  assert.equal(parsed.repositories.length, 1, "repos preserved");
  assert.equal(parsed.repositories[0]!.name, "repo-a");
  assert.deepEqual(parsed.trust.githubActors, ["alice"], "trust list preserved");
  assert.equal(parsed.trust.autoMerge, true, "explicit init choice applied");
  assert.equal(parsed.webhook.enabled, true);
});

test("writeBaseConfig persists in-wizard auth tokens", () => {
  freshHome();
  const parsed = writeBaseConfig({
    linearClientId: "id-1",
    linearClientSecret: "sec-1",
    linearToken: "tok-1",
    linearRefreshToken: "ref-1",
  });
  assert.equal(parsed.linearToken, "tok-1");
  assert.equal(parsed.linearRefreshToken, "ref-1");

  const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  assert.equal(raw["linearToken"], "tok-1");
  assert.equal(raw["linearRefreshToken"], "ref-1");
});

test("writeBaseConfig surfaces a friendly error when the config directory can't be created", () => {
  // Point MILO_HOME *under a regular file* so mkdir fails (ENOTDIR) — the classic
  // "Permission denied"-style crash, now expected to come back as an actionable message.
  freshHome();
  const blocker = join(process.env["MILO_HOME"]!, "blocker");
  writeFileSync(blocker, "");
  process.env["MILO_HOME"] = join(blocker, "nested");

  assert.throws(
    () => writeBaseConfig({}),
    /Couldn't write config to .*Check that the directory is writable/s,
    "raw fs errors are wrapped in an actionable message",
  );
});

test("writeBaseConfig validates BEFORE writing — a bad merge never corrupts the existing file", () => {
  freshHome();
  writeBaseConfig({});
  const before = readFileSync(configPath(), "utf8");

  // Corrupt input that fails schema validation (worktreeBase must be a string).
  assert.throws(() => writeBaseConfig({ worktreeBase: 42 as unknown as string }));
  assert.equal(readFileSync(configPath(), "utf8"), before, "file untouched after a failed validation");
});

// ---- E2E-style clean run: a fresh MILO_HOME ends with a config that doctor reports OK ----

test("clean-run: fresh MILO_HOME → init-written config → doctor's required config/store/worktree checks pass", () => {
  freshHome();

  // What `milo init` writes on the happy path with every optional step skipped.
  writeBaseConfig({});

  // The acceptance bar: loadConfig parses it…
  const { config } = loadConfig();
  assert.equal(MiloConfigSchema.safeParse(config).success, true);

  // …and doctor's environment-independent required checks are green.
  const checks = runDoctor();
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName["config"]!.status, "ok", `config check: ${byName["config"]!.detail}`);
  assert.equal(byName["store"]!.status, "ok", `store check: ${byName["store"]!.detail}`);
  assert.equal(byName["worktreeBase"]!.status, "ok", `worktreeBase check: ${byName["worktreeBase"]!.detail}`);
});
