import type { Job, JobStore } from "./jobs.js";
import { logger } from "./logger.js";

export type ProcessJob = (job: Job) => Promise<void>;

export interface QueueOptions {
  concurrency: number;
  owner?: string;
  /**
   * Called once at the top of each loop iteration, before slots are filled. Used to reconcile
   * dependency gates (MILO-4) so a freed blocker promptly unblocks its dependents. Awaited — pass
   * a fast/fire-and-forget function in the daemon (never block the worker); the CLI awaits a real
   * reconcile so a stacked dependent runs in the same `drain()` once its blocker finishes.
   */
  onTick?: () => void | Promise<void>;
}

/**
 * Drains the job queue with **bounded concurrency** and **per-entity serialization**:
 *  - at most `concurrency` jobs run at once (assign many issues; only N run together)
 *  - never two jobs for the same entity at once (one ticket isn't worked twice in parallel)
 *
 * Per-entity exclusion is enforced in JobStore.claimNext (it won't hand out a job whose entity
 * already has an active job), so the same logic serves both this in-process drain and the
 * long-lived daemon worker pool added in Phase 3.
 */
export class JobQueue {
  private readonly owner: string;

  constructor(
    private readonly store: JobStore,
    private readonly processJob: ProcessJob,
    private readonly opts: QueueOptions,
  ) {
    this.owner = opts.owner ?? `queue-${process.pid}`;
  }

  private launchInto(inFlight: Map<string, Promise<void>>, job: Job): void {
    const p = this.processJob(job)
      .catch((err) => {
        // processJob is expected to record its own terminal/retry state; this is a backstop.
        logger.error({ jobId: job.id, err: (err as Error).message }, "processJob threw");
      })
      .finally(() => {
        inFlight.delete(job.id);
      });
    inFlight.set(job.id, p);
  }

  private fill(inFlight: Map<string, Promise<void>>): number {
    let claimed = 0;
    while (inFlight.size < this.opts.concurrency) {
      const job = this.store.claimNext(this.owner);
      if (!job) break;
      logger.info(
        { jobId: job.id, entity: job.entityRef, active: inFlight.size + 1, max: this.opts.concurrency },
        "claimed job",
      );
      this.launchInto(inFlight, job);
      claimed++;
    }
    return claimed;
  }

  /** Process all currently-runnable jobs until the queue is drained, respecting the limits above. */
  async drain(): Promise<void> {
    const inFlight = new Map<string, Promise<void>>();
    while (true) {
      await this.tick();
      this.fill(inFlight);
      if (inFlight.size === 0) break; // nothing running and nothing claimable -> drained
      await Promise.race(inFlight.values());
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.opts.onTick?.();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "queue onTick failed");
    }
  }

  /**
   * Run continuously (the daemon worker loop): fill slots, and when idle, poll for new work.
   * Stops when `shouldStop()` returns true and in-flight jobs have drained.
   */
  async runForever(shouldStop: () => boolean, pollMs = 1500): Promise<void> {
    const inFlight = new Map<string, Promise<void>>();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (!shouldStop()) {
      await this.tick();
      this.fill(inFlight);
      if (inFlight.size === 0) {
        await sleep(pollMs); // idle — poll for newly enqueued/eligible work
      } else {
        await Promise.race([...inFlight.values(), sleep(pollMs)]);
      }
    }
    // graceful drain of whatever is still running
    while (inFlight.size > 0) await Promise.race(inFlight.values());
  }
}
