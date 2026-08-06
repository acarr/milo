import type { MiloConfig, RepoConfig } from "./config.js";
import { githubSlugForPath } from "./github.js";

export type RunnerId = "claude" | "codex" | "conductor";

export const RUNNERS: RunnerId[] = ["claude", "codex", "conductor"];

/**
 * Runners that execute somewhere other than this machine. `conductor` drives a Conductor Cloud
 * workspace over HTTP, so there is no local process, no local agent output, and no local edits —
 * the only thing Milo can observe is what the remote pushes to `origin`. Callers use this to skip
 * the local-only parts of the pipeline (worktree dependency install, process-group kills).
 */
const REMOTE_RUNNERS = new Set<RunnerId>(["conductor"]);

/** True when the runner does its work off this machine (see {@link REMOTE_RUNNERS}). */
export function isRemoteRunner(runner: RunnerId): boolean {
  return REMOTE_RUNNERS.has(runner);
}

/** `[agent=claude]` / `[agent=codex]` / `[agent=conductor]` — built from RUNNERS so it self-extends. */
const AGENT_TAG = new RegExp(`\\[agent=(${RUNNERS.join("|")})\\]`, "i");

/** Fallback when a runner's configured model chain is empty. */
const FALLBACK_MODEL: Record<RunnerId, string> = {
  claude: "opus",
  codex: "gpt-5.5",
  conductor: "opus-5-1m",
};

/**
 * Resolve which runner should handle a job. Precedence (highest first):
 *   1. an explicit `[agent=codex]` / `[agent=claude]` / `[agent=conductor]` tag in free text
 *   2. a Linear/GitHub label `runner:codex` / `runner:claude` / `runner:conductor`
 *   3. the repo's `defaultRunner`
 *   4. the global `runnerDefaults.default`
 */
export function resolveRunner(
  config: MiloConfig,
  repo: RepoConfig | undefined,
  signals: { labels?: string[]; text?: string } = {},
): RunnerId {
  const text = signals.text ?? "";
  const tag = text.match(AGENT_TAG);
  if (tag) return tag[1]!.toLowerCase() as RunnerId;

  const labels = (signals.labels ?? []).map((l) => l.toLowerCase().trim());
  for (const r of RUNNERS) {
    if (labels.includes(`runner:${r}`)) return r;
  }

  if (repo?.defaultRunner) return repo.defaultRunner;
  return config.runnerDefaults.default;
}

/**
 * Pick the first model in the runner's configured chain.
 *
 * For `conductor` a per-repo `conductor.model` wins — Conductor's model ids are agent-specific
 * (`opus-*` for its claude agent, `gpt-*` for codex), so the right default depends on which inner
 * agent the repo runs.
 */
export function modelFor(config: MiloConfig, runner: RunnerId, repo?: RepoConfig): string {
  if (runner === "conductor" && repo?.conductor?.model) return repo.conductor.model;
  return config.runnerDefaults[runner]?.modelChain?.[0] ?? FALLBACK_MODEL[runner];
}

/** Which agent Conductor should run inside the cloud workspace (orthogonal to {@link RunnerId}). */
export function conductorAgentFor(config: MiloConfig, repo?: RepoConfig): "claude" | "codex" | "cursor" {
  return repo?.conductor?.agent ?? config.conductor.agent;
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
