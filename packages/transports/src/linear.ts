import { resolveRepo, type LinearClient, type MiloConfig, type LinearIssue, logger } from "@milo/core";
import type { JobIntent } from "./index.js";

const TRIGGER_LABEL = "milo";
const MENTION = /@milo\b/i;

/**
 * Poll Linear for work delegated to the Milo agent. Two of these *start* work and two *revise* it:
 *   1. native agent-session delegations (the Linear "delegate to agent" UI) — START,
 *   2. follow-up prompts in an existing agent session (you reply in Milo's chat after it finished) —
 *      REVISE; this is the primary delegate feedback loop,
 *   3. issues carrying the `milo` label — START (a non-delegate hand-off), and
 *   4. follow-up `@milo` comments on a labeled issue — REVISE (the non-delegate equivalent of (2)).
 *
 * Idempotency is the store's job (one job per identity key): a delegation dedupes on its session id;
 * a follow-up prompt on the prompt activity id; a labeled issue on its identifier; a comment on the
 * comment's timestamp — so a *new* signal re-triggers while re-polling a stale one is a no-op. The
 * pipeline decides create-vs-revise authoritatively (it attaches to the existing branch/PR when
 * prior implemented work exists for the entity, regardless of which signal fired).
 */
export async function pollLinear(linear: LinearClient, config: MiloConfig): Promise<JobIntent[]> {
  if (config.transports.linear.enabled === false) return [];

  const intents: JobIntent[] = [];
  const repoFor = (issue: LinearIssue): string => {
    const teamKey = issue.identifier.split("-")[0]!;
    return resolveRepo(config, teamKey, issue.labels)?.name ?? teamKey;
  };

  // (1) labeled issues + (3) follow-up @milo comments on them
  try {
    for (const issue of await linear.labeledIssues(TRIGGER_LABEL)) {
      intents.push({
        source: "linear",
        entityId: issue.identifier,
        entityRef: issue.identifier,
        triggerType: "issue.label",
        contentHash: issue.identifier, // one run per labeled issue
        mode: "create",
        repo: repoFor(issue),
      });

      // A new @milo comment is a revision request. Key on the latest mention's timestamp so a new
      // comment re-triggers while a re-poll dedupes. The pipeline attaches to the existing PR.
      const mentions = issue.comments.filter((c) => MENTION.test(c.body));
      const latest = mentions[mentions.length - 1];
      if (latest) {
        intents.push({
          source: "linear",
          entityId: issue.identifier,
          entityRef: issue.identifier,
          triggerType: "issue.comment",
          contentHash: `comment:${latest.createdAt}`,
          mode: "attach",
          repo: repoFor(issue),
        });
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "linear label poll failed");
  }

  // (3) agent-session delegations (start)
  try {
    const seen = new Set(intents.map((i) => i.entityId));
    for (const s of await linear.pendingAgentSessions()) {
      if (seen.has(s.issueIdentifier)) continue; // already covered by a label trigger
      const teamKey = s.issueIdentifier.split("-")[0]!;
      intents.push({
        source: "linear",
        entityId: s.issueIdentifier,
        entityRef: s.issueIdentifier,
        triggerType: "issue.delegate",
        contentHash: `session:${s.sessionId}`, // a new delegation re-triggers
        mode: "create",
        repo: resolveRepo(config, teamKey)?.name ?? teamKey,
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "linear agent-session poll failed");
  }

  // (2) follow-up prompts in an existing agent session (revise) — the primary delegate feedback path.
  // Keyed on the prompt activity id so each reply re-triggers once; attach mode → revise the PR.
  try {
    for (const f of await linear.pendingFollowupPrompts()) {
      const teamKey = f.issueIdentifier.split("-")[0]!;
      intents.push({
        source: "linear",
        entityId: f.issueIdentifier,
        entityRef: f.issueIdentifier,
        triggerType: "issue.delegate.followup",
        contentHash: `prompt:${f.promptId}`,
        mode: "attach",
        repo: resolveRepo(config, teamKey)?.name ?? teamKey,
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "linear follow-up prompt poll failed");
  }

  return intents;
}
