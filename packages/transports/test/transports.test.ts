import { test } from "node:test";
import assert from "node:assert/strict";
import { MiloConfigSchema } from "@milo/core";
import { intentToNewJob, normalizeLinearWebhook, normalizeGithubWebhook, pollLinear, type JobIntent } from "@milo/transports";

const config = MiloConfigSchema.parse({
  repositories: [{ name: "sandbox", path: "/nope", teamKeys: ["SBX"], githubRepo: "acme/milo-sandbox" }],
});

test("intentToNewJob maps a Linear create intent", () => {
  const intent: JobIntent = {
    source: "linear",
    entityId: "SBX-5",
    triggerType: "issue.start",
    contentHash: "SBX-5",
    mode: "create",
    repo: "sandbox",
  };
  const job = intentToNewJob(intent);
  assert.equal(job.source, "linear");
  assert.equal(job.entityId, "SBX-5");
  assert.equal(job.entityRef, "SBX-5"); // defaults to entityId
  assert.equal(job.mode, "create");
  assert.equal(job.contentHash, "SBX-5");
});

test("intentToNewJob maps a GitHub attach intent and preserves a distinct entityRef", () => {
  const intent: JobIntent = {
    source: "github",
    entityId: "acme/milo-sandbox#12",
    entityRef: "milo-sandbox#12",
    triggerType: "pr.mention",
    contentHash: "acme/milo-sandbox#12:2026-05-31T00:00:00Z",
    mode: "attach",
    repo: "milo-sandbox",
  };
  const job = intentToNewJob(intent);
  assert.equal(job.mode, "attach");
  assert.equal(job.entityId, "acme/milo-sandbox#12");
  assert.equal(job.entityRef, "milo-sandbox#12");
  assert.equal(job.contentHash, "acme/milo-sandbox#12:2026-05-31T00:00:00Z");
});

test("normalizeLinearWebhook turns an AgentSessionEvent into a create intent", () => {
  const intent = normalizeLinearWebhook(
    { type: "AgentSessionEvent", action: "created", actor: { name: "alex" }, agentSession: { id: "sess-1", issue: { identifier: "SBX-9" } } },
    config,
  );
  assert.equal(intent?.source, "linear");
  assert.equal(intent?.entityId, "SBX-9");
  assert.equal(intent?.mode, "create");
  assert.equal(intent?.contentHash, "session:sess-1");
  assert.equal(intent?.repo, "sandbox");
  assert.equal(intent?.actor, "alex");
});

test("normalizeLinearWebhook ignores non-agent-session events", () => {
  assert.equal(normalizeLinearWebhook({ type: "Issue", action: "update", data: {} }, config), null);
});

test("normalizeGithubWebhook handles a milo-labeled PR and an @milo comment", () => {
  const labeled = normalizeGithubWebhook(
    "pull_request",
    { action: "labeled", label: { name: "milo" }, pull_request: { number: 5, labels: [{ name: "milo" }] }, repository: { full_name: "acme/milo-sandbox" }, sender: { login: "acarr" } },
    config,
  );
  assert.equal(labeled?.mode, "attach");
  assert.equal(labeled?.entityId, "acme/milo-sandbox#5");
  assert.equal(labeled?.repo, "sandbox");
  assert.equal(labeled?.actor, "acarr");

  const mention = normalizeGithubWebhook(
    "issue_comment",
    { action: "created", issue: { number: 7, pull_request: {} }, comment: { id: 99, body: "hey @milo please fix", user: { login: "bob" } }, repository: { full_name: "acme/milo-sandbox" } },
    config,
  );
  assert.equal(mention?.triggerType, "pr.mention");
  assert.equal(mention?.entityId, "acme/milo-sandbox#7");
  assert.equal(mention?.contentHash, "acme/milo-sandbox#7:99");
  assert.equal(mention?.actor, "bob");
});

test("normalizeGithubWebhook ignores PRs without the trigger and non-PR comments", () => {
  assert.equal(
    normalizeGithubWebhook("pull_request", { action: "opened", pull_request: { number: 1, labels: [] }, repository: { full_name: "acme/milo-sandbox" } }, config),
    null,
  );
  assert.equal(
    normalizeGithubWebhook("issue_comment", { action: "created", issue: { number: 2 }, comment: { body: "@milo" }, repository: { full_name: "acme/milo-sandbox" } }, config),
    null, // not a PR (no issue.pull_request)
  );
});

// pollLinear only reads config.repositories/teamKeys + the list methods — a stand-in suffices.
const fakeLinear = (issues: any[], sessions: any[] = [], followups: any[] = []) =>
  ({
    labeledIssues: async () => issues,
    pendingAgentSessions: async () => sessions,
    pendingFollowupPrompts: async () => followups,
  }) as any;

test("pollLinear emits a revise (attach) intent for a follow-up prompt in an existing agent session", async () => {
  const followups = [
    { sessionId: "sess-1", issueIdentifier: "SBX-5", promptId: "act-99", body: "tighten the validation" },
  ];
  const intents = await pollLinear(fakeLinear([], [], followups), config);
  const f = intents.find((i) => i.triggerType === "issue.delegate.followup");
  assert.ok(f, "follow-up intent present");
  assert.equal(f!.mode, "attach");
  assert.equal(f!.entityId, "SBX-5");
  assert.equal(f!.repo, "sandbox");
  assert.equal(f!.contentHash, "prompt:act-99"); // keyed on the prompt activity id
});

test("pollLinear emits a revise (attach) intent for a new @milo comment on a labeled issue", async () => {
  const issue = {
    identifier: "SBX-1",
    labels: ["milo"],
    comments: [
      { author: "alex", createdAt: "2026-05-01T00:00:00Z", body: "looks good" },
      { author: "alex", createdAt: "2026-05-02T00:00:00Z", body: "@milo please rename the helper" },
    ],
  };
  const intents = await pollLinear(fakeLinear([issue]), config);

  // Still emits the original label (create) intent...
  const label = intents.find((i) => i.triggerType === "issue.label");
  assert.ok(label, "label intent present");
  assert.equal(label!.mode, "create");

  // ...plus a revise intent keyed on the latest mention's timestamp.
  const comment = intents.find((i) => i.triggerType === "issue.comment");
  assert.ok(comment, "comment intent present");
  assert.equal(comment!.mode, "attach");
  assert.equal(comment!.entityId, "SBX-1");
  assert.equal(comment!.repo, "sandbox");
  assert.equal(comment!.contentHash, "comment:2026-05-02T00:00:00Z");
});

test("pollLinear emits no comment intent when there is no @milo mention", async () => {
  const issue = {
    identifier: "SBX-2",
    labels: ["milo"],
    comments: [{ author: "alex", createdAt: "2026-05-01T00:00:00Z", body: "just a note, no mention" }],
  };
  const intents = await pollLinear(fakeLinear([issue]), config);
  assert.equal(intents.filter((i) => i.triggerType === "issue.comment").length, 0);
  assert.ok(intents.some((i) => i.triggerType === "issue.label"));
});
