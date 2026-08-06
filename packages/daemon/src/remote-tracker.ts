import { logger, type JobStore, type ProcessJobFn } from "@milo/core";

/**
 * The remote tracker: drives jobs parked on an off-machine session (Conductor Cloud) to completion.
 *
 * A parked job is deliberately NOT in the main queue. Its work is happening on someone else's
 * machine, so making it occupy one of the (default 3) local concurrency slots for an hour would
 * starve real local work — that's the whole point of parking it. It gets its own, much larger cap
 * here, because waiting on HTTP costs a timer and nothing else.
 *
 * Exclusivity is by lease (`claimRemoteWaiting`), and liveness by `remote_polled_at` rather than the
 * ordinary worker lease — a parked job legitimately has no local worker for hours, so the lease
 * watchdog cannot judge it. `reclaimStalledRemote` frees jobs whose tracker died.
 */
export interface RemoteTrackerOptions {
  store: JobStore;
  processJob: ProcessJobFn;
  /** Max remote sessions tracked at once. Waiting on HTTP is cheap; this can be generous. */
  concurrency: number;
  /** How often to look for newly-parked jobs. */
  intervalMs?: number;
  /** A tracker that hasn't polled in this long is presumed dead and its job is freed. */
  staleMs?: number;
  owner?: string;
}

export function startRemoteTracker(opts: RemoteTrackerOptions): () => void {
  const { store, processJob, concurrency } = opts;
  const intervalMs = opts.intervalMs ?? 5_000;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const owner = opts.owner ?? `remote-tracker-${process.pid}`;
  const inFlight = new Map<string, Promise<void>>();

  const tick = () => {
    try {
      // Free anything whose tracker died mid-poll (daemon killed, process crashed) so it can be
      // picked up again — the remote session itself is unaffected and resumes from its cursor.
      const freed = store.reclaimStalledRemote(staleMs);
      if (freed > 0) logger.warn({ freed }, "remote tracker: reclaimed stalled parked job(s)");

      while (inFlight.size < concurrency) {
        const job = store.claimRemoteWaiting(owner);
        if (!job) break;
        logger.info(
          { jobId: job.id, entity: job.entityRef ?? job.entityId, tracking: inFlight.size + 1, max: concurrency },
          "remote tracker: resuming parked job",
        );
        const p = processJob
          .resumeRemote(job)
          .catch((err) => {
            // resumeRemote records its own terminal state; this is a backstop.
            logger.error({ jobId: job.id, err: (err as Error).message }, "remote tracker: resume threw");
          })
          .finally(() => {
            inFlight.delete(job.id);
          });
        inFlight.set(job.id, p);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "remote tracker tick failed");
    }
  };

  const iv = setInterval(tick, intervalMs);
  if (typeof iv.unref === "function") iv.unref();
  tick(); // pick up anything already parked (e.g. across a daemon restart) without waiting a tick

  return () => clearInterval(iv);
}
