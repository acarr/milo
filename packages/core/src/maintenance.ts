import { spawnSync } from "node:child_process";
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";

export interface MaintenanceReport {
  worktreesPruned: string[];
  logsDeleted: number;
  freeGb: number;
  diskOk: boolean;
}

/**
 * Remove worktree directories under `worktreeBasePath` that are NOT tied to a live job and are
 * older than `maxAgeMs`. Best-effort: tries `git worktree remove` if we can find the parent repo,
 * else `rm -rf`. Returns the paths it removed.
 */
export function pruneWorktrees(
  worktreeBasePath: string,
  activePaths: Set<string>,
  maxAgeMs = 6 * 3600_000,
  now: () => number = () => Date.now(),
): string[] {
  if (!existsSync(worktreeBasePath)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(worktreeBasePath)) {
    const path = join(worktreeBasePath, name);
    if (activePaths.has(path)) continue;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (now() - st.mtimeMs < maxAgeMs) continue; // recently touched — leave it

    // Try a clean git worktree removal from inside the worktree (knows its own repo).
    const gitRm = spawnSync("git", ["-C", path, "worktree", "remove", path, "--force"], { encoding: "utf8" });
    if (gitRm.status !== 0) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ path, err: (err as Error).message }, "failed to prune worktree");
        continue;
      }
    }
    removed.push(path);
  }
  if (removed.length) logger.info({ count: removed.length }, "pruned stale worktrees");
  return removed;
}

/** Delete old runner logs (`*.log`) and per-job transcripts (`*.events.jsonl`). Returns the count. */
export function rotateLogs(
  logsDir: string,
  maxAgeDays = 14,
  now: () => number = () => Date.now(),
): number {
  if (!existsSync(logsDir)) return 0;
  const cutoff = now() - maxAgeDays * 86_400_000;
  let deleted = 0;
  for (const name of readdirSync(logsDir)) {
    if (!name.endsWith(".log") && !name.endsWith(".events.jsonl")) continue;
    const path = join(logsDir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path);
        deleted++;
      }
    } catch {
      /* ignore */
    }
  }
  if (deleted) logger.info({ deleted }, "rotated old logs");
  return deleted;
}

/** Free space (in GB) on the filesystem holding `path`, and whether it clears `minFreeGb`. */
export async function diskGuard(path: string, minFreeGb = 5): Promise<{ freeGb: number; ok: boolean }> {
  try {
    const s = await statfs(path);
    const freeGb = (s.bavail * s.bsize) / 1024 ** 3;
    const ok = freeGb >= minFreeGb;
    if (!ok) logger.warn({ freeGb: Number(freeGb.toFixed(1)), minFreeGb }, "disk space low");
    return { freeGb, ok };
  } catch (err) {
    logger.warn({ path, err: (err as Error).message }, "disk guard check failed");
    return { freeGb: NaN, ok: true }; // don't block on a failed check
  }
}

export interface MaintenanceDeps {
  worktreeBasePath: string;
  logsDir: string;
  activePaths: Set<string>;
  worktreeMaxAgeMs?: number;
  logMaxAgeDays?: number;
  minFreeGb?: number;
}

/** Run the full housekeeping pass: prune worktrees, rotate logs, check disk. */
export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceReport> {
  const worktreesPruned = pruneWorktrees(deps.worktreeBasePath, deps.activePaths, deps.worktreeMaxAgeMs);
  const logsDeleted = rotateLogs(deps.logsDir, deps.logMaxAgeDays);
  const { freeGb, ok } = await diskGuard(deps.worktreeBasePath, deps.minFreeGb);
  return { worktreesPruned, logsDeleted, freeGb, diskOk: ok };
}
