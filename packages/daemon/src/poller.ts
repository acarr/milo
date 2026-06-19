import { logger, syncDependencies, dependencyHold, type JobStore, type LinearClient, type MiloConfig } from "@milo/core";
import { pollLinear, pollGithub, intentToNewJob, type JobIntent } from "@milo/transports";

export interface PollerDeps {
  config: MiloConfig;
  store: JobStore;
  linear: LinearClient;
  /**
   * Called on the poll cadence to re-discover in-repo `.milo/schedules.json` and re-arm the
   * scheduler if it changed. Rides this existing loop instead of adding a separate timer.
   */
  onPollSchedules?: () => void;
}

/**
 * Enqueue every intent a poll produced, recording an inbound_events row for each (created vs
 * deduped) so the "why didn't it start?" view stays honest. Errors in one source never abort
 * the loop — each transport is isolated.
 */
function ingest(config: MiloConfig, store: JobStore, source: string, intents: JobIntent[]): number {
  let created = 0;
  for (const intent of intents) {
    try {
      // The dependency hold (MILO-15) keeps a fresh Linear job unclaimable until the
      // syncDependencies that follows each ingest has recorded its blockedBy edges.
      const { job, disposition } = store.enqueue({
        ...intentToNewJob(intent),
        holdUntil: dependencyHold(config, intent),
      });
      store.recordInbound({
        source,
        channel: "poll",
        payload: intent,
        identityKey: job.identityKey,
        jobId: job.id,
        disposition,
        reason: intent.triggerType,
      });
      if (disposition === "created") {
        created++;
        logger.info({ source, entity: intent.entityRef ?? intent.entityId, jobId: job.id }, "poll enqueued job");
      }
    } catch (err) {
      logger.warn({ source, entity: intent.entityId, err: (err as Error).message }, "failed to enqueue polled intent");
    }
  }
  return created;
}

/**
 * Start the poll-first trigger loops (Linear + GitHub) on their configured cadences. Returns a
 * stop function. Each tick is independent; a slow/failed poll never blocks the queue worker.
 */
export function startPolling(deps: PollerDeps): () => void {
  const { config, store, linear, onPollSchedules } = deps;
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const schedule = (
    name: string,
    enabled: boolean,
    seconds: number,
    fn: () => Promise<JobIntent[]>,
    after?: () => Promise<void>,
  ) => {
    if (!enabled) {
      logger.info({ transport: name }, "transport disabled — not polling");
      return;
    }
    const tick = async () => {
      if (stopped) return;
      try {
        const created = ingest(config, store, name, await fn());
        if (created > 0) logger.info({ transport: name, created }, "poll tick enqueued new work");
        if (after) await after();
      } catch (err) {
        logger.warn({ transport: name, err: (err as Error).message }, "poll tick failed");
      }
    };
    void tick(); // run once immediately on startup
    timers.push(setInterval(tick, Math.max(15, seconds) * 1000));
    logger.info({ transport: name, seconds }, "polling started");
  };

  schedule(
    "linear",
    config.transports.linear.enabled !== false,
    config.transports.linear.pollSeconds,
    () => pollLinear(linear, config),
    // After ingesting newly-labeled/delegated issues, record & reconcile their blockedBy edges
    // (MILO-4) so dependency gates are current before the queue claims anything.
    () => syncDependencies({ config, store, linear }),
  );
  schedule("github", config.transports.github.enabled !== false, config.transports.github.pollSeconds, () =>
    pollGithub(config),
  );

  // Re-discover in-repo `.milo/schedules.json` on the same loop (poll-first): edits/adds/removals are
  // picked up without a daemon restart. Part of this loop's timer set, not a separate mechanism.
  if (onPollSchedules) {
    const seconds = Math.max(15, config.transports.linear.pollSeconds);
    const tick = () => {
      if (stopped) return;
      try {
        onPollSchedules();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "repo-schedule discovery tick failed");
      }
    };
    tick(); // pick up any in-repo schedules immediately on startup
    timers.push(setInterval(tick, seconds * 1000));
    logger.info({ seconds }, "repo-schedule discovery polling started");
  }

  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
  };
}

/** One-shot poll (for `milo poll`): returns how many new jobs each source enqueued. */
export async function pollOnce(deps: PollerDeps): Promise<{ linear: number; github: number }> {
  const { config, store, linear } = deps;
  const linearN = config.transports.linear.enabled === false ? 0 : ingest(config, store, "linear", await pollLinear(linear, config));
  const githubN = config.transports.github.enabled === false ? 0 : ingest(config, store, "github", await pollGithub(config));
  // Record/reconcile dependency edges for any work just enqueued (MILO-4).
  await syncDependencies({ config, store, linear });
  return { linear: linearN, github: githubN };
}
