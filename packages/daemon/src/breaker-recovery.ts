import { logger, type Job, type JobStore, type LinearClient } from "@milo/core";

/**
 * Breaker recovery: pick back up the jobs the circuit breaker abandoned.
 *
 * The breaker exists so a broken repo can't burn attempts forever, and abandoning a job is the
 * right call in the moment. What was missing is the other half — nothing ever brought those jobs
 * back. On 2026-09-22 four wazzon tickets (WAZ-1792, WAZ-1801, WAZ-1802, WAZ-1815) were abandoned
 * at 07:30 when concurrent Colima starts broke Docker. Docker recovered 12 minutes later. None of
 * them ran. Re-delegating in Linear did nothing, silently, because the identity key dedupes onto
 * the dead row.
 *
 * Why this sweep is TIME-driven rather than hooked to the breaker closing: `recordRepoSuccess` only
 * fires when some *other* job for that repo succeeds, and after a storm the casualties are usually
 * the only work there is. So nothing succeeds, nothing closes the breaker, and the lazy
 * `open → half-open` flip inside `repoHealth()` never gets called either — it only happens when
 * something asks. That is the actual deadlock. Calling `repoHealth()` on a timer IS the flip, and
 * the jobs we re-arm become the half-open probe the design always intended.
 */

export interface BreakerRecoveryDeps {
  store: JobStore;
  linear: LinearClient;
  /** How far back a casualty is still worth recovering. Defaults to the store's 24h window. */
  windowMs?: number;
  /** How many times one job may be auto-requeued before a human is asked to look. */
  maxRequeues?: number;
}

const DEFAULT_MAX_REQUEUES = 3;
/** The `job_events` kind that counts a job's automatic requeues (and shows in `milo job <id>`). */
const REQUEUE_EVENT = "breaker-requeue";

/**
 * Re-arm breaker casualties for every repo whose breaker is no longer open.
 *
 * Returns how many jobs were requeued. Safe to call on a short interval: `retry()` moves a job to
 * `queued` and clears its `failure_class`, so it stops matching the predicate immediately — the
 * idempotency is structural, and a concurrent sweep or a daemon restart mid-sweep cannot
 * double-requeue.
 */
export async function sweepBreakerRecovery(deps: BreakerRecoveryDeps): Promise<number> {
  const { store, linear } = deps;
  const maxRequeues = deps.maxRequeues ?? DEFAULT_MAX_REQUEUES;
  let requeued = 0;

  for (const repo of store.breakerAbandonedRepos(deps.windowMs)) {
    // This call is the mechanism, not just a read: it performs the lazy open → half-open flip.
    const health = store.repoHealth(repo);
    if (health.breakerState === "open") continue; // still cooling down — leave it alone

    for (const job of store.breakerAbandoned(repo, deps.windowMs)) {
      // One job's problem must not strand the rest. `retry()` throws if the row has moved on since
      // the query (another process re-armed it), which is benign — skip it and carry on.
      try {
        const attempt = store.countEvents(job.id, REQUEUE_EVENT) + 1;
        if (attempt > maxRequeues) {
          await parkForHuman(deps, job, repo, maxRequeues);
          continue;
        }
        store.recordEvent(job.id, REQUEUE_EVENT, { repo, attempt, breakerState: health.breakerState });
        store.retry(job.id);
        store.recordInbound({
          source: job.source,
          channel: "breaker-recovery",
          payload: { repo, attempt, breakerState: health.breakerState },
          identityKey: job.identityKey,
          jobId: job.id,
          disposition: "requeued",
          reason: `repo ${repo} breaker ${health.breakerState}`,
        });
        logger.info(
          { jobId: job.id, entity: job.entityRef ?? job.entityId, repo, breakerState: health.breakerState, attempt },
          "circuit breaker recovered — requeued abandoned job",
        );
        requeued++;
        await notifyOnce(
          deps,
          job,
          `breaker-resume:${job.id}:${health.openedAt ?? "closed"}`,
          `\`${repo}\` looks healthy again — picking this back up.`,
        );
      } catch (err) {
        logger.warn({ jobId: job.id, repo, err: (err as Error).message }, "breaker recovery could not requeue a job");
      }
    }
  }
  return requeued;
}

/**
 * The repo keeps failing. Stop retrying and make the dead end VISIBLE.
 *
 * `needs-attention` is a state humans actually look at in `milo jobs` and the TUI, and `retry()`
 * already accepts it — so this converts a silent grave into something with a next step attached.
 */
async function parkForHuman(deps: BreakerRecoveryDeps, job: Job, repo: string, maxRequeues: number): Promise<void> {
  deps.store.transition(job.id, "needs-attention", {
    failure_class: "breaker",
    failure_detail:
      `repo ${repo}: the circuit breaker re-opened after ${maxRequeues} automatic retries — ` +
      `fix the repo, then \`milo retry ${job.id}\``,
  });
  logger.warn(
    { jobId: job.id, entity: job.entityRef ?? job.entityId, repo, maxRequeues },
    "circuit breaker recovery gave up — parked in needs-attention",
  );
  await notifyOnce(
    deps,
    job,
    `breaker-giveup:${job.id}`,
    `Milo gave up on this after ${maxRequeues} automatic retries — \`${repo}\` keeps failing its setup. ` +
      `Once it's healthy again, run \`milo retry ${job.id}\`.`,
  );
}

/**
 * Tell the ticket, at most once per `key`.
 *
 * Prefers the agent-session channel: no UUID lookup, no throw, and it lands in the transcript the
 * person is already watching. The `addComment` fallback needs the issue's UUID (not `WAZ-1792`) and
 * throws on failure, so it costs two API calls and must be wrapped — acceptable only because the
 * `side_effects` ledger makes it at most once. GitHub-attach jobs get the log line and nothing else;
 * there's no PR handle here.
 */
async function notifyOnce(deps: BreakerRecoveryDeps, job: Job, key: string, body: string): Promise<void> {
  if (job.source !== "linear") return;
  if (deps.store.alreadyDid(key) !== undefined) return;
  deps.store.recordSideEffect(key, "breaker-recovery-notice");
  try {
    const sessionId = await deps.linear.agentSessionForIssue(job.entityId).catch(() => undefined);
    if (sessionId) {
      void deps.linear.agentThought(sessionId, body);
      return;
    }
    const issue = await deps.linear.fetchIssue(job.entityId);
    await deps.linear.addComment(issue.id, body);
  } catch (err) {
    // A notice we couldn't post must never stop the requeue — the job moving is the point.
    logger.warn({ jobId: job.id, err: (err as Error).message }, "breaker recovery notice could not be posted");
  }
}
