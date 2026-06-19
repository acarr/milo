import React from "react";
import { render } from "ink";
import { resolve } from "node:path";
import { LinearClient, loadConfig, type LinearTeam, type RepoConfig } from "@milo/core";
import { inferRepoDefaults, isGitRepo } from "./infer.js";
import { preselectTeamKeys } from "./teams.js";
import { appendRepoConfig } from "./config-writer.js";
import { AddRepo, type AddRepoResult } from "./AddRepo.js";

export { inferRepoDefaults, isGitRepo, findGitRoot } from "./infer.js";
export type { InferredRepoDefaults } from "./infer.js";
export { preselectTeamKeys } from "./teams.js";
export { appendRepoConfig } from "./config-writer.js";
export { AddRepo } from "./AddRepo.js";
export type { AddRepoResult } from "./AddRepo.js";

/**
 * `milo add-repo [path]` — the standalone entry point to the reusable repo-setup module.
 *
 * Resolves the target repo (positional path, else cwd), infers its details, fetches the
 * workspace's Linear teams, runs the interactive confirm/teams/optional flow, and appends the
 * resulting RepoConfig to config.json. The `init` wizard reuses these same building blocks.
 */
export async function runAddRepo(argv: string[]): Promise<number> {
  const target = resolve(argv.find((a) => !a.startsWith("-")) ?? process.cwd());

  if (!isGitRepo(target)) {
    console.error(
      `${target} is not a git repository.\n` +
        `Run \`milo add-repo\` from inside a git repo, or pass a path: \`milo add-repo <path>\`.`,
    );
    return 1;
  }

  // Linear credentials are required — fail clearly, pointing at auth, before any TUI.
  let linear: LinearClient;
  try {
    linear = LinearClient.fromConfig();
  } catch (err) {
    console.error(
      `milo add-repo needs Linear credentials: ${(err as Error).message}\n` +
        `Authenticate first with \`milo linear-auth\`.`,
    );
    return 1;
  }

  let teams: LinearTeam[];
  try {
    teams = await linear.listTeams();
  } catch (err) {
    console.error(
      `Failed to fetch Linear teams: ${(err as Error).message}\n` +
        `Re-authenticate with \`milo linear-auth\` and try again.`,
    );
    return 1;
  }
  if (teams.length === 0) {
    console.error("No Linear teams are visible to Milo — check the granted workspace/teams in `milo linear-auth`.");
    return 1;
  }

  if (!process.stdin.isTTY) {
    console.error("milo add-repo is interactive — run it in a terminal (TTY).");
    return 1;
  }

  const inferred = inferRepoDefaults(target);
  const preselected = preselectTeamKeys(teams, inferred);

  // Recognize a repo that's already wired into config.json — same match as the writer (path or name).
  let existing: RepoConfig | undefined;
  try {
    const { config } = loadConfig();
    existing = config.repositories.find((r) => r.path === inferred.path || r.name === inferred.name);
  } catch {
    // No config yet — treat as a fresh add.
  }
  if (existing) {
    console.log(`'${existing.name}' is already configured — opening it for editing.`);
  }

  const result = await new Promise<AddRepoResult | null>((resolveResult) => {
    const app = render(
      React.createElement(AddRepo, {
        inferred,
        teams,
        preselected,
        existing,
        onDone: (r: AddRepoResult | null) => resolveResult(r),
      }),
    );
    void app.waitUntilExit();
  });

  if (!result) {
    console.log("milo add-repo: cancelled — config unchanged.");
    return 1;
  }

  try {
    const repo = appendRepoConfig(result);
    console.log(
      `\n✓ ${existing ? "Updated" : "Added"} repo '${repo.name}' (${repo.path})\n` +
        `  baseBranch ${repo.baseBranch} · ${repo.packageManager}` +
        `${repo.githubRepo ? ` · ${repo.githubRepo}` : ""}` +
        ` · teams ${repo.teamKeys.length ? repo.teamKeys.join(", ") : "(none)"}` +
        `${repo.defaultRunner ? ` · runner ${repo.defaultRunner}` : ""}`,
    );
    return 0;
  } catch (err) {
    console.error(`Failed to write repo into config: ${(err as Error).message}`);
    return 1;
  }
}
