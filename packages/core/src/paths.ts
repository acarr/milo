import { homedir } from "node:os";
import { join } from "node:path";

/**
 * MILO_HOME holds Milo's small runtime state (config, db, logs, secrets).
 * Resolution: env MILO_HOME > ~/.milo. (The config file itself lives here, so
 * it cannot relocate its own directory; `worktreeBase` is relocated separately.)
 */
export function miloHome(): string {
  return process.env.MILO_HOME ?? join(homedir(), ".milo");
}

export function configPath(): string {
  return join(miloHome(), "config.json");
}

export function dbPath(): string {
  return join(miloHome(), "milo.db");
}

export function logsDir(): string {
  return join(miloHome(), "logs");
}

export function secretsDir(): string {
  return join(miloHome(), "secrets");
}

/**
 * Worktrees are the disk hog, so their base is relocatable independently of
 * MILO_HOME. Resolution: config.worktreeBase > $MILO_HOME/worktrees.
 */
export function worktreeBase(configuredBase?: string): string {
  return configuredBase ?? join(miloHome(), "worktrees");
}
