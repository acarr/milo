import { resolveRepo, resolveRepoByGithub, type MiloConfig } from "@milo/core";
import type { JobIntent } from "./index.js";

const MENTION = /@milo\b/i;
const TRIGGER_LABEL = "milo";

/**
 * Normalize a Linear webhook into a JobIntent. The accelerator trigger is `AgentSessionEvent`
 * (delegation or @mention both create one); label changes are left to the poll backstop. Returns
 * null for events Milo doesn't act on.
 */
export function normalizeLinearWebhook(payload: any, config: MiloConfig): JobIntent | null {
  if (payload?.type !== "AgentSessionEvent") return null;
  const session = payload.agentSession ?? payload.data ?? {};
  const identifier: string | undefined = session.issue?.identifier;
  const sessionId: string | undefined = session.id;
  if (!identifier || !sessionId) return null;

  const teamKey = identifier.split("-")[0]!;
  const actor = payload.actor?.name ?? session.creator?.name ?? session.creator?.displayName;
  return {
    source: "linear",
    entityId: identifier,
    entityRef: identifier,
    triggerType: "issue.delegate",
    contentHash: `session:${sessionId}`,
    mode: "create",
    repo: resolveRepo(config, teamKey)?.name ?? teamKey,
    actor,
    sessionId,
  };
}

/**
 * Normalize a GitHub webhook into an attach-mode JobIntent. Triggers: a `pull_request` event that
 * carries the `milo` label, or an `issue_comment` on a PR that `@milo`-mentions. Returns null
 * otherwise. `event` is the `X-GitHub-Event` header value.
 */
export function normalizeGithubWebhook(event: string, payload: any, config: MiloConfig): JobIntent | null {
  const slug: string | undefined = payload?.repository?.full_name;
  if (!slug) return null;
  const repoName = resolveRepoByGithub(config, slug)?.name ?? slug.split("/")[1] ?? slug;

  if (event === "pull_request") {
    const pr = payload.pull_request;
    if (!pr) return null;
    const labels: string[] = (pr.labels ?? []).map((l: any) => l.name?.toLowerCase());
    const justLabeledMilo = payload.action === "labeled" && payload.label?.name?.toLowerCase() === TRIGGER_LABEL;
    if (!labels.includes(TRIGGER_LABEL) && !justLabeledMilo) return null;
    return {
      source: "github",
      entityId: `${slug}#${pr.number}`,
      entityRef: `${repoName}#${pr.number}`,
      triggerType: "pr.label",
      contentHash: `${slug}#${pr.number}:label`,
      mode: "attach",
      repo: repoName,
      actor: payload.sender?.login,
    };
  }

  if (event === "issue_comment") {
    if (payload.action !== "created") return null;
    const issue = payload.issue;
    const comment = payload.comment;
    if (!issue?.pull_request || !comment) return null; // must be a comment on a PR
    if (!MENTION.test(comment.body ?? "")) return null;
    return {
      source: "github",
      entityId: `${slug}#${issue.number}`,
      entityRef: `${repoName}#${issue.number}`,
      triggerType: "pr.mention",
      contentHash: `${slug}#${issue.number}:${comment.id ?? comment.created_at ?? "mention"}`,
      mode: "attach",
      repo: repoName,
      actor: comment.user?.login ?? payload.sender?.login,
    };
  }

  return null;
}
