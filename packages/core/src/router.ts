import type { MiloConfig, RepoConfig } from "./config.js";
import { githubSlugForPath } from "./github.js";

export type RunnerId = "claude" | "codex";

const RUNNERS: RunnerId[] = ["claude", "codex"];

/**
 * Resolve which runner should handle a job. Precedence (highest first):
 *   1. an explicit `[agent=codex]` / `[agent=claude]` tag in free text (title/desc/comment)
 *   2. a Linear/GitHub label `runner:codex` / `runner:claude`
 *   3. the repo's `defaultRunner`
 *   4. the global `runnerDefaults.default`
 */
export function resolveRunner(
  config: MiloConfig,
  repo: RepoConfig | undefined,
  signals: { labels?: string[]; text?: string } = {},
): RunnerId {
  const text = signals.text ?? "";
  const tag = text.match(/\[agent=(claude|codex)\]/i);
  if (tag) return tag[1]!.toLowerCase() as RunnerId;

  const labels = (signals.labels ?? []).map((l) => l.toLowerCase().trim());
  for (const r of RUNNERS) {
    if (labels.includes(`runner:${r}`)) return r;
  }

  if (repo?.defaultRunner) return repo.defaultRunner;
  return config.runnerDefaults.default;
}

/** Pick the first model in the runner's configured chain. */
export function modelFor(config: MiloConfig, runner: RunnerId): string {
  const chain =
    runner === "codex" ? config.runnerDefaults.codex.modelChain : config.runnerDefaults.claude.modelChain;
  return chain[0] ?? (runner === "codex" ? "gpt-5.5" : "opus");
}

/**
 * Resolve the RepoConfig for a GitHub `owner/name` slug. Matches an explicit `githubRepo`
 * field if set, else falls back to comparing the repo's origin remote, else the bare name.
 */
export function resolveRepoByGithub(config: MiloConfig, slug: string): RepoConfig | undefined {
  const bare = slug.split("/")[1]?.toLowerCase();
  return (
    config.repositories.find((r) => r.githubRepo?.toLowerCase() === slug.toLowerCase()) ??
    config.repositories.find((r) => githubSlugForPath(r.path)?.toLowerCase() === slug.toLowerCase()) ??
    config.repositories.find((r) => r.name.toLowerCase() === bare)
  );
}
