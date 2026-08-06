import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { DB } from "./store.js";

export type JobState =
  | "queued"
  | "claimed"
  | "setting-up"
  | "running"
  | "remote-waiting"
  | "verifying"
  | "remediating"
  | "reporting"
  | "done"
  | "discovery-done"
  | "retrying"
  | "failed"
  | "needs-attention"
  | "cancelled"
  | "abandoned";

export const TERMINAL_STATES: JobState[] = [
  "done",
  "discovery-done",
  "failed",
  "needs-attention",
  "cancelled",
  "abandoned",
];

/**
 * States that consume a **local concurrency slot** — i.e. a worker on this machine is actively
 * doing something. Note this deliberately EXCLUDES `remote-waiting`: a job parked on a Conductor
 * Cloud session is using no local CPU, disk, or process, so holding one of the (default 3) local
 * slots for the hour it takes would starve real local work.
 */
export const SLOT_STATES: JobState[] = [
  "claimed",
  "setting-up",
  "running",
  "verifying",
  "remediating",
  "reporting",
];

/**
 * States that hold the **per-entity lock** — a superset of {@link SLOT_STATES}. A job parked on a
 * remote session still owns its ticket: a second delegation for the same issue must not spin up a
 * second cloud workspace just because the first one is waiting rather than working.
 */
export const ENTITY_LOCK_STATES: JobState[] = [...SLOT_STATES, "remote-waiting"];

/**
 * Every non-terminal, in-flight state. Kept as the historical name so TUI/CLI "active" filters keep
 * meaning "this job is in flight", which is what a human expects to see.
 */
export const ACTIVE_STATES: JobState[] = ENTITY_LOCK_STATES;

export type JobSource = "linear" | "github" | "schedule" | "cli" | "prompt";

export interface NewJob {
  source: JobSource;
  entityId: string; // stable per-source id; for Linear, the issue identifier (SBX-1)
  entityRef?: string;
  triggerType: string; // issue.start | issue.comment | pr.review | scheduled | ...
  contentHash?: string; // defaults to entityId (one "start" per entity)
  mode?: "create" | "attach";
  repo: string;
  runner?: string;
  model?: string;
  /**
   * A self-contained instruction for a `source: "prompt"` job (a scheduled prompt). When set, the
   * pipeline runs this text directly instead of fetching a Linear issue / GitHub PR.
   */
  customPrompt?: string;
  maxAttempts?: number;
  /**
   * Collapse this trigger into an in-flight job for the same entity when it would be a *revision*
   * (prior implemented work already exists). Lets one user action that fans out into several distinct
   * signals — e.g. a Linear @mention arriving as BOTH an agent-session delegation (webhook) and an
   * `@milo` comment (poll) — produce a single revise run instead of two. Set by the transports for
   * Linear intents; ignored for first-time work (no prior PR → nothing to collapse against).
   */
  dedupeIfEntityActive?: boolean;
  /**
   * Hold the job back from claiming until this timestamp (ms epoch) — a dependency-discovery
   * window (MILO-15): gives `syncDependencies` time to record `blockedBy` edges before the queue
   * can claim the job. Discovery clears the hold early (`clearEnqueueHold`) once the issue's
   * blockers are accounted for; an unclearable hold (Linear outage) just expires into parallel.
   */
  holdUntil?: number;
}

export interface Job {
  id: string;
  identityKey: string;
  source: JobSource;
  entityId: string;
  entityRef: string | null;
  triggerType: string;
  contentHash: string;
  state: JobState;
  mode: string;
  runner: string | null;
  model: string | null;
  customPrompt: string | null;
  repo: string;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  attempts: number;
  maxAttempts: number;
  nextEligibleAt: number | null;
  declaredOutcome: string | null;
  declaredPrUrl: string | null;
  verifiedOutcome: string | null;
  prUrl: string | null;
  failureClass: string | null;
  failureDetail: string | null;
  summary: string | null;
  /** Path to the per-job normalized transcript (`<jobId>.events.jsonl`), set at `running`. */
  eventsLog: string | null;
  /** Path to the raw runner stream-json log, set at `running`. */
  runnerLog: string | null;
  /** Out-of-band cancel signal: set true by the CLI/TUI, polled by the running worker. */
  cancelRequested: boolean;
  cancelRequestedAt: number | null;
  /** Remote-runner session pointers (`conductor`). Null for local runs. */
  remoteProvider: string | null;
  remoteWorkspaceId: string | null;
  remoteSessionId: string | null;
  /** Deep link to the remote workspace — the "where is my work" answer for a human. */
  remoteUrl: string | null;
  /** Last consumed remote transcript message id, so a resume doesn't re-emit history. */
  remoteCursor: string | null;
  /**
   * Whether the remote session was ever observed `working`. Correctness state, not cosmetics: a
   * queued Conductor prompt reports `idle` until its turn starts, so without this latch a resumed
   * job would see that `idle` and wrongly conclude the run had finished.
   */
  remoteSawWorking: boolean;
  /** Last tracker poll of a parked remote job — the liveness signal for `reclaimStalledRemote`. */
  remotePolledAt: number | null;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
}

export interface EnqueueResult {
  job: Job;
  disposition: "created" | "deduped" | "requeued";
}

export interface RepoHealth {
  repo: string;
  consecutiveInfraFailures: number;
  breakerState: "closed" | "open" | "half-open";
  openedAt: number | null;
  cooldownUntil: number | null;
}

export type DependencyStrategy = "wait" | "stacked";

/** A recorded Linear `blockedBy` relation that gates the dependent until resolved (MILO-4). */
export interface JobDependency {
  dependentEntityId: string;
  blockerEntityId: string;
  strategy: DependencyStrategy;
  resolved: boolean;
  blockerBranch: string | null;
}

const ROW_TO_DEP = (r: any): JobDependency => ({
  dependentEntityId: r.dependent_entity_id,
  blockerEntityId: r.blocker_entity_id,
  strategy: r.strategy,
  resolved: !!r.resolved,
  blockerBranch: r.blocker_branch,
});

function identityKey(source: string, entityId: string, triggerType: string, contentHash: string): string {
  return createHash("sha256")
    .update(`${source}:${entityId}:${triggerType}:${contentHash}`)
    .digest("hex")
    .slice(0, 32);
}

const ROW_TO_JOB = (r: any): Job => ({
  id: r.id,
  identityKey: r.identity_key,
  source: r.source,
  entityId: r.entity_id,
  entityRef: r.entity_ref,
  triggerType: r.trigger_type,
  contentHash: r.content_hash,
  state: r.state,
  mode: r.mode,
  runner: r.runner,
  model: r.model,
  customPrompt: r.custom_prompt,
  repo: r.repo,
  worktreePath: r.worktree_path,
  branch: r.branch,
  baseBranch: r.base_branch,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  nextEligibleAt: r.next_eligible_at,
  declaredOutcome: r.declared_outcome,
  declaredPrUrl: r.declared_pr_url,
  verifiedOutcome: r.verified_outcome,
  prUrl: r.pr_url,
  failureClass: r.failure_class,
  failureDetail: r.failure_detail,
  summary: r.summary,
  eventsLog: r.events_log ?? null,
  runnerLog: r.runner_log ?? null,
  cancelRequested: !!r.cancel_requested,
  cancelRequestedAt: r.cancel_requested_at ?? null,
  remoteProvider: r.remote_provider ?? null,
  remoteWorkspaceId: r.remote_workspace_id ?? null,
  remoteSessionId: r.remote_session_id ?? null,
  remoteUrl: r.remote_url ?? null,
  remoteCursor: r.remote_cursor ?? null,
  remoteSawWorking: !!r.remote_saw_working,
  remotePolledAt: r.remote_polled_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  terminalAt: r.terminal_at,
});

/** Persistence + lifecycle for jobs. The SQLite DB is the source of truth (durable across restarts). */
export class JobStore {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Idempotent enqueue: a re-delivered/duplicate trigger collapses to the existing job. */
  enqueue(j: NewJob): EnqueueResult {
    const contentHash = j.contentHash ?? j.entityId;
    const key = identityKey(j.source, j.entityId, j.triggerType, contentHash);
    const existing = this.db
      .prepare("SELECT * FROM jobs WHERE identity_key = ?")
      .get(key) as any;

    if (existing) {
      const job = ROW_TO_JOB(existing);
      if (!TERMINAL_STATES.includes(job.state)) return { job, disposition: "deduped" };
      // Terminal + same content already handled — dedupe (don't re-run a completed start).
      return { job, disposition: "deduped" };
    }

    // Cross-signal revision dedupe: when this trigger would revise existing work (a prior PR exists)
    // and another job for the same entity is already in flight, collapse into it rather than stacking
    // a second revise run. Only fires in the revise phase — first-time work has no prior PR.
    if (j.dedupeIfEntityActive && this.lastImplementedForEntity(j.entityId)) {
      const active = this.activeJobForEntity(j.entityId);
      if (active) return { job: active, disposition: "deduped" };
    }

    const t = this.now();
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO jobs (id, identity_key, source, entity_id, entity_ref, trigger_type, content_hash,
           state, mode, runner, model, custom_prompt, repo, max_attempts, next_eligible_at,
           created_at, updated_at)
         VALUES (@id,@identity_key,@source,@entity_id,@entity_ref,@trigger_type,@content_hash,
           'queued',@mode,@runner,@model,@custom_prompt,@repo,@max_attempts,@next_eligible_at,@t,@t)`,
      )
      .run({
        id,
        identity_key: key,
        source: j.source,
        entity_id: j.entityId,
        entity_ref: j.entityRef ?? j.entityId,
        trigger_type: j.triggerType,
        content_hash: contentHash,
        mode: j.mode ?? "create",
        runner: j.runner ?? null,
        model: j.model ?? null,
        custom_prompt: j.customPrompt ?? null,
        repo: j.repo,
        max_attempts: j.maxAttempts ?? 3,
        next_eligible_at: j.holdUntil ?? null,
        t,
      });
    this.recordEvent(id, "state_change", { from: null, to: "queued" });
    return { job: this.get(id)!, disposition: "created" };
  }

  get(id: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    return r ? ROW_TO_JOB(r) : undefined;
  }

  list(filter?: { state?: JobState; limit?: number }): Job[] {
    const limit = filter?.limit ?? 100;
    const rows = filter?.state
      ? this.db.prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?").all(filter.state, limit)
      : this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as any[]).map(ROW_TO_JOB);
  }

  /**
   * The most recent completed job for an entity that produced a PR — i.e. the existing branch/PR a
   * follow-up should attach to. Returns undefined when the entity has no prior implemented work
   * (so the caller falls back to create mode). Used to turn a `@milo` comment / re-delegation into a
   * revision of the same branch instead of a second PR.
   */
  lastImplementedForEntity(entityId: string): { branch: string; baseBranch: string; prUrl: string } | undefined {
    const r = this.db
      .prepare(
        `SELECT branch, base_branch, pr_url FROM jobs
           WHERE entity_id = ? AND pr_url IS NOT NULL AND branch IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get(entityId) as any;
    if (!r) return undefined;
    return { branch: r.branch, baseBranch: r.base_branch ?? "main", prUrl: r.pr_url };
  }

  /** The most recent non-terminal (in-flight or queued) job for an entity, if any. */
  activeJobForEntity(entityId: string): Job | undefined {
    const placeholders = TERMINAL_STATES.map(() => "?").join(",");
    const r = this.db
      .prepare(
        `SELECT * FROM jobs WHERE entity_id = ? AND state NOT IN (${placeholders})
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get(entityId, ...TERMINAL_STATES) as any;
    return r ? ROW_TO_JOB(r) : undefined;
  }

  /** Worktree paths belonging to jobs that are NOT terminal — must not be pruned. */
  activeWorktreePaths(): Set<string> {
    const placeholders = TERMINAL_STATES.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT DISTINCT worktree_path FROM jobs WHERE worktree_path IS NOT NULL AND state NOT IN (${placeholders})`)
      .all(...TERMINAL_STATES) as any[];
    return new Set(rows.map((r) => r.worktree_path));
  }

  countByState(): Record<string, number> {
    const rows = this.db.prepare("SELECT state, COUNT(*) c FROM jobs GROUP BY state").all() as any[];
    return Object.fromEntries(rows.map((r) => [r.state, r.c]));
  }

  /**
   * Would a job just enqueued for `entityId` have to WAIT rather than start ~immediately? True when
   * another run for the same entity is already active (per-entity serialization forces a wait), or
   * when at least `concurrency` other non-terminal jobs are already ahead of it (the cap/queue is
   * full). Call this right AFTER enqueue (the new queued job is counted, then subtracted). Used to
   * decide whether to tell the user their delegation is "queued" — so we never say that for work that
   * actually starts right away. A best-effort snapshot; the claim happens a moment later.
   */
  willQueue(entityId: string, concurrency: number): boolean {
    const entityPlaceholders = ENTITY_LOCK_STATES.map(() => "?").join(",");
    const activeForEntity = this.db
      .prepare(`SELECT 1 FROM jobs WHERE entity_id = ? AND state IN (${entityPlaceholders}) LIMIT 1`)
      .get(entityId, ...ENTITY_LOCK_STATES);
    if (activeForEntity) return true;
    const terminalPlaceholders = TERMINAL_STATES.map(() => "?").join(",");
    // Jobs parked on a remote session are NOT ahead of this one — they hold no local slot. Counting
    // them would tell every local delegation it was "queued" while a Conductor run happened to be
    // waiting, which is exactly the kind of inaccurate status the queued-ack exists to avoid.
    const nonTerminal = (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM jobs WHERE state NOT IN (${terminalPlaceholders}) AND state != 'remote-waiting'`,
        )
        .get(...TERMINAL_STATES) as { c: number }
    ).c;
    // Subtract the just-enqueued job itself; if `concurrency` others are ahead, this one waits.
    return nonTerminal - 1 >= concurrency;
  }

  /**
   * Atomically claim the next runnable job:
   *  - state = queued and eligible (backoff elapsed)
   *  - no OTHER job for the same entity is currently active (per-entity serialization)
   *  - no UNRESOLVED Linear blocker gates this entity (dependency sequencing — MILO-4): a job
   *    whose issue is `blockedBy` an unresolved blocker is held unclaimable until the chosen
   *    strategy resolves it (blocker done for stacked, blocker PR merged for wait).
   * Returns the claimed Job, or undefined if nothing is runnable right now.
   */
  claimNext(owner: string, leaseMs = 120_000): Job | undefined {
    const t = this.now();
    // ENTITY_LOCK_STATES, not SLOT_STATES: a job parked on a remote session still owns its ticket.
    const active = `('${ENTITY_LOCK_STATES.join("','")}')`;
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
             WHERE state = 'queued'
               AND (next_eligible_at IS NULL OR next_eligible_at <= @t)
               AND entity_id NOT IN (SELECT entity_id FROM jobs WHERE state IN ${active})
               AND entity_id NOT IN (SELECT dependent_entity_id FROM job_dependencies WHERE resolved = 0)
             ORDER BY created_at ASC
             LIMIT 1`,
        )
        .get({ t }) as any;
      if (!row) return undefined;
      this.db
        .prepare(
          `UPDATE jobs SET state='claimed', lease_owner=@owner, lease_expires_at=@exp,
             last_heartbeat_at=@t, updated_at=@t WHERE id=@id AND state='queued'`,
        )
        .run({ owner, exp: t + leaseMs, t, id: row.id });
      return ROW_TO_JOB({ ...row, state: "claimed" });
    });
    const job = tx() as Job | undefined;
    if (job) this.recordEvent(job.id, "state_change", { from: "queued", to: "claimed" });
    return job;
  }

  /** Transition a job to a new state, merging optional column updates. */
  transition(id: string, to: JobState, fields: Partial<Record<string, unknown>> = {}): void {
    const t = this.now();
    const from = (this.db.prepare("SELECT state FROM jobs WHERE id=?").get(id) as any)?.state ?? null;
    const sets = ["state=@to", "updated_at=@t"];
    if (TERMINAL_STATES.includes(to)) sets.push("terminal_at=@t");
    const params: Record<string, unknown> = { id, to, t };
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k}=@${k}`);
      params[k] = v;
    }
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id=@id`).run(params);
    this.recordEvent(id, "state_change", { from, to, ...fields });
  }

  /**
   * Re-run a job from scratch as a BRAND-NEW job (e.g. a user hit "rerun" on a finished one). We
   * can't route through `enqueue()` — its identity-key dedupe (including for terminal jobs) would
   * just hand back the original. So insert directly with a fresh `:rerun:<ulid>` content-hash nonce,
   * which makes the identity key unique. Everything that drives the create-vs-attach decision
   * (source/entityId/triggerType/runner/repo/customPrompt) is preserved, so a rerun of a shipped
   * ticket revises its existing PR exactly as a fresh trigger would — never a duplicate PR.
   */
  rerun(jobId: string): Job {
    const src = this.get(jobId);
    if (!src) throw new Error(`no job ${jobId}`);
    const t = this.now();
    const id = ulid();
    const contentHash = `${src.contentHash}:rerun:${id}`;
    const key = identityKey(src.source, src.entityId, src.triggerType, contentHash);
    this.db
      .prepare(
        `INSERT INTO jobs (id, identity_key, source, entity_id, entity_ref, trigger_type, content_hash,
           state, mode, runner, model, custom_prompt, repo, max_attempts, created_at, updated_at)
         VALUES (@id,@identity_key,@source,@entity_id,@entity_ref,@trigger_type,@content_hash,
           'queued',@mode,@runner,@model,@custom_prompt,@repo,@max_attempts,@t,@t)`,
      )
      .run({
        id,
        identity_key: key,
        source: src.source,
        entity_id: src.entityId,
        entity_ref: src.entityRef ?? src.entityId,
        trigger_type: src.triggerType,
        content_hash: contentHash,
        mode: src.mode,
        runner: src.runner,
        model: src.model,
        custom_prompt: src.customPrompt,
        repo: src.repo,
        max_attempts: src.maxAttempts,
        t,
      });
    this.recordEvent(id, "state_change", { from: null, to: "queued", rerunOf: jobId });
    return this.get(id)!;
  }

  /**
   * Retry a failed/needs-attention/abandoned job IN PLACE: reset the same row to queued (attempts
   * back to 0, clearing the lease/backoff/failure). Sidesteps identity-key dedupe entirely since
   * it mutates the existing row. For a job that already finished successfully, use `rerun`.
   */
  retry(jobId: string): Job {
    const j = this.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    if (!["failed", "needs-attention", "abandoned"].includes(j.state)) {
      throw new Error(`job ${jobId} is ${j.state}, not retryable (use rerun to re-run a finished job)`);
    }
    this.db
      .prepare(
        // Same reasoning as scheduleRetry: a manual retry starts a fresh remote session. The
        // workspace id is kept so the runner can reuse the warm clone instead of re-cloning.
        `UPDATE jobs SET state='queued', attempts=0, next_eligible_at=NULL, lease_owner=NULL,
           lease_expires_at=NULL, failure_class=NULL, failure_detail=NULL, terminal_at=NULL,
           cancel_requested=0, cancel_requested_at=NULL,
           remote_session_id=NULL, remote_cursor=NULL, remote_saw_working=NULL, updated_at=@t
         WHERE id=@id`,
      )
      .run({ id: jobId, t: this.now() });
    this.recordEvent(jobId, "state_change", { from: j.state, to: "queued", retried: true });
    return this.get(jobId)!;
  }

  /**
   * Request cancellation of a non-terminal job (CLI/TUI side). Sets an out-of-band flag the running
   * worker polls; the worker itself performs the kill + the terminal `cancelled` transition, so
   * there's no cross-process state fight with the lease owner. No-op on already-terminal jobs.
   */
  requestCancel(jobId: string): void {
    const t = this.now();
    const terminal = `('${TERMINAL_STATES.join("','")}')`;
    const res = this.db
      .prepare(`UPDATE jobs SET cancel_requested=1, cancel_requested_at=@t, updated_at=@t WHERE id=@id AND state NOT IN ${terminal}`)
      .run({ t, id: jobId });
    if (res.changes > 0) this.recordEvent(jobId, "cancel_requested", {});
  }

  isCancelRequested(jobId: string): boolean {
    const r = this.db.prepare("SELECT cancel_requested FROM jobs WHERE id=?").get(jobId) as any;
    return !!r?.cancel_requested;
  }

  /**
   * Cancel a job that hasn't started yet: a `queued` job has no worker/process, so finalize it
   * straight to `cancelled`. Returns true if it was queued (and is now cancelled), false otherwise
   * (an active job must instead go through `requestCancel` so its worker does the kill).
   */
  cancelQueued(jobId: string): boolean {
    const j = this.get(jobId);
    if (!j || j.state !== "queued") return false;
    this.transition(jobId, "cancelled", { failure_class: "cancelled", failure_detail: "cancelled before it started" });
    return true;
  }

  heartbeat(id: string, leaseMs = 120_000): void {
    const t = this.now();
    this.db
      .prepare("UPDATE jobs SET last_heartbeat_at=@t, lease_expires_at=@exp WHERE id=@id")
      .run({ t, exp: t + leaseMs, id });
  }

  /** Schedule a retry with backoff: back to queued, attempts++, eligible after delayMs. */
  scheduleRetry(id: string, delayMs: number, failureClass: string, detail: string): void {
    const t = this.now();
    const job = this.get(id);
    const attempts = (job?.attempts ?? 0) + 1;
    this.db
      .prepare(
        // Clear the remote session: a retry must start a FRESH remote run. Resuming a session that
        // already failed would just re-observe the failure, and the warm workspace is reused
        // deliberately by the runner (via a new session) rather than by resuming the dead one.
        `UPDATE jobs SET state='queued', attempts=@a, next_eligible_at=@elig,
           failure_class=@fc, failure_detail=@fd, lease_owner=NULL, lease_expires_at=NULL,
           remote_session_id=NULL, remote_cursor=NULL, remote_saw_working=NULL, updated_at=@t
         WHERE id=@id`,
      )
      .run({ a: attempts, elig: t + delayMs, fc: failureClass, fd: detail, t, id });
    this.recordEvent(id, "retry", { attempts, delayMs, failureClass });
  }

  events(jobId: string, limit = 30): { seq: number; kind: string; from: string | null; to: string | null; at: number; data: string }[] {
    const rows = this.db
      .prepare("SELECT seq, kind, from_state, to_state, at, data FROM job_events WHERE job_id=? ORDER BY seq DESC LIMIT ?")
      .all(jobId, limit) as any[];
    return rows
      .map((r) => ({ seq: r.seq, kind: r.kind, from: r.from_state, to: r.to_state, at: r.at, data: r.data }))
      .reverse();
  }

  recordEvent(jobId: string, kind: string, data: Record<string, unknown>): void {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_events WHERE job_id = ?")
      .get(jobId) as any;
    this.db
      .prepare(
        `INSERT INTO job_events (id, job_id, seq, kind, from_state, to_state, data, at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        ulid(),
        jobId,
        seqRow.next,
        kind,
        (data["from"] as string) ?? null,
        (data["to"] as string) ?? null,
        JSON.stringify(data),
        this.now(),
      );
  }

  /**
   * Record an ingress observation (powers the "why didn't it start?" view): what a transport saw
   * and what we did with it (created / deduped / rejected / dropped + reason).
   */
  recordInbound(o: {
    source: string;
    channel: string;
    payload: unknown;
    identityKey?: string;
    jobId?: string;
    disposition: string;
    reason?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO inbound_events (id, source, channel, raw_payload, identity_key, job_id, disposition, reason, received_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ulid(),
        o.source,
        o.channel,
        typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload),
        o.identityKey ?? null,
        o.jobId ?? null,
        o.disposition,
        o.reason ?? null,
        this.now(),
      );
  }

  // ---- Per-repo circuit breaker (stops infinite runs against a broken repo) ----

  /**
   * Current breaker state for a repo, lazily transitioning `open → half-open` once the cooldown
   * has elapsed (so the next job becomes a single probe). Defaults to a healthy `closed` record.
   */
  repoHealth(repo: string): RepoHealth {
    const r = this.db.prepare("SELECT * FROM repo_health WHERE repo = ?").get(repo) as any;
    if (!r) return { repo, consecutiveInfraFailures: 0, breakerState: "closed", openedAt: null, cooldownUntil: null };
    let state = r.breaker_state as RepoHealth["breakerState"];
    if (state === "open" && r.cooldown_until != null && this.now() >= r.cooldown_until) {
      state = "half-open";
      this.db.prepare("UPDATE repo_health SET breaker_state='half-open' WHERE repo=?").run(repo);
    }
    return {
      repo,
      consecutiveInfraFailures: r.consecutive_infra_failures,
      breakerState: state,
      openedAt: r.opened_at,
      cooldownUntil: r.cooldown_until,
    };
  }

  /** True when a repo is in open cooldown — new jobs should be abandoned, not run. */
  isRepoBreakerOpen(repo: string): boolean {
    return this.repoHealth(repo).breakerState === "open";
  }

  /** Record a transient-infra failure; opens the breaker once `threshold` consecutive ones pile up. */
  recordRepoInfraFailure(repo: string, threshold = 5, cooldownMs = 30 * 60_000): RepoHealth {
    const t = this.now();
    const cur = this.repoHealth(repo);
    const failures = cur.consecutiveInfraFailures + 1;
    const open = failures >= threshold || cur.breakerState === "half-open"; // a failed probe re-opens
    this.db
      .prepare(
        `INSERT INTO repo_health (repo, consecutive_infra_failures, breaker_state, opened_at, cooldown_until)
           VALUES (@repo, @f, @state, @opened, @cooldown)
         ON CONFLICT(repo) DO UPDATE SET
           consecutive_infra_failures=@f, breaker_state=@state, opened_at=@opened, cooldown_until=@cooldown`,
      )
      .run({
        repo,
        f: failures,
        state: open ? "open" : "closed",
        opened: open ? t : cur.openedAt,
        cooldown: open ? t + cooldownMs : cur.cooldownUntil,
      });
    return this.repoHealth(repo);
  }

  /** A successful run clears the breaker for a repo. */
  recordRepoSuccess(repo: string): void {
    this.db
      .prepare(
        `INSERT INTO repo_health (repo, consecutive_infra_failures, breaker_state, opened_at, cooldown_until)
           VALUES (?, 0, 'closed', NULL, NULL)
         ON CONFLICT(repo) DO UPDATE SET consecutive_infra_failures=0, breaker_state='closed', opened_at=NULL, cooldown_until=NULL`,
      )
      .run(repo);
  }

  /** Record that a schedule fired (powers `milo schedules` history + last-run display). */
  recordScheduleRun(name: string, kind: string, detail?: string): void {
    this.db
      .prepare("INSERT INTO schedule_runs (id, name, kind, detail, at) VALUES (?,?,?,?,?)")
      .run(ulid(), name, kind, detail ?? null, this.now());
  }

  lastScheduleRun(name: string): number | undefined {
    const r = this.db.prepare("SELECT MAX(at) AS at FROM schedule_runs WHERE name = ?").get(name) as any;
    return r?.at ?? undefined;
  }

  listScheduleRuns(limit = 50): { name: string; kind: string; detail: string | null; at: number }[] {
    return this.db
      .prepare("SELECT name, kind, detail, at FROM schedule_runs ORDER BY at DESC LIMIT ?")
      .all(limit) as any[];
  }

  /** Idempotency ledger for external side effects (PR create, comment, state set). */
  alreadyDid(key: string): string | undefined {
    const r = this.db.prepare("SELECT external_id FROM side_effects WHERE idempotency_key=?").get(key) as any;
    return r ? (r.external_id ?? "") : undefined;
  }

  recordSideEffect(key: string, kind: string, externalId?: string): void {
    this.db
      .prepare(
        "INSERT INTO side_effects (idempotency_key, kind, external_id, created_at) VALUES (?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING",
      )
      .run(key, kind, externalId ?? null, this.now());
  }

  // ---- Dependency sequencing (MILO-4): honor Linear blockedBy relations ----

  /** The most recent job for an entity (any state), used to resolve a blocker's status/branch. */
  latestJobForEntity(entityId: string): Job | undefined {
    const r = this.db
      .prepare("SELECT * FROM jobs WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(entityId) as any;
    return r ? ROW_TO_JOB(r) : undefined;
  }

  /**
   * Record (idempotently) that `dependent` is blocked by `blocker` under a strategy. Re-recording
   * an existing edge leaves its `resolved`/`blocker_branch` untouched — only the strategy refreshes.
   */
  recordDependency(dependent: string, blocker: string, strategy: DependencyStrategy): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO job_dependencies (dependent_entity_id, blocker_entity_id, strategy, resolved, created_at, updated_at)
           VALUES (@dep, @blk, @strategy, 0, @t, @t)
         ON CONFLICT(dependent_entity_id, blocker_entity_id) DO UPDATE SET strategy=@strategy, updated_at=@t`,
      )
      .run({ dep: dependent, blk: blocker, strategy, t });
  }

  dependenciesFor(dependent: string): JobDependency[] {
    const rows = this.db
      .prepare("SELECT * FROM job_dependencies WHERE dependent_entity_id = ?")
      .all(dependent) as any[];
    return rows.map(ROW_TO_DEP);
  }

  /** Every unresolved dependency edge across all dependents (drives the async reconciler). */
  unresolvedDependencies(): JobDependency[] {
    const rows = this.db
      .prepare("SELECT * FROM job_dependencies WHERE resolved = 0")
      .all() as any[];
    return rows.map(ROW_TO_DEP);
  }

  /** Does `entityId` have a recorded dependency on `blocker` (in either resolution state)? */
  hasDependency(dependent: string, blocker: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM job_dependencies WHERE dependent_entity_id = ? AND blocker_entity_id = ?")
        .get(dependent, blocker) !== undefined
    );
  }

  /** Mark a blocker resolved (the gate lifts); records the blocker's head branch for stacked base-off. */
  resolveDependency(dependent: string, blocker: string, blockerBranch?: string | null): void {
    this.db
      .prepare(
        `UPDATE job_dependencies SET resolved = 1, blocker_branch = COALESCE(@branch, blocker_branch), updated_at = @t
           WHERE dependent_entity_id = @dep AND blocker_entity_id = @blk`,
      )
      .run({ dep: dependent, blk: blocker, branch: blockerBranch ?? null, t: this.now() });
  }

  /** Remove a dependency edge entirely (cycle / untrackable blocker → fall back to parallel). */
  dropDependency(dependent: string, blocker: string): void {
    this.db
      .prepare("DELETE FROM job_dependencies WHERE dependent_entity_id = ? AND blocker_entity_id = ?")
      .run(dependent, blocker);
  }

  /**
   * Clear a dependency-discovery hold (MILO-15) so the job becomes claimable as soon as its
   * `blockedBy` edges are recorded (the claimNext gate takes over from there). Only touches
   * never-attempted queued jobs — a retry's backoff also lives in `next_eligible_at` and must
   * never be shortened by discovery.
   */
  clearEnqueueHold(jobId: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET next_eligible_at = NULL, updated_at = @t
           WHERE id = @id AND state = 'queued' AND attempts = 0 AND next_eligible_at IS NOT NULL`,
      )
      .run({ id: jobId, t: this.now() });
  }

  /**
   * For a stacked dependent, the head branch to base its worktree off — the blocker branch from
   * the most recently-resolved stacked edge, or undefined if none (then base off the repo default).
   */
  stackedBaseFor(dependent: string): string | undefined {
    const r = this.db
      .prepare(
        `SELECT blocker_branch FROM job_dependencies
           WHERE dependent_entity_id = ? AND strategy = 'stacked' AND resolved = 1 AND blocker_branch IS NOT NULL
           ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(dependent) as any;
    return r?.blocker_branch ?? undefined;
  }

  /**
   * Watchdog: requeue active jobs whose lease has expired (+ grace). The pipeline heartbeats every
   * 30s through its WHOLE active lifecycle — including the once-blocking worktree setup, now that it's
   * async — so a lapsed lease means the worker is genuinely gone. The lease (120s) + grace (60s) give
   * ~6 missed beats of slack before reclaim, so a transient stall (a GC pause, brief sync work) can't
   * SIGTERM a healthy runner; only a real death does. Returns the number reclaimed.
   */
  /**
   * Park a job on a remote session: it has been dispatched to Conductor Cloud and is now waiting on
   * another machine. Returning from `processJob` in this state frees the local concurrency slot
   * (the queue's cap is in-process `inFlight` accounting), while the per-entity lock is retained.
   */
  parkOnRemote(jobId: string): void {
    const t = this.now();
    this.db
      .prepare(
        `UPDATE jobs SET state='remote-waiting', lease_owner=NULL, lease_expires_at=NULL,
           remote_polled_at=@t, updated_at=@t WHERE id=@id`,
      )
      .run({ t, id: jobId });
    this.recordEvent(jobId, "state_change", { to: "remote-waiting", parked: true });
  }

  /**
   * Claim a parked job for tracking. Unlike {@link claimNext} this does NOT change the state — the
   * job stays `remote-waiting` while its remote session is polled, because that is what is actually
   * true. Exclusivity comes from the lease; `remote_polled_at` is the liveness signal a stalled
   * tracker is detected by.
   */
  claimRemoteWaiting(owner: string, leaseMs = 120_000): Job | undefined {
    const t = this.now();
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          // A cancel-requested job is deliberately still claimable: the tracker is the only thing
          // that can reach the remote session to cancel it and finalize the job. Skipping it here
          // would strand it in `remote-waiting` forever with a live cloud workspace behind it.
          `SELECT * FROM jobs
             WHERE state = 'remote-waiting'
               AND (lease_expires_at IS NULL OR lease_expires_at < @t)
             ORDER BY updated_at ASC LIMIT 1`,
        )
        .get({ t }) as any;
      if (!row) return undefined;
      this.db
        .prepare(
          `UPDATE jobs SET lease_owner=@owner, lease_expires_at=@exp, remote_polled_at=@t, updated_at=@t
             WHERE id=@id`,
        )
        .run({ owner, exp: t + leaseMs, t, id: row.id });
      return ROW_TO_JOB(row);
    });
    return tx();
  }

  /**
   * A tracker tick failed, but the REMOTE session is still fine — e.g. Linear returned a proxy
   * error page while we were fetching the issue to report against.
   *
   * Deliberately NOT `scheduleRetry`: that requeues into the main queue and clears the session, so
   * the next attempt would dispatch a SECOND cloud workspace and orphan the one still doing the
   * work. Instead the job stays parked with its session intact and simply becomes claimable again.
   * Attempts are still counted, so a genuinely broken resume can't spin forever.
   */
  retryRemoteTracking(jobId: string, failureClass: string, detail: string): "parked" | "exhausted" {
    const t = this.now();
    const job = this.get(jobId);
    const attempts = (job?.attempts ?? 0) + 1;
    if (job && attempts >= job.maxAttempts) {
      this.transition(jobId, "needs-attention", { failure_class: failureClass, failure_detail: detail });
      return "exhausted";
    }
    this.db
      .prepare(
        `UPDATE jobs SET attempts=@a, lease_owner=NULL, lease_expires_at=NULL, remote_polled_at=@t,
           failure_class=@fc, failure_detail=@fd, updated_at=@t
         WHERE id=@id`,
      )
      .run({ a: attempts, t, fc: failureClass, fd: detail, id: jobId });
    this.recordEvent(jobId, "retry", { attempts, failureClass, remote: true });
    return "parked";
  }

  /** Heartbeat for a parked job — proves the tracker polling it is still alive. */
  remotePoll(jobId: string, leaseMs = 120_000): void {
    const t = this.now();
    this.db
      .prepare(`UPDATE jobs SET remote_polled_at=@t, lease_expires_at=@exp, updated_at=@t WHERE id=@id`)
      .run({ t, exp: t + leaseMs, id: jobId });
  }

  /** Parked jobs whose tracker died: clear the lease so another tracker can pick them back up. */
  reclaimStalledRemote(staleMs = 10 * 60_000): number {
    const t = this.now();
    const res = this.db
      .prepare(
        `UPDATE jobs SET lease_owner=NULL, lease_expires_at=NULL, updated_at=@t
           WHERE state='remote-waiting' AND lease_owner IS NOT NULL
             AND (remote_polled_at IS NULL OR remote_polled_at + @stale < @t)`,
      )
      .run({ t, stale: staleMs });
    return res.changes;
  }

  reclaimExpiredLeases(graceMs = 60_000): number {
    const t = this.now();
    // Only SLOT_STATES carry a worker lease. Parked remote jobs are reclaimed by
    // `reclaimStalledRemote` instead, since they legitimately sit for hours with no local worker.
    const active = `('${SLOT_STATES.join("','")}')`;
    const stranded = this.db
      .prepare(
        `SELECT id FROM jobs WHERE state IN ${active} AND lease_expires_at IS NOT NULL AND lease_expires_at + @grace < @t`,
      )
      .all({ grace: graceMs, t }) as any[];
    for (const r of stranded) {
      this.db
        .prepare(
          `UPDATE jobs SET state='queued', lease_owner=NULL, lease_expires_at=NULL, next_eligible_at=NULL, updated_at=@t WHERE id=@id`,
        )
        .run({ t, id: r.id });
      this.recordEvent(r.id, "reclaimed", { reason: "lease expired" });
    }
    return stranded.length;
  }

  /**
   * On startup, reset jobs that were mid-flight when the process died. Jobs with no durable
   * side effects yet (claimed/setting-up) are safe to requeue; later stages re-enter via the
   * pipeline's own ground-truth checks, so we requeue them too and let verification reconcile.
   */
  recoverOnStartup(): number {
    const t = this.now();
    const res = this.db
      .prepare(
        `UPDATE jobs SET state='queued', lease_owner=NULL, lease_expires_at=NULL, next_eligible_at=NULL, updated_at=@t
           WHERE state IN ('claimed','setting-up','running','verifying','remediating','reporting')`,
      )
      .run({ t });
    return res.changes;
  }
}
