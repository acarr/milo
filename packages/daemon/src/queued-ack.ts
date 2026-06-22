import { type JobStore, type LinearClient, type MiloConfig } from "@milo/core";
import { type JobIntent } from "@milo/transports";

/**
 * What we tell a delegation that has to WAIT. Deliberately says only that it's queued and will start
 * later — never that it has started. The pipeline's claim-time "setting up a worktree…" thought is the
 * single authoritative signal that work has actually begun, so the two can never be confused.
 */
export const QUEUED_ACK =
  "Queued — all workers are busy right now; I'll start and post again as soon as one frees up.";

/**
 * Post a one-time "queued" ack to a Linear agent session — but ONLY when the just-enqueued delegation
 * will genuinely wait (cap full / entity already running). Best-effort and fire-and-forget; a no-op for
 * non-Linear intents, deduped re-deliveries, sessionless intents, and jobs that will start right away.
 * Call right AFTER `store.enqueue`, passing its `disposition`.
 */
export function postQueuedAckIfWaiting(
  store: JobStore,
  linear: LinearClient,
  config: MiloConfig,
  intent: JobIntent,
  disposition: string,
): void {
  if (disposition !== "created" || intent.source !== "linear" || !intent.sessionId) return;
  if (!store.willQueue(intent.entityId, config.concurrency)) return;
  void linear.agentThought(intent.sessionId, QUEUED_ACK);
}
