import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { MiloConfig, RepoConfig } from "./config.js";
import { resolveRepoByName } from "./config.js";
import { Scheduler, type ScheduleDef } from "./scheduler.js";
import type { NewJob } from "./jobs.js";
import { branchSlug } from "./worktree.js";
import { logger } from "./logger.js";

/** Path (relative to a repo's working tree) of its in-repo schedule definitions. */
export const REPO_SCHEDULES_FILE = ".milo/schedules.json";

/**
 * One entry in a repo's `.milo/schedules.json`. The prompt is ALWAYS a separate `.md` referenced by
 * `promptFile` (resolved relative to `<repo>/.milo/`) — never inline JSON. `repo` is implicit (the
 * file lives in the repo it acts on).
 */
const RepoScheduleEntrySchema = z.object({
  name: z.string(),
  cron: z.string(),
  runner: z.enum(["claude", "codex"]).optional(),
  model: z.string().optional(),
  promptFile: z.string(),
  enabled: z.boolean().default(true),
});
export type RepoScheduleEntry = z.infer<typeof RepoScheduleEntrySchema>;
const RepoSchedulesFileSchema = z.array(RepoScheduleEntrySchema);

/** The `intent` payload Milo stores on a discovered prompt `ScheduleDef`. */
export interface PromptIntent {
  kind: "prompt";
  repo: string;
  runner?: "claude" | "codex";
  model?: string;
  promptFile: string;
}

/**
 * Scan every configured repo's `.milo/schedules.json` and return one `ScheduleDef` per valid entry,
 * namespaced `<repo>:<name>` for uniqueness. Only repos already in `config.repositories[]` are
 * scanned (same opt-in posture as GitHub polling). A malformed file / bad cron is logged and skipped
 * — it must never crash the daemon.
 */
export function discoverRepoSchedules(config: MiloConfig): ScheduleDef[] {
  const defs: ScheduleDef[] = [];
  for (const repo of config.repositories) {
    const file = join(repo.path, REPO_SCHEDULES_FILE);
    if (!existsSync(file)) continue;
    let entries: RepoScheduleEntry[];
    try {
      entries = RepoSchedulesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      logger.warn({ repo: repo.name, file, err: (err as Error).message }, "invalid .milo/schedules.json — skipping repo's schedules");
      continue;
    }
    for (const entry of entries) {
      if (!Scheduler.isValid(entry.cron)) {
        logger.warn({ repo: repo.name, schedule: entry.name, cron: entry.cron }, "invalid cron in .milo/schedules.json — skipping entry");
        continue;
      }
      const intent: PromptIntent = {
        kind: "prompt",
        repo: repo.name,
        runner: entry.runner,
        model: entry.model,
        promptFile: entry.promptFile,
      };
      defs.push({
        name: `${repo.name}:${entry.name}`,
        cron: entry.cron,
        intent: intent as unknown as Record<string, unknown>,
        enabled: entry.enabled,
      });
    }
  }
  return defs;
}

/**
 * Read the `.md` a prompt schedule points at. Resolution order for a relative `promptFile`:
 * `<repo>/.milo/<file>` → `<repo>/<file>`; an absolute path is used as-is. Read fresh on each fire so
 * editing the `.md` takes effect without a reload. Throws if the file can't be found or is empty.
 */
export function loadSchedulePrompt(intent: { promptFile?: string }, repo: RepoConfig): string {
  const pf = intent.promptFile;
  if (!pf) throw new Error("prompt schedule has no promptFile");
  const candidates = isAbsolute(pf) ? [pf] : [join(repo.path, ".milo", pf), join(repo.path, pf)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`prompt file not found (tried ${candidates.join(", ")})`);
  const text = readFileSync(found, "utf8").trim();
  if (!text) throw new Error(`prompt file is empty: ${found}`);
  return text;
}

/** Build the `NewJob` for a prompt schedule fire. `entityId` is stable (per-entity serialization). */
export function promptScheduleToNewJob(def: ScheduleDef, promptText: string, lastRun?: number): NewJob {
  const intent = def.intent as unknown as PromptIntent;
  return {
    source: "prompt",
    entityId: `prompt-${branchSlug(def.name)}`,
    entityRef: def.name,
    triggerType: "scheduled-prompt",
    // Unique per fire so each tick is its own job (the stable entityId still serializes them).
    contentHash: `${def.name}:${lastRun ?? "first"}:${Date.now()}`,
    repo: intent.repo,
    runner: intent.runner,
    model: intent.model,
    customPrompt: promptText,
  };
}

/**
 * Resolve a prompt `ScheduleDef` into a ready-to-enqueue `NewJob`: find its repo, read the `.md`, and
 * assemble the job. Used by both the daemon's fire handler and `milo prompt <name>`. Throws on an
 * unknown repo or a missing/empty prompt file.
 */
export function resolvePromptScheduleJob(config: MiloConfig, def: ScheduleDef, lastRun?: number): NewJob {
  const intent = def.intent as unknown as PromptIntent;
  const repo = resolveRepoByName(config, intent.repo);
  if (!repo) throw new Error(`prompt schedule "${def.name}" references unknown repo "${intent.repo}"`);
  return promptScheduleToNewJob(def, loadSchedulePrompt(intent, repo), lastRun);
}
