import type { MiloConfig, NewJob } from "@milo/core";

/**
 * Transport adapters normalize each surface's raw work into a canonical JobIntent, which the
 * daemon maps into a NewJob and enqueues. Phase 4 ships Linear (assignment) + GitHub (PR attach)
 * in poll mode. Slack/WhatsApp remain disabled stubs.
 */
export interface JobIntent {
  source: "linear" | "github" | "schedule" | "cli";
  /** Stable per-source entity id: Linear identifier (SBX-5) or GitHub "owner/name#12". */
  entityId: string;
  /** Human-facing label for the entity (defaults to entityId). */
  entityRef?: string;
  triggerType: string; // issue.start | pr.attach | ...
  /** Distinguishes re-triggerable work (e.g. a new @milo comment) from one-shot starts. */
  contentHash?: string;
  mode: "create" | "attach";
  /** Best-guess repo name (router re-resolves authoritatively during processing). */
  repo: string;
  actor?: string;
  rawEventId?: string;
}

/** Map a normalized intent into the store's NewJob shape. */
export function intentToNewJob(intent: JobIntent): NewJob {
  return {
    source: intent.source,
    entityId: intent.entityId,
    entityRef: intent.entityRef ?? intent.entityId,
    triggerType: intent.triggerType,
    contentHash: intent.contentHash,
    mode: intent.mode,
    repo: intent.repo,
    // One Linear action can fan out into several signals for the same issue (delegation via webhook +
    // `@milo` comment via poll). Let the store collapse them into one revise run once a PR exists.
    dedupeIfEntityActive: intent.source === "linear",
  };
}

export { pollLinear } from "./linear.js";
export { pollGithub } from "./github.js";
export { normalizeLinearWebhook, normalizeGithubWebhook } from "./webhooks.js";

/** Transports that are intentionally not implemented (the brief's "agent everywhere" stubs). */
export const DISABLED_TRANSPORTS = ["slack", "whatsapp"] as const;

export function assertTransportEnabled(config: MiloConfig, name: "slack" | "whatsapp"): never {
  void config;
  throw new Error(`${name} transport is a stub (enabled:false) — not implemented`);
}
