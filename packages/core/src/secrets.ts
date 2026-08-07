import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretsDir } from "./paths.js";
import type { MiloConfig } from "./config.js";

/**
 * File-backed secrets under `$MILO_HOME/secrets/` (0600 files in a 0700 dir), so a credential never
 * has to live in `config.json` — which is read, rewritten, and printed by several code paths.
 *
 * Linear's OAuth tokens still live in config.json for backward compatibility (see
 * `docs/REMAINING-WORK.md` C2); Conductor is the first credential to use this instead.
 */

function secretPath(name: string): string {
  return join(secretsDir(), `${name}.json`);
}

/** Read a secret, or undefined if it isn't set / the file is unreadable or malformed. */
export function readSecret(name: string): string | undefined {
  const path = secretPath(name);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { value?: unknown };
    const value = typeof parsed.value === "string" ? parsed.value.trim() : "";
    return value || undefined;
  } catch {
    // A corrupt secrets file must not take the daemon down — treat it as absent.
    return undefined;
  }
}

/** Write a secret with owner-only permissions, creating `$MILO_HOME/secrets/` if needed. */
export function writeSecret(name: string, value: string): string {
  const dir = secretsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = secretPath(name);
  writeFileSync(path, JSON.stringify({ value }, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/**
 * Resolve the Conductor Cloud API key. Precedence (highest first):
 *   1. `CONDUCTOR_API_KEY` in the environment
 *   2. `$MILO_HOME/secrets/conductor.json`
 *   3. `config.conductor.apiKey` (plaintext fallback)
 *
 * Returns undefined when no key is configured — callers treat that as "the conductor runner is not
 * available on this Milo" rather than as an error, mirroring an unregistered runner.
 */
export function resolveConductorApiKey(config?: MiloConfig): string | undefined {
  const env = process.env.CONDUCTOR_API_KEY?.trim();
  if (env) return env;
  return readSecret("conductor") ?? config?.conductor?.apiKey?.trim() ?? undefined;
}
