import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, MiloConfigSchema, type MiloConfig } from "@milo/core";

/**
 * The config fields `milo init` may set. Everything else in the schema keeps its Zod default —
 * the written file stays minimal, materializing only what the user actually chose.
 */
export interface InitConfigInput {
  /** Only written when it differs from the $MILO_HOME/worktrees default. */
  worktreeBase?: string;
  defaultRunner?: "claude" | "codex";
  enableWebhook?: boolean;
  autoMerge?: boolean;
  linearClientId?: string;
  linearClientSecret?: string;
  /** Written when the wizard's in-wizard Authenticate succeeded. */
  linearToken?: string;
  linearRefreshToken?: string;
}

/**
 * Create config.json, or merge init's choices into an existing one — never clobbering anything
 * already there (repos, credentials, schedules, trust lists all survive). The merged document is
 * validated against the schema BEFORE the file is touched, so a bad merge can never corrupt an
 * existing config. Returns the parsed (defaults-applied) config.
 */
export function writeBaseConfig(input: InitConfigInput, path = configPath()): MiloConfig {
  const existing: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};

  const merged: Record<string, unknown> = { version: 2, ...existing };

  if (input.worktreeBase) merged["worktreeBase"] = input.worktreeBase;
  if (input.defaultRunner && input.defaultRunner !== "claude") {
    merged["runnerDefaults"] = {
      ...((existing["runnerDefaults"] as Record<string, unknown>) ?? {}),
      default: input.defaultRunner,
    };
  }
  if (input.enableWebhook) {
    merged["webhook"] = {
      ...((existing["webhook"] as Record<string, unknown>) ?? {}),
      enabled: true,
    };
  }
  if (input.autoMerge) {
    merged["trust"] = {
      ...((existing["trust"] as Record<string, unknown>) ?? {}),
      autoMerge: true,
    };
  }
  if (input.linearClientId) merged["linearClientId"] = input.linearClientId;
  if (input.linearClientSecret) merged["linearClientSecret"] = input.linearClientSecret;
  if (input.linearToken) merged["linearToken"] = input.linearToken;
  if (input.linearRefreshToken) merged["linearRefreshToken"] = input.linearRefreshToken;
  if (!Array.isArray(merged["repositories"])) merged["repositories"] = [];

  const parsed = MiloConfigSchema.parse(merged); // validate before writing anything
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  } catch (err) {
    // Surface a friendly, actionable message instead of a raw EACCES stack trace.
    throw new Error(
      `Couldn't write config to ${path}: ${(err as Error).message}.\n` +
        `Check that the directory is writable, or pick a different Milo home (MILO_HOME).`,
    );
  }
  return parsed;
}

/**
 * Patch settings the in-TUI Settings view can change. Unlike {@link writeBaseConfig} (init-shaped,
 * one-way), these are BIDIRECTIONAL — webhook/autoMerge can be turned back off. Every other field
 * (repos, credentials, schedules, trust lists) is preserved; the merged doc is validated before the
 * file is touched.
 */
export interface SettingsPatch {
  defaultRunner?: "claude" | "codex";
  webhookEnabled?: boolean;
  autoMerge?: boolean;
  concurrency?: number;
}

export function updateSettings(patch: SettingsPatch, path = configPath()): MiloConfig {
  const existing: Record<string, unknown> = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { version: 2, ...existing };

  if (patch.defaultRunner) {
    merged["runnerDefaults"] = {
      ...((existing["runnerDefaults"] as Record<string, unknown>) ?? {}),
      default: patch.defaultRunner,
    };
  }
  if (patch.webhookEnabled !== undefined) {
    merged["webhook"] = { ...((existing["webhook"] as Record<string, unknown>) ?? {}), enabled: patch.webhookEnabled };
  }
  if (patch.autoMerge !== undefined) {
    merged["trust"] = { ...((existing["trust"] as Record<string, unknown>) ?? {}), autoMerge: patch.autoMerge };
  }
  if (patch.concurrency !== undefined) merged["concurrency"] = patch.concurrency;
  if (!Array.isArray(merged["repositories"])) merged["repositories"] = [];

  const parsed = MiloConfigSchema.parse(merged);
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  return parsed;
}
