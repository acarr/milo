import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  inferName,
  inferPackageManager,
  inferGithubRepo,
  inferBaseBranch,
  inferRepoDefaults,
  isGitRepo,
} from "../src/repo-setup/infer.js";
import { preselectTeamKeys } from "../src/repo-setup/teams.js";
import { appendRepoConfig } from "../src/repo-setup/config-writer.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(os.tmpdir(), prefix));
}

/** Init a git repo at `dir` with an origin remote + an origin/HEAD pointing at `defaultBranch`. */
function initRepo(dir: string, opts: { remote?: string; defaultBranch?: string } = {}): void {
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  if (opts.remote) git("remote", "add", "origin", opts.remote);
  if (opts.defaultBranch) {
    // Simulate `origin/HEAD -> origin/<branch>` without a network fetch.
    mkdirSync(join(dir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(
      join(dir, ".git", "refs", "remotes", "origin", "HEAD"),
      `ref: refs/remotes/origin/${opts.defaultBranch}\n`,
    );
  }
}

test("inferName: package.json name (scope stripped) → directory basename", () => {
  const dir = tmp("milo-infer-name-");
  // No package.json yet → basename.
  assert.equal(inferName(dir), dir.split("/").pop());
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/my-app" }));
  assert.equal(inferName(dir), "my-app");
  writeFileSync(join(dir, "package.json"), "{ not valid json");
  assert.equal(inferName(dir), dir.split("/").pop());
});

test("inferPackageManager: detects from the lockfile (pnpm > yarn > npm)", () => {
  const npmDir = tmp("milo-pm-npm-");
  assert.equal(inferPackageManager(npmDir), "npm"); // default when no lockfile
  writeFileSync(join(npmDir, "package-lock.json"), "{}");
  assert.equal(inferPackageManager(npmDir), "npm");

  const pnpmDir = tmp("milo-pm-pnpm-");
  writeFileSync(join(pnpmDir, "pnpm-lock.yaml"), "");
  assert.equal(inferPackageManager(pnpmDir), "pnpm");

  const yarnDir = tmp("milo-pm-yarn-");
  writeFileSync(join(yarnDir, "yarn.lock"), "");
  assert.equal(inferPackageManager(yarnDir), "yarn");
});

test("inferGithubRepo + inferBaseBranch read git state", () => {
  const dir = tmp("milo-git-");
  initRepo(dir, { remote: "git@github.com:acme/milo.git", defaultBranch: "develop" });
  assert.equal(inferGithubRepo(dir), "acme/milo");
  assert.equal(inferBaseBranch(dir), "develop");
  assert.ok(isGitRepo(dir));

  const noRemote = tmp("milo-git-bare-");
  initRepo(noRemote);
  assert.equal(inferGithubRepo(noRemote), undefined);
  assert.equal(inferBaseBranch(noRemote), "main"); // falls back, never assumes from local HEAD
});

test("inferRepoDefaults combines inference for a standard repo", () => {
  const dir = tmp("milo-defaults-");
  initRepo(dir, { remote: "https://github.com/acme/milo-sandbox.git", defaultBranch: "main" });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "milo-sandbox" }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  const d = inferRepoDefaults(dir);
  assert.equal(d.name, "milo-sandbox");
  assert.equal(d.githubRepo, "acme/milo-sandbox");
  assert.equal(d.baseBranch, "main");
  assert.equal(d.packageManager, "pnpm");
  assert.ok(d.path.endsWith(dir.split("/").pop()!));
});

test("preselectTeamKeys fuzzy-matches repo against team key/name, ignores noise", () => {
  const teams = [
    { id: "1", key: "SBX", name: "Milo Sandbox" },
    { id: "2", key: "WAZ", name: "Wazzon" },
    { id: "3", key: "MILO", name: "Milo" },
  ];
  // "milo-sandbox" shares tokens with "Milo Sandbox" and "Milo".
  const keys = preselectTeamKeys(teams, { name: "milo-sandbox", githubRepo: "acme/milo-sandbox" });
  assert.ok(keys.includes("SBX"));
  assert.ok(keys.includes("MILO"));
  assert.ok(!keys.includes("WAZ"));

  // No token overlap → no preselection.
  assert.deepEqual(preselectTeamKeys(teams, { name: "totally-different" }), []);
});

test("appendRepoConfig validates, appends, and preserves the rest of the config", () => {
  const dir = tmp("milo-cfg-");
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      version: 2,
      linearToken: "lin_oauth_keepme",
      concurrency: 5,
      repositories: [{ name: "existing", path: "/x", teamKeys: ["EX"], packageManager: "npm" }],
    }),
  );

  const repo = appendRepoConfig(
    { name: "milo-sandbox", path: "/repos/milo-sandbox", teamKeys: ["SBX"], packageManager: "pnpm", baseBranch: "main" },
    cfgPath,
  );
  assert.equal(repo.name, "milo-sandbox");

  const after = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(after.linearToken, "lin_oauth_keepme", "credentials preserved");
  assert.equal(after.concurrency, 5, "other top-level fields preserved");
  assert.equal(after.repositories.length, 2, "existing repo kept, new one appended");
  assert.equal(after.repositories[0].name, "existing");
  assert.equal(after.repositories[1].name, "milo-sandbox");

  // Idempotent re-add (same name) updates in place rather than duplicating.
  appendRepoConfig(
    { name: "milo-sandbox", path: "/repos/milo-sandbox", teamKeys: ["SBX", "MILO"], packageManager: "pnpm" },
    cfgPath,
  );
  const after2 = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(after2.repositories.length, 2, "no duplicate on re-add");
  assert.deepEqual(after2.repositories[1].teamKeys, ["SBX", "MILO"], "updated in place");
});

test("appendRepoConfig rejects an invalid RepoConfig before touching the file", () => {
  const dir = tmp("milo-cfg-bad-");
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ version: 2, repositories: [] }));
  assert.throws(() => appendRepoConfig({ name: "x", path: "/x", packageManager: "bun" }, cfgPath));
  // File untouched.
  assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).repositories.length, 0);
});
