/**
 * The shared CLI "view-model" / client — one seam that both the plain commands (`run.ts`) and the
 * interactive TUI (`ui.tsx` + `views/`) consume, so data access and aggregation live in exactly one
 * place and the views stay thin (the k9s lesson: thin views over one client library).
 *
 * It lives in `@milo/cli` rather than `@milo/core` on purpose: the composed client reaches into
 * `@milo/daemon` (schedules / poll / daemon control) and `@milo/runners`, and importing those into
 * `core` would create a dependency cycle. Pure persistence stays in `core`'s `JobStore`; the CLI is
 * the only package that already depends on all three.
 *
 * Reads are synchronous (better-sqlite3) and cheap enough for the TUI's 1s poll. Methods that need
 * config or the daemon package load them lazily so job/daemon reads work even before `milo init`.
 */
import { existsSync } from "node:fs";
import {
  loadConfig,
  openDatabase,
  JobStore,
  isDaemonRunning,
  readDaemon,
  ACTIVE_STATES,
  TERMINAL_STATES,
  eventsLogPath,
  readEvents,
  tailEvents,
  type Job,
  type JobState,
  type JobDependency,
  type RepoHealth,
  type MiloConfig,
  type PersistedEvent,
} from "@milo/core";

type Db = ReturnType<typeof openDatabase>;

/** A pseudo-state expands to a set of real states; otherwise it's an exact `JobState` match. */
export type StateFilter = JobState | "active" | "terminal";

export interface JobsFilter {
  state?: StateFilter;
  repo?: string;
  runner?: string;
  source?: string;
  /** Case-insensitive substring over ref/entityId/summary/prUrl/branch/repo. */
  search?: string;
  limit?: number;
}

/** A denormalized row both the text presenters and the Ink list render directly. */
export interface JobRow {
  id: string;
  ref: string;
  state: JobState;
  source: string;
  runner: string | null;
  repo: string;
  prUrl: string | null;
  detail: string | null;
  ageMs: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
}

export interface JobEventRow {
  seq: number;
  kind: string;
  from: string | null;
  to: string | null;
  at: number;
  data: string;
}

export interface JobDetail {
  job: Job;
  events: JobEventRow[];
  dependencies: JobDependency[];
  /** Whether a normalized transcript file exists on disk (the live/replayable agent stream). */
  hasTranscript: boolean;
  transcriptPath: string;
  /** The raw runner stream-json log, if recorded (set once a job reaches `running`). */
  runnerLogPath: string | null;
}

export interface ScheduleViewRow {
  name: string;
  cron: string;
  kind: string;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
}

export interface SchedulesView {
  rows: ScheduleViewRow[];
  recent: { name: string; kind: string; detail: string | null; at: number }[];
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  counts: Record<string, number>;
}

export interface RepoHealthRow extends RepoHealth {
  open: boolean;
}
export interface RepoHealthView {
  rows: RepoHealthRow[];
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MiloClient {
  jobs(filter?: JobsFilter): JobRow[];
  job(id: string): JobDetail | undefined;
  /** Resolve the most recent job for a Linear/GitHub entity ref (e.g. "SBX-1") or a job id. */
  resolveJob(ref: string): Job | undefined;
  /** Replay a job's persisted transcript (normalized runner events). */
  readTranscript(jobId: string): PersistedEvent[];
  /** Subscribe to a job's transcript: replays existing events, then streams appends. Returns unsubscribe. */
  tailTranscript(jobId: string, onEvent: (e: PersistedEvent) => void): () => void;
  daemon(): DaemonStatus;
  repoHealth(): RepoHealthView;
  schedules(): Promise<SchedulesView>;
  /** Run one Linear+GitHub poll pass, enqueuing any new work. */
  pollNow(): Promise<ActionResult<{ linear: number; github: number }>>;
  /** Run a scheduled prompt now by (possibly namespaced) name. */
  runPrompt(name: string): Promise<ActionResult<{ jobId: string; disposition: string }>>;
  /** Re-run a finished job as a new job (revises the existing PR for shipped Linear/GitHub work). */
  rerun(jobId: string): ActionResult<Job>;
  /** Retry a failed/needs-attention/abandoned job in place. */
  retry(jobId: string): ActionResult<Job>;
  /**
   * Cancel a job: a `queued` one is finalized immediately; an in-flight one gets a cancel request
   * its worker honors (kills the runner, skips the verification gate). Already-terminal → error.
   */
  cancel(jobId: string): ActionResult<"cancelled" | "cancel-requested">;
  /** The underlying store, for callers that need a method this client doesn't yet wrap. */
  readonly store: JobStore;
  config(): MiloConfig | undefined;
  close(): void;
}

function matchesState(j: Job, want?: StateFilter): boolean {
  if (!want) return true;
  if (want === "active") return (ACTIVE_STATES as string[]).includes(j.state);
  if (want === "terminal") return (TERMINAL_STATES as string[]).includes(j.state);
  return j.state === want;
}

function matchesSearch(j: Job, q?: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [j.entityRef, j.entityId, j.summary, j.prUrl, j.branch, j.repo]
    .some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
}

function toRow(j: Job, now: number): JobRow {
  return {
    id: j.id,
    ref: j.entityRef ?? j.entityId,
    state: j.state,
    source: j.source,
    runner: j.runner,
    repo: j.repo,
    prUrl: j.prUrl,
    detail: j.prUrl ?? j.failureDetail ?? j.summary ?? null,
    ageMs: now - j.createdAt,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    cancelRequested: j.cancelRequested,
  };
}

export function createClient(opts: { store?: JobStore; db?: Db; config?: MiloConfig } = {}): MiloClient {
  let db: Db | undefined;
  let ownsDb = false;
  let store = opts.store;
  if (!store) {
    db = opts.db ?? openDatabase();
    ownsDb = opts.db === undefined;
    store = new JobStore(db);
  }
  const theStore = store;

  let cfg = opts.config;
  let cfgTried = false;
  const getConfig = (): MiloConfig | undefined => {
    if (cfg || cfgTried) return cfg;
    cfgTried = true;
    try {
      cfg = loadConfig().config;
    } catch {
      cfg = undefined;
    }
    return cfg;
  };

  return {
    store: theStore,
    config: getConfig,

    jobs(filter = {}): JobRow[] {
      const all = theStore.list({ limit: 1000 });
      const now = Date.now();
      const matched = all.filter(
        (j) =>
          matchesState(j, filter.state) &&
          (!filter.repo || j.repo === filter.repo) &&
          (!filter.runner || j.runner === filter.runner) &&
          (!filter.source || j.source === filter.source) &&
          matchesSearch(j, filter.search),
      );
      return matched.slice(0, filter.limit ?? 200).map((j) => toRow(j, now));
    },

    job(id): JobDetail | undefined {
      const job = theStore.get(id);
      if (!job) return undefined;
      const transcriptPath = job.eventsLog ?? eventsLogPath(job.id);
      return {
        job,
        events: theStore.events(id, 50),
        dependencies: theStore.dependenciesFor(job.entityId),
        transcriptPath,
        hasTranscript: existsSync(transcriptPath),
        runnerLogPath: job.runnerLog,
      };
    },

    resolveJob(ref): Job | undefined {
      return theStore.get(ref) ?? theStore.latestJobForEntity(ref);
    },

    readTranscript(jobId): PersistedEvent[] {
      return readEvents(jobId);
    },

    tailTranscript(jobId, onEvent): () => void {
      return tailEvents(jobId, onEvent);
    },

    rerun(jobId): ActionResult<Job> {
      try {
        return { ok: true, value: theStore.rerun(jobId) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    retry(jobId): ActionResult<Job> {
      try {
        return { ok: true, value: theStore.retry(jobId) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async pollNow(): Promise<ActionResult<{ linear: number; github: number }>> {
      const config = getConfig();
      if (!config) return { ok: false, error: "no config" };
      try {
        const { LinearClient } = await import("@milo/core");
        const { pollOnce } = await import("@milo/daemon");
        const linear = LinearClient.fromConfig();
        const value = await pollOnce({ config, store: theStore, linear });
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async runPrompt(name): Promise<ActionResult<{ jobId: string; disposition: string }>> {
      const config = getConfig();
      if (!config) return { ok: false, error: "no config" };
      try {
        const { effectiveSchedules } = await import("@milo/daemon");
        const { resolvePromptScheduleJob } = await import("@milo/core");
        const defs = effectiveSchedules(config).filter((d) => (d.intent?.["kind"] as string) === "prompt");
        const matches = defs.filter((d) => d.name === name || d.name.endsWith(`:${name}`));
        if (matches.length === 0) return { ok: false, error: `no prompt schedule "${name}"` };
        if (matches.length > 1) return { ok: false, error: `"${name}" is ambiguous` };
        const def = matches[0]!;
        const res = theStore.enqueue(resolvePromptScheduleJob(config, def, theStore.lastScheduleRun(def.name)));
        theStore.recordScheduleRun(def.name, "prompt", `${res.disposition} ${res.job.id} (manual)`);
        return { ok: true, value: { jobId: res.job.id, disposition: res.disposition } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    cancel(jobId): ActionResult<"cancelled" | "cancel-requested"> {
      const j = theStore.get(jobId);
      if (!j) return { ok: false, error: `no job ${jobId}` };
      if ((TERMINAL_STATES as string[]).includes(j.state)) return { ok: false, error: `job already ${j.state}` };
      if (j.state === "queued") {
        theStore.cancelQueued(jobId);
        return { ok: true, value: "cancelled" };
      }
      theStore.requestCancel(jobId);
      return { ok: true, value: "cancel-requested" };
    },

    daemon(): DaemonStatus {
      const info = readDaemon();
      return {
        running: isDaemonRunning(),
        pid: info?.pid,
        startedAt: info?.startedAt,
        counts: theStore.countByState(),
      };
    },

    repoHealth(): RepoHealthView {
      const config = getConfig();
      const rows = (config?.repositories ?? []).map((r) => {
        const h = theStore.repoHealth(r.name);
        return { ...h, open: h.breakerState === "open" };
      });
      return { rows };
    },

    async schedules(): Promise<SchedulesView> {
      const config = getConfig();
      if (!config) return { rows: [], recent: [] };
      const { effectiveSchedules } = await import("@milo/daemon");
      const { Scheduler } = await import("@milo/core");
      const defs = effectiveSchedules(config);
      const rows: ScheduleViewRow[] = defs.map((d) => ({
        name: d.name,
        cron: d.cron,
        kind: (d.intent?.["kind"] as string) ?? "prompt",
        enabled: d.enabled,
        nextRun: d.enabled ? Scheduler.nextRun(d.cron) : null,
        lastRun: theStore.lastScheduleRun(d.name) ?? null,
      }));
      return { rows, recent: theStore.listScheduleRuns(10) };
    },

    close(): void {
      if (ownsDb) db?.close();
    },
  };
}
