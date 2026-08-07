import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { configPath } from "./paths.js";

/**
 * Config schema — a backward-compatible superset of the legacy ~/.milo/config.json
 * (the bash milo.sh format). v1 files parse cleanly and are normalized to v2 in memory;
 * we do NOT rewrite the user's file here (the live milo.sh still reads it).
 */

export const RepoConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
  baseBranch: z.string().default("main"),
  teamKeys: z.array(z.string()).default([]),
  packageManager: z.enum(["npm", "pnpm", "yarn"]).default("npm"),
  setupScript: z.string().optional(),
  teardownScript: z.string().optional(),
  routingLabels: z.array(z.string()).optional(),
  routing: z.record(z.string(), z.string()).optional(),
  defaultRouting: z.string().optional(),
  // v2 additions (all optional)
  defaultRunner: z.enum(["claude", "codex", "conductor"]).optional(),
  promptAugmentation: z.string().optional(),
  teardownPolicy: z.enum(["always", "keep-on-failure"]).default("always"),
  // GitHub slug (owner/name) for attach-mode PR triggers; inferred from origin remote if omitted.
  githubRepo: z.string().optional(),
  // Per-repo override of live progress streaming (falls back to the global `progress` block).
  progress: z
    .object({
      enabled: z.boolean().optional(),
      verbosity: z.enum(["quiet", "normal", "verbose"]).optional(),
      minIntervalMs: z.number().optional(),
    })
    .optional(),
  // Per-repo Conductor Cloud settings (only read when the resolved runner is `conductor`).
  conductor: z
    .object({
      /**
       * Conductor project id (`GET /v0/projects`). Effectively REQUIRED: an organization API key
       * launches workspaces on the org's machine, and `repositoryUrl` is rejected with
       * INVALID_REQUEST unless that repo has been added to the machine in Conductor's org settings.
       */
      projectId: z.string().optional(),
      /** Explicit override; only usable when the repo is reachable from the caller's machine. */
      repositoryUrl: z.string().optional(),
      /** Which agent runs inside the cloud workspace — orthogonal to Milo's runner id. */
      agent: z.enum(["claude", "codex", "cursor"]).optional(),
      model: z.string().optional(),
      effort: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    })
    .optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

const RunnerDefaultsSchema = z
  .object({
    default: z.enum(["claude", "codex", "conductor"]).default("claude"),
    claude: z
      .object({ modelChain: z.array(z.string()).default(["opus", "sonnet", "haiku"]) })
      .default({ modelChain: ["opus", "sonnet", "haiku"] }),
    codex: z
      .object({ modelChain: z.array(z.string()).default(["gpt-5.5"]) })
      .default({ modelChain: ["gpt-5.5"] }),
    conductor: z
      .object({ modelChain: z.array(z.string()).default(["opus-5-1m"]) })
      .default({ modelChain: ["opus-5-1m"] }),
  })
  .default({
    default: "claude",
    claude: { modelChain: ["opus", "sonnet", "haiku"] },
    codex: { modelChain: ["gpt-5.5"] },
    conductor: { modelChain: ["opus-5-1m"] },
  });

/**
 * Conductor Cloud — the remote runner. Milo creates a cloud workspace, sends the task as a message,
 * polls the session to completion, then fast-forwards the local worktree from the branch the remote
 * pushed so the ordinary verification gate can open the PR.
 */
const ConductorSchema = z
  .object({
    /**
     * API key. Prefer `CONDUCTOR_API_KEY` in the environment or `$MILO_HOME/secrets/conductor`;
     * this field is the plaintext fallback (same precedent as `linearToken`). See `secrets.ts`.
     */
    apiKey: z.string().optional(),
    baseUrl: z.string().default("https://api.conductor.build/v0"),
    /**
     * Conductor's proxy rejects some default client signatures (notably Node's `undici`) with a 403
     * that looks exactly like a bad API key — so a real User-Agent is mandatory, not cosmetic.
     */
    userAgent: z.string().default("milo (+https://github.com/acarr/milo)"),
    agent: z.enum(["claude", "codex", "cursor"]).default("claude"),
    effort: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    /**
     * How many remote sessions may be tracked at once — SEPARATE from the local `concurrency` cap.
     * A parked remote job uses no local CPU, disk, or process (just a poll timer), so it must not
     * consume one of the local slots; this is what stops a few long cloud runs starving local work.
     */
    concurrency: z.number().int().min(1).default(10),
    /** Session poll interval. Conductor has no webhooks; their docs suggest ~15s. */
    pollMs: z.number().int().min(2_000).default(15_000),
    /** Give up if the session never starts a turn (workspace provisioning wedged). */
    dispatchTimeoutMs: z.number().int().default(10 * 60_000),
    /** Cloud workspace disposition, mirroring `repositories[].teardownPolicy`. */
    cleanup: z
      .object({
        onSuccess: z.enum(["archive", "sleep", "keep"]).default("archive"),
        onFailure: z.enum(["archive", "sleep", "keep"]).default("sleep"),
      })
      .default({ onSuccess: "archive", onFailure: "sleep" }),
    /** Env vars forwarded to the cloud workspace. This ships to a third party — keep secrets out. */
    env: z.record(z.string(), z.string()).default({}),
  })
  .default({});

const TransportSchema = z
  .object({
    mode: z.enum(["poll", "webhook", "webhook+poll"]).default("poll"),
    pollSeconds: z.number().default(90),
    enabled: z.boolean().default(true),
  })
  .default({ mode: "poll", pollSeconds: 90, enabled: true });

const ScheduleSchema = z.object({
  name: z.string(),
  cron: z.string(),
  intent: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});

const TrustSchema = z
  .object({
    linearActors: z.array(z.string()).default([]),
    githubActors: z.array(z.string()).default([]),
    autoMerge: z.boolean().default(false),
    webhookSecrets: z
      .object({ linear: z.string().optional(), github: z.string().optional() })
      .default({}),
  })
  .default({ linearActors: [], githubActors: [], autoMerge: false, webhookSecrets: {} });

const WebhookSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().default(3457),
  })
  .default({ enabled: false, host: "127.0.0.1", port: 3457 });

/**
 * Dependency sequencing (MILO-4): honor Linear `blockedBy` relations so a blocked issue doesn't
 * run cold against `main` in parallel with its blocker. `defaultStrategy` is conservative
 * (`wait` = hold until the blocker's PR merges); `stacked` (opt-in via config or a `stacked`
 * label) branches the dependent off the blocker's head so the PRs stack.
 */
const DependenciesSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultStrategy: z.enum(["wait", "stacked"]).default("wait"),
    /**
     * How long a freshly-enqueued Linear job is held back from claiming so dependency discovery
     * can record its `blockedBy` edges first (MILO-15). Discovery clears the hold early once the
     * issue's blockers are accounted for; if discovery can't run (Linear outage), the hold simply
     * expires into today's parallel-fallback behavior. 0 disables holds.
     */
    holdMs: z.number().int().min(0).default(60_000),
  })
  .default({ enabled: true, defaultStrategy: "wait", holdMs: 60_000 });

/** Live agent-session progress streaming (MILO-5). Best-effort; only affects delegated jobs. */
const ProgressSchema = z
  .object({
    enabled: z.boolean().default(true),
    verbosity: z.enum(["quiet", "normal", "verbose"]).default("normal"),
    minIntervalMs: z.number().default(8_000),
  })
  .default({ enabled: true, verbosity: "normal", minIntervalMs: 8_000 });

export const MiloConfigSchema = z.object({
  version: z.literal(2).default(2),
  miloHome: z.string().optional(),
  worktreeBase: z.string().optional(),
  concurrency: z.number().default(3),
  runnerDefaults: RunnerDefaultsSchema,
  promptAugmentation: z.object({ global: z.string().optional() }).default({}),
  schedules: z.array(ScheduleSchema).default([]),
  trust: TrustSchema,
  webhook: WebhookSchema,
  dependencies: DependenciesSchema,
  progress: ProgressSchema,
  conductor: ConductorSchema,
  transports: z
    .object({
      linear: TransportSchema,
      github: TransportSchema,
      slack: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
      whatsapp: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    })
    .default({
      linear: { mode: "poll", pollSeconds: 90, enabled: true },
      github: { mode: "poll", pollSeconds: 120, enabled: true },
      slack: { enabled: false },
      whatsapp: { enabled: false },
    }),
  repositories: z.array(RepoConfigSchema).default([]),
  // Legacy secret fields are tolerated on read (we relocate them to secrets/ later, not here).
  linearToken: z.string().optional(),
  linearRefreshToken: z.string().optional(),
  linearClientId: z.string().optional(),
  linearClientSecret: z.string().optional(),
});
export type MiloConfig = z.infer<typeof MiloConfigSchema>;

export interface LoadedConfig {
  config: MiloConfig;
  rawVersion: 1 | 2;
  path: string;
}

/** Reads and validates the config at $MILO_HOME/config.json. Throws on parse/validation error. */
export function loadConfig(path = configPath()): LoadedConfig {
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const rawVersion: 1 | 2 = raw["version"] === 2 ? 2 : 1;
  const config = MiloConfigSchema.parse(raw);
  return { config, rawVersion, path };
}

/** Resolve a configured repo by its `name` (used by scheduled-prompt jobs, which carry no team key). */
export function resolveRepoByName(config: MiloConfig, name: string): RepoConfig | undefined {
  return config.repositories.find((r) => r.name === name);
}

/** Resolve the repo that owns a Linear team key (e.g. "WAZ"), honoring routingLabels. */
export function resolveRepo(
  config: MiloConfig,
  teamKey: string,
  labels: string[] = [],
): RepoConfig | undefined {
  const candidates = config.repositories.filter((r) => r.teamKeys.includes(teamKey));
  if (candidates.length <= 1) return candidates[0];
  const lower = labels.map((l) => l.toLowerCase().trim());
  const byLabel = candidates.find((r) =>
    (r.routingLabels ?? []).some((rl) => lower.includes(rl.toLowerCase())),
  );
  if (byLabel) return byLabel;
  return candidates.find((r) => !r.routingLabels) ?? candidates[0];
}

export interface ResolvedProgress {
  enabled: boolean;
  verbosity: "quiet" | "normal" | "verbose";
  minIntervalMs: number;
}

/** Effective progress-streaming settings for a repo: per-repo overrides win over the global block. */
export function resolveProgress(config: MiloConfig, repo?: RepoConfig): ResolvedProgress {
  const g = config.progress;
  const o = repo?.progress;
  return {
    enabled: o?.enabled ?? g.enabled,
    verbosity: o?.verbosity ?? g.verbosity,
    minIntervalMs: o?.minIntervalMs ?? g.minIntervalMs,
  };
}
