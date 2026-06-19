import type { MiloConfig } from "./config.js";
import type { JobStore, DependencyStrategy, JobState } from "./jobs.js";
import { TERMINAL_STATES } from "./jobs.js";
import type { LinearClient } from "./linear.js";
import { fetchPr } from "./github.js";
import { logger } from "./logger.js";

/**
 * Dependency sequencing (MILO-4). Milo reads Linear `blockedBy` relations and refuses to run a
 * blocked issue cold against `main` in parallel with its blocker. Two strategies, chosen by config
 * or a label on the dependent:
 *   - **wait** (default, conservative): hold the dependent until the blocker's PR merges, then it
 *     enqueues fresh against the updated base.
 *   - **stacked** (opt-in): run the blocker first; once it's done, base the dependent's worktree
 *     off the blocker's head branch so the PRs stack logically.
 *
 * `core` already owns the Linear + GitHub clients, so this stays runner/transport-agnostic. The
 * actual gate lives in `JobStore.claimNext` (a pure-SQL check against `job_dependencies`); this
 * module is the async half that records edges and flips them `resolved` as the world changes.
 *
 * Safety: cycles, untrackable blockers, and permission/GraphQL errors never deadlock — they fall
 * back to today's parallel behavior with a logged notice (and, where a decision was announced, a
 * single follow-up Linear comment).
 */

export interface DependencyDeps {
  config: MiloConfig;
  store: JobStore;
  linear: LinearClient;
  /** Injectable for tests; defaults to the real `gh`-backed fetchPr. */
  fetchPr?: typeof fetchPr;
}

/**
 * The enqueue-time dependency hold (MILO-15): how long a fresh Linear create job waits before it
 * can be claimed, so discovery gets to record its `blockedBy` edges first. Returns the hold
 * expiry (ms epoch) or undefined when no hold applies (feature off, non-Linear source, attach
 * mode — revisions of existing work never need sequencing).
 */
export function dependencyHold(
  config: MiloConfig,
  intent: { source: string; mode?: string },
  now: number = Date.now(),
): number | undefined {
  if (!config.dependencies.enabled || config.dependencies.holdMs <= 0) return undefined;
  if (intent.source !== "linear" || intent.mode === "attach") return undefined;
  return now + config.dependencies.holdMs;
}

/** Strategy for a dependent: a `stacked`/`wait` label overrides the configured default. */
export function resolveDependencyStrategy(config: MiloConfig, labels: string[]): DependencyStrategy {
  const lower = labels.map((l) => l.toLowerCase().trim());
  if (lower.includes("stacked") || lower.includes("milo:stacked")) return "stacked";
  if (lower.includes("wait") || lower.includes("wait-for-merge") || lower.includes("milo:wait")) return "wait";
  return config.dependencies.defaultStrategy;
}

/** Would recording `dependent → blocker` close a cycle (blocker already depends on dependent)? */
function wouldCycle(store: JobStore, dependent: string, blocker: string): boolean {
  const seen = new Set<string>();
  const stack = [blocker];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === dependent) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of store.dependenciesFor(cur)) stack.push(d.blockerEntityId);
  }
  return false;
}

function parsePrUrl(url: string | null): { slug: string; number: number } | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? { slug: m[1]!, number: parseInt(m[2]!, 10) } : undefined;
}

/**
 * The blocker PR's state — MERGED is the signal `wait` mode waits for; CLOSED (without merging)
 * means waiting would deadlock. UNKNOWN (unparseable URL / `gh` error) keeps the gate as-is.
 */
function blockerPrState(prUrl: string | null, fetch: typeof fetchPr): "MERGED" | "CLOSED" | "OPEN" | "UNKNOWN" {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return "UNKNOWN";
  try {
    const state = fetch(parsed.slug, parsed.number)?.state;
    return state === "MERGED" || state === "CLOSED" || state === "OPEN" ? state : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/** A job state that is terminal but not a success — sequencing on it can never make progress. */
function isTerminalFailure(state: JobState): boolean {
  return TERMINAL_STATES.includes(state) && state !== "done" && state !== "discovery-done";
}

/** Linear states that mean a blocker is finished and no longer gating. */
const DONE_STATE_TYPES = ["completed", "canceled"];

/**
 * Discover and record dependency edges for every queued Linear/CLI job whose issue is blockedBy a
 * blocker that Milo is also tracking. Idempotent: an already-recorded edge isn't re-announced; an
 * untrackable blocker, a cycle, or a permission error logs and falls back to parallel.
 *
 * Hold interaction (MILO-15): jobs enqueued with a dependency hold stay unclaimable until discovery
 * accounts for every blocker — then the hold clears and the recorded edges (if any) take over as
 * the gate. A blocker that exists in Linear but isn't tracked by Milo *yet* keeps the hold: its own
 * job may be milliseconds behind (webhook delivery order isn't guaranteed), and the sync that
 * ingests it will re-run discovery and account for it then.
 */
export async function discoverDependencies(deps: DependencyDeps): Promise<void> {
  const { config, store, linear } = deps;
  if (!config.dependencies.enabled) return;

  const candidates = store
    .list({ limit: 500 })
    .filter((j) => j.state === "queued" && (j.source === "linear" || j.source === "cli"));

  for (const job of candidates) {
    let relations: { issueId: string; blockers: { identifier: string; stateType: string }[] };
    try {
      relations = await linear.blockedBy(job.entityId);
    } catch (err) {
      // Hold (if any) is left to expire naturally — Linear being down degrades to parallel, never deadlock.
      logger.warn(
        { entity: job.entityId, err: (err as Error).message },
        "could not read Linear blockedBy relations — proceeding in parallel",
      );
      continue;
    }

    // New blockers to sequence on (skip already-recorded edges and upstream-resolved blockers).
    const fresh = relations.blockers.filter(
      (b) =>
        b.identifier !== job.entityId &&
        !DONE_STATE_TYPES.includes(b.stateType) &&
        !store.hasDependency(job.entityId, b.identifier),
    );
    if (!fresh.length) {
      // Nothing left to gate on — no blockers, all done upstream, or edges already recorded
      // (claimNext's SQL gate owns those). The discovery hold has served its purpose.
      store.clearEnqueueHold(job.id);
      continue;
    }

    // Labels drive strategy selection; fetch them best-effort once we know there's work to gate.
    const labels = await linear.fetchIssue(job.entityId).then((i) => i.labels).catch(() => []);
    const strategy = resolveDependencyStrategy(config, labels);
    // Blockers we can't account for yet (tracked by Linear but not by Milo) — they keep the hold alive.
    let unaccounted = 0;
    for (const blocker of fresh) {
      // Only sequence on blockers Milo actually has work for — otherwise we'd deadlock waiting on
      // something we'll never run. Untracked blocker → fall back to parallel (logged), but keep the
      // discovery hold: its job may arrive moments from now (webhook ordering), and the next sync
      // will record the edge before the hold expires.
      const blockerJob = store.latestJobForEntity(blocker.identifier);
      if (!blockerJob) {
        unaccounted++;
        logger.info(
          { entity: job.entityId, blocker: blocker.identifier },
          "blockedBy an issue Milo isn't tracking — not sequencing (parallel)",
        );
        continue;
      }
      // A terminally-failed blocker would be dropped by the reconciler immediately — recording it
      // would just flap (record → drop → re-record each poll). Fall back to parallel up front.
      if (isTerminalFailure(blockerJob.state)) {
        logger.info(
          { entity: job.entityId, blocker: blocker.identifier, blockerState: blockerJob.state },
          "blocker already failed — not sequencing (parallel)",
        );
        continue;
      }
      if (wouldCycle(store, job.entityId, blocker.identifier)) {
        logger.warn(
          { entity: job.entityId, blocker: blocker.identifier },
          "dependency cycle detected — not sequencing (parallel)",
        );
        continue;
      }

      store.recordDependency(job.entityId, blocker.identifier, strategy);
      const noticeKey = `dep-notice:${job.entityId}:${blocker.identifier}`;
      if (store.alreadyDid(noticeKey) === undefined) {
        const body =
          strategy === "stacked"
            ? `Milo is sequencing this work: **${job.entityId}** is blocked by **${blocker.identifier}**. ` +
              `Milo will finish ${blocker.identifier} first, then **stack** this branch on top of it ` +
              `(its PR will target ${blocker.identifier}'s branch) rather than running both in parallel.`
            : `Milo is sequencing this work: **${job.entityId}** is blocked by **${blocker.identifier}**. ` +
              `Milo will **wait for ${blocker.identifier}'s PR to merge** and then start this fresh ` +
              `against the updated base, rather than running both in parallel.`;
        try {
          await linear.addComment(relations.issueId, body);
        } catch (err) {
          logger.warn({ entity: job.entityId, err: (err as Error).message }, "could not post sequencing comment");
        }
        store.recordSideEffect(noticeKey, "dep-notice", `${strategy}:${blocker.identifier}`);
      }
      logger.info({ entity: job.entityId, blocker: blocker.identifier, strategy }, "recorded dependency");
    }
    // Every blocker is now either edge-recorded or a deliberate parallel fallback (failed/cycle) —
    // release the discovery hold and let the recorded edges (if any) gate the claim instead.
    if (unaccounted === 0) store.clearEnqueueHold(job.id);
  }
}

/**
 * Flip unresolved edges to `resolved` once their blocker's strategy condition is met, and drop
 * edges that can no longer make progress (a failed/vanished blocker) so nothing deadlocks. Cheap
 * when there are no unresolved edges (a single DB read).
 */
export async function reconcileDependencies(deps: DependencyDeps): Promise<void> {
  const { config, store } = deps;
  if (!config.dependencies.enabled) {
    // The claimNext gate is pure SQL and doesn't read config — if the feature is disabled while
    // unresolved edges exist, their dependents would stay unclaimable forever. Clear the gates.
    for (const dep of store.unresolvedDependencies()) {
      store.dropDependency(dep.dependentEntityId, dep.blockerEntityId);
      logger.info(
        { dependent: dep.dependentEntityId, blocker: dep.blockerEntityId },
        "dependency sequencing disabled — dropped gate (parallel)",
      );
    }
    return;
  }

  for (const dep of store.unresolvedDependencies()) {
    const blockerJob = store.latestJobForEntity(dep.blockerEntityId);

    // Blocker isn't tracked anymore — don't hold the dependent hostage.
    if (!blockerJob) {
      await dropAndNotify(deps, dep.dependentEntityId, dep.blockerEntityId, "is no longer tracked by Milo");
      continue;
    }
    const succeeded = blockerJob.state === "done" || blockerJob.state === "discovery-done";

    // Blocker reached a terminal *failure* — stacking/waiting on it would deadlock. Fall back.
    if (isTerminalFailure(blockerJob.state)) {
      await dropAndNotify(deps, dep.dependentEntityId, dep.blockerEntityId, "did not complete successfully");
      continue;
    }
    if (!succeeded) continue; // blocker still in flight — keep gating

    if (dep.strategy === "stacked") {
      // Base the dependent off the blocker's head branch (null branch → falls back to repo default).
      store.resolveDependency(dep.dependentEntityId, dep.blockerEntityId, blockerJob.branch);
      logger.info(
        { dependent: dep.dependentEntityId, blocker: dep.blockerEntityId, branch: blockerJob.branch },
        "stacked dependency resolved — dependent will branch off blocker's head",
      );
      continue;
    }

    // wait: resolve only once the blocker's PR has merged (a discovery-only blocker has no PR to
    // wait on, so it resolves immediately). The dependent then enqueues fresh against the base.
    const noPr = blockerJob.state === "discovery-done" || !blockerJob.prUrl;
    if (noPr) {
      store.resolveDependency(dep.dependentEntityId, dep.blockerEntityId);
      logger.info(
        { dependent: dep.dependentEntityId, blocker: dep.blockerEntityId },
        "wait dependency resolved — no blocker PR to wait on",
      );
      continue;
    }
    const prState = blockerPrState(blockerJob.prUrl, deps.fetchPr ?? fetchPr);
    if (prState === "MERGED") {
      store.resolveDependency(dep.dependentEntityId, dep.blockerEntityId);
      logger.info(
        { dependent: dep.dependentEntityId, blocker: dep.blockerEntityId },
        "wait dependency resolved — blocker PR merged",
      );
    } else if (prState === "CLOSED") {
      // The blocker's PR was closed without merging — its work isn't landing on the base, so
      // waiting would deadlock. Fall back to parallel.
      await dropAndNotify(deps, dep.dependentEntityId, dep.blockerEntityId, "had its PR closed without merging");
    }
    // OPEN / UNKNOWN → keep gating; the next reconcile re-checks.
  }
}

/** Drop an edge that can't make progress, posting a single follow-up only if we announced it. */
async function dropAndNotify(
  deps: DependencyDeps,
  dependent: string,
  blocker: string,
  reason: string,
): Promise<void> {
  const { store, linear } = deps;
  store.dropDependency(dependent, blocker);
  logger.warn({ dependent, blocker, reason }, "dropped dependency — proceeding in parallel");

  // Only correct the Linear thread if we'd previously announced the sequencing decision there.
  if (store.alreadyDid(`dep-notice:${dependent}:${blocker}`) === undefined) return;
  const dropKey = `dep-drop:${dependent}:${blocker}`;
  if (store.alreadyDid(dropKey) !== undefined) return;
  try {
    const issue = await linear.fetchIssue(dependent);
    await linear.addComment(
      issue.id,
      `Milo is no longer sequencing **${dependent}** behind **${blocker}** (${blocker} ${reason}). ` +
        `Proceeding with ${dependent} against the default base.`,
    );
  } catch (err) {
    logger.warn({ dependent, err: (err as Error).message }, "could not post dependency-drop comment");
  }
  store.recordSideEffect(dropKey, "dep-drop");
}

/** Discover new edges and reconcile existing ones in one pass (used by pollers + the CLI). */
export async function syncDependencies(deps: DependencyDeps): Promise<void> {
  // No enabled-check here: discover no-ops when disabled, and reconcile must still run so that
  // disabling the feature clears any already-recorded gates (instead of stranding their dependents).
  await discoverDependencies(deps);
  await reconcileDependencies(deps);
}

/**
 * A fire-and-forget, self-throttling ticker for the daemon queue loop: it kicks off reconciliation
 * in the background at most once per `minMs` and never blocks the worker. The poller cadence is the
 * real backstop; this just makes a freed blocker promptly unblock its dependents.
 */
export function makeReconcileTicker(deps: DependencyDeps, minMs = 10_000): () => void {
  let last = 0;
  let running = false;
  return () => {
    const now = Date.now();
    if (running || now - last < minMs) return;
    last = now;
    running = true;
    void reconcileDependencies(deps)
      .catch((err) => logger.warn({ err: (err as Error).message }, "reconcile tick failed"))
      .finally(() => {
        running = false;
      });
  };
}

/**
 * A coalescing trigger for the webhook ingress (MILO-15): fire-and-forget `syncDependencies`, but
 * never overlap runs. A trigger that lands while a sync is in flight queues exactly one follow-up
 * sync — so a burst of webhook deliveries (e.g. a blocker and its dependent delegated together)
 * collapses to "current sync + one more", and the follow-up is guaranteed to see every job the
 * burst enqueued. Returns the trigger; callers never await it (webhook responses stay fast).
 */
export function makeDependencySyncTrigger(deps: DependencyDeps): () => void {
  let running = false;
  let pending = false;
  const run = (): void => {
    running = true;
    void syncDependencies(deps)
      .catch((err) => logger.warn({ err: (err as Error).message }, "webhook dependency sync failed"))
      .finally(() => {
        running = false;
        if (pending) {
          pending = false;
          run();
        }
      });
  };
  return () => {
    if (running) {
      pending = true;
      return;
    }
    run();
  };
}
