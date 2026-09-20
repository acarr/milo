import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { logger } from "./logger.js";

/**
 * Per-repo Milo configuration: `<repo>/.milo/config.json`.
 *
 * This is the repo's half of the contract — it lives IN the repository (next to
 * `.milo/schedules.json`) so the people who own the codebase own how Milo works on it: which
 * workflow text drives the agent, what labels its PRs carry, what verification the gate runs
 * before a job may be marked `done`, and which model handles which class of ticket. It is re-read
 * at the start of every job, so edits land without a daemon restart.
 *
 * Everything is optional. A repo with no `.milo/config.json` behaves exactly as before (built-in
 * prompt text, no verify gate, no labels), which keeps other repos untouched.
 */

/** Path (relative to a repo's working tree) of its Milo config. */
export const REPO_CONFIG_FILE = ".milo/config.json";

/** Default wall-clock cap for one verify command (20 minutes). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60_000;

const WorkflowsSchema = z
  .object({
    /** Phase body for a Linear-issue (create-mode) run. Path relative to `<repo>/.milo/`. */
    linearIssue: z.string().nullable().optional(),
    /** Phase body for attach mode (an existing PR, or a Linear revision). */
    attach: z.string().nullable().optional(),
    /** Phase body for a scheduled-prompt run. */
    schedule: z.string().nullable().optional(),
  })
  .default({});

const VerifyByPathSchema = z.object({
  /** Globs (`**`, `*`, `?`) matched against `git diff --name-only origin/<base>...HEAD`. */
  paths: z.array(z.string()).min(1),
  command: z.string().min(1),
});

const ModelSchema = z
  .object({
    /** Model for every run in this repo unless a label says otherwise. */
    default: z.string().nullable().optional(),
    /** `{ "class:chore": "sonnet" }` — the FIRST issue label with an entry wins. */
    byLabel: z.record(z.string(), z.string()).default({}),
  })
  .default({});

export const RepoMiloConfigSchema = z.object({
  version: z.literal(1).default(1),
  workflows: WorkflowsSchema,
  /** Labels applied to every PR Milo opens in this repo (both the model's and the gate's). */
  labels: z.array(z.string()).default([]),
  /** Copy any Linear label matching `^class:` onto the PR. */
  classLabelFromTicket: z.boolean().default(false),
  /** Shell command the verification gate runs in the worktree before a job can be `done`. */
  verifyCommand: z.string().nullable().optional(),
  /** Extra verify commands, each run only when the diff touches one of its globs. */
  verifyByPath: z.array(VerifyByPathSchema).default([]),
  /** Per-command wall-clock cap. */
  verifyTimeoutMs: z.number().int().positive().default(DEFAULT_VERIFY_TIMEOUT_MS),
  model: ModelSchema,
  /** Passed to the runner as `--max-turns` when set. */
  maxTurns: z.number().int().positive().nullable().optional(),
});
export type RepoMiloConfig = z.infer<typeof RepoMiloConfigSchema>;

/** The three workflow bodies, already read from disk (undefined = use the built-in text). */
export interface WorkflowTexts {
  linearIssue?: string;
  attach?: string;
  schedule?: string;
}

export interface ResolvedRepoConfig {
  config: RepoMiloConfig;
  workflows: WorkflowTexts;
  /** Where the config came from — undefined when the repo has no `.milo/config.json`. */
  path?: string;
}

/** The defaults a repo with no `.milo/config.json` gets — i.e. exactly today's behaviour. */
export function defaultRepoConfig(): ResolvedRepoConfig {
  return { config: RepoMiloConfigSchema.parse({}), workflows: {} };
}

/**
 * Resolve a workflow file path the same way `repo-schedules.ts` resolves `promptFile`: an absolute
 * path is used as-is; a relative one is tried under `<repo>/.milo/` first, then `<repo>/`.
 */
export function resolveWorkflowPath(repoPath: string, file: string): string | undefined {
  const candidates = isAbsolute(file) ? [file] : [join(repoPath, ".milo", file), join(repoPath, file)];
  return candidates.find((p) => existsSync(p));
}

/** Read one workflow file; throws when it can't be found or is empty. */
export function loadWorkflow(repoPath: string, file: string): string {
  const found = resolveWorkflowPath(repoPath, file);
  if (!found) throw new Error(`workflow file not found: ${file} (looked under ${join(repoPath, ".milo")} and ${repoPath})`);
  const text = readFileSync(found, "utf8").trim();
  if (!text) throw new Error(`workflow file is empty: ${found}`);
  return text;
}

/**
 * Read and validate `<repo>/.milo/config.json` plus the workflow files it points at. Throws on a
 * malformed config or a missing workflow — the strict form, for `milo prompt` dry runs where the
 * user wants to see the problem. Returns the defaults when the file simply doesn't exist.
 */
export function readRepoConfig(repoPath: string): ResolvedRepoConfig {
  const file = join(repoPath, REPO_CONFIG_FILE);
  if (!existsSync(file)) return defaultRepoConfig();
  const config = RepoMiloConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const workflows: WorkflowTexts = {};
  for (const key of ["linearIssue", "attach", "schedule"] as const) {
    const ref = config.workflows[key];
    if (ref) workflows[key] = loadWorkflow(repoPath, ref);
  }
  return { config, workflows, path: file };
}

/**
 * The forgiving form used at job start: a malformed config or a missing workflow file is logged and
 * that piece falls back to the default (built-in text / no gate), never crashing the job. Called
 * per job, so edits to the file take effect on the next run without a restart.
 */
export function getRepoConfig(repoPath: string): ResolvedRepoConfig {
  const file = join(repoPath, REPO_CONFIG_FILE);
  if (!existsSync(file)) return defaultRepoConfig();
  let config: RepoMiloConfig;
  try {
    config = RepoMiloConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    logger.warn({ file, err: (err as Error).message }, "invalid .milo/config.json — using defaults for this repo");
    return defaultRepoConfig();
  }
  const workflows: WorkflowTexts = {};
  for (const key of ["linearIssue", "attach", "schedule"] as const) {
    const ref = config.workflows[key];
    if (!ref) continue;
    try {
      workflows[key] = loadWorkflow(repoPath, ref);
    } catch (err) {
      logger.warn({ file, workflow: key, err: (err as Error).message }, "workflow file unusable — using the built-in text");
    }
  }
  return { config, workflows, path: file };
}

/**
 * Substitute `{{PLACEHOLDER}}` tokens in a workflow body. Only keys present in `vars` are replaced;
 * anything else (`{{SOMETHING_ELSE}}`) is left exactly as written, so a workflow can carry its own
 * templating for other tools without Milo eating it.
 */
export function renderWorkflow(text: string, vars: Record<string, string | number | undefined>): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key: string) => {
    const v = vars[key];
    return v === undefined ? whole : String(v);
  });
}

/** Case-insensitive match for Linear "class" labels (`class:chore`, `class:feature`, …). */
const CLASS_LABEL = /^class:/i;

/**
 * The labels a PR for this issue should carry: the repo's fixed `labels` plus, when
 * `classLabelFromTicket` is on, every `class:*` label from the ticket. De-duplicated, order kept.
 */
export function prLabelsFor(config: RepoMiloConfig, issueLabels: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (l: string) => {
    const t = l.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  for (const l of config.labels) push(l);
  if (config.classLabelFromTicket) for (const l of issueLabels) if (CLASS_LABEL.test(l.trim())) push(l);
  return out;
}

/**
 * The repo's model override for an issue: the first issue label (in the issue's order) with a
 * `model.byLabel` entry wins, else `model.default`, else undefined (= the global runner chain).
 * Label matching is case-insensitive.
 */
export function modelOverrideFor(config: RepoMiloConfig, issueLabels: string[] = []): string | undefined {
  const byLabel = new Map(Object.entries(config.model.byLabel).map(([k, v]) => [k.toLowerCase().trim(), v]));
  for (const l of issueLabels) {
    const m = byLabel.get(l.toLowerCase().trim());
    if (m) return m;
  }
  return config.model.default ?? undefined;
}

/**
 * Minimal glob → RegExp: a double star spans directories, `*` and `?` stay within one path
 * segment. Enough for "packages/ios/ + double star" and "double star + .swift" patterns without
 * pulling in a dependency (and without Node's experimental `path.matchesGlob`, which prints a
 * warning on every call under Node 22).
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches the rest.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Does any of `files` match any of `globs`? */
export function anyPathMatches(globs: string[], files: string[]): boolean {
  const res = globs.map(globToRegExp);
  return files.some((f) => res.some((r) => r.test(f)));
}

export interface VerifyPlan {
  command: string;
  /** Why this command runs — `verifyCommand`, or the glob group that matched. */
  reason: string;
}

/**
 * The verify commands the gate should run for a change set: `verifyCommand` always (when set), plus
 * each `verifyByPath` entry whose globs match at least one changed file. Duplicate commands run once.
 */
export function verifyCommandsFor(config: RepoMiloConfig, changedFiles: string[]): VerifyPlan[] {
  const plan: VerifyPlan[] = [];
  const seen = new Set<string>();
  const add = (command: string, reason: string) => {
    const c = command.trim();
    if (!c || seen.has(c)) return;
    seen.add(c);
    plan.push({ command: c, reason });
  };
  if (config.verifyCommand) add(config.verifyCommand, "verifyCommand");
  for (const entry of config.verifyByPath) {
    if (anyPathMatches(entry.paths, changedFiles)) add(entry.command, `verifyByPath ${entry.paths.join(", ")}`);
  }
  return plan;
}
