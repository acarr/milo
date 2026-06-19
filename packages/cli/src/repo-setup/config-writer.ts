import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, RepoConfigSchema, type RepoConfig } from "@milo/core";

/**
 * Validate `input` against {@link RepoConfigSchema} and append it to the repositories array in
 * config.json, preserving every other field (credentials, schedules, trust, existing repos).
 *
 * A repo matching by `name` or `path` is updated in place (idempotent re-add) rather than
 * duplicated; all other repos and top-level config keys are left untouched — never clobbered.
 * Throws (before touching the file) if `input` fails schema validation or the config is missing.
 */
export function appendRepoConfig(input: unknown, path = configPath()): RepoConfig {
  const repo = RepoConfigSchema.parse(input); // validate + apply defaults up front

  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Set up ~/.milo/config.json (and run \`milo linear-auth\`) first.`,
    );
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const repos = Array.isArray(raw["repositories"]) ? (raw["repositories"] as RepoConfig[]) : [];

  const idx = repos.findIndex((r) => r?.name === repo.name || (!!r?.path && r.path === repo.path));
  if (idx >= 0) repos[idx] = repo;
  else repos.push(repo);

  raw["repositories"] = repos;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return repo;
}
