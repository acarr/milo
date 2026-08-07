import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerEvent } from "@milo/core";
import { runConductor, buildPushRemediationMessage } from "../src/conductor.js";
import { mapStreamJsonEvent } from "../src/stream-json.js";
import type { ConductorClient, ConductorMessage, SessionStatus } from "../src/conductor-api.js";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/conductor-session.json");
const fixtureMessages = (): ConductorMessage[] => JSON.parse(readFileSync(FIXTURE, "utf8")).data;

const logFile = () => join(mkdtempSync(join(tmpdir(), "milo-cond-")), "run.jsonl");

/** A scriptable stand-in for ConductorClient — no network, no timers. */
class FakeApi {
  createdWorkspaces = 0;
  sentMessages: Array<{ sessionId: string; message: string; messageId?: string }> = [];
  cancelled = 0;
  archived = 0;
  slept = 0;
  workspaceState: string = "ready";

  constructor(
    private statuses: SessionStatus[],
    private messages: ConductorMessage[] = [],
  ) {}

  async me() {
    return { userId: "u", email: "e", organizationId: "o" };
  }
  async createWorkspace() {
    this.createdWorkspaces++;
    return { workspaceId: "ws-1", sessionId: "sess-1", deepLink: "conductor://workspace?id=ws-1" };
  }
  async createSession() {
    return { sessionId: "sess-2" };
  }
  async sendMessage(sessionId: string, message: string, messageId?: string) {
    this.sentMessages.push({ sessionId, message, messageId });
    return { messageId: messageId ?? "m", state: "sent" };
  }
  async sessionStatus() {
    // Hold the last status once the script runs out, so a loop that should terminate does.
    const s = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0]!;
    return { status: s };
  }
  async workspaceStatus() {
    return { status: this.workspaceState as never };
  }
  async sessionMessages(_sessionId: string, opts: { after?: string } = {}) {
    if (opts.after) {
      const idx = this.messages.findIndex((m) => m.id === opts.after);
      return { data: idx >= 0 ? this.messages.slice(idx + 1) : [], hasMore: false };
    }
    return { data: this.messages, hasMore: false };
  }
  async cancelSession() {
    this.cancelled++;
  }
  async archiveWorkspace() {
    this.archived++;
  }
  async sleepWorkspace() {
    this.slept++;
  }
}

const baseOpts = (api: FakeApi, over: Record<string, unknown> = {}) => ({
  cwd: "/nonexistent-worktree",
  prompt: "do the thing",
  model: "opus-5-1m",
  logFile: logFile(),
  api: api as unknown as ConductorClient,
  projectId: "proj-1",
  branch: "feature/sbx-1-thing",
  baseBranch: "main",
  workspaceName: "milo-sbx-1-abc123",
  pollMs: 1,
  // Yield a MACROtask, not just a microtask: a microtask-only fake sleep spins the poll loop
  // without ever letting timers (e.g. a test's abort) fire, which deadlocks the run.
  sleep: () => new Promise<void>((r) => setImmediate(r)),
  // The guards are measured against real wall-clock. Left at production values a test whose fake
  // session never reaches `working` would legitimately spin for the full 10-minute dispatch window.
  dispatchTimeoutMs: 300,
  inactivityMs: 2_000,
  maxRunMs: 5_000,
  remediationAttempts: 0,
  ...over,
});

// ---------------------------------------------------------------- event mapping

test("maps a REAL captured Conductor transcript into transcript events", () => {
  const events: RunnerEvent[] = [];
  let text = "";
  for (const m of fixtureMessages()) {
    if (m.type !== "agent") continue;
    const raw = (m.content as Record<string, unknown>)["rawPayload"];
    for (const item of mapStreamJsonEvent(raw)) {
      if (item.kind === "text") {
        text += item.text;
        events.push({ kind: "narration", text: item.text });
      } else if (item.kind === "event") events.push(item.event);
      else text += item.text;
    }
  }
  // The real session ran shell commands and narrated — both must survive the mapping.
  assert.ok(events.some((e) => e.kind === "narration"), "expected narration events");
  assert.ok(events.some((e) => e.kind === "tool" && e.tool === "Bash"), "expected Bash tool events");
  assert.ok(
    events.some((e) => e.kind === "tool" && e.text.startsWith("$ ")),
    "Bash events should render as shell lines",
  );
  assert.match(text, /MILO_PROBE=/, "the agent's final text must reach output");
});

test("thinking blocks and lifecycle noise produce no transcript events", () => {
  assert.deepEqual(
    mapStreamJsonEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
    [],
  );
  assert.deepEqual(mapStreamJsonEvent({ type: "command_lifecycle", state: "running" }), []);
  assert.deepEqual(mapStreamJsonEvent({ type: "system", subtype: "session_state_changed" }), []);
  assert.deepEqual(mapStreamJsonEvent(null), []);
  assert.deepEqual(mapStreamJsonEvent({ type: "assistant", message: { content: "not-an-array" } }), []);
});

// ---------------------------------------------------------------- the idle/working latch

test("an `idle` seen BEFORE any `working` does not end the run", async () => {
  // Conductor reports `idle` while a prompt is still queued. Trusting it would finish the job
  // before the agent had done anything — the single most important behaviour in this file.
  const api = new FakeApi(["idle", "idle", "working", "idle"]);
  const res = await runConductor(baseOpts(api) as never);
  // It kept polling past the leading idles and only settled after working→idle.
  assert.equal(api.cancelled, 0);
  // No branch on origin (cwd isn't a repo) so the run reports unreachable work, not success —
  // what matters here is that it got past the leading `idle`s at all.
  assert.equal(res.unreachableWork, true);
});

test("a fast turn that never reports `working` still settles once MILO_RESULT appears", async () => {
  const msg = (id: string, text: string): ConductorMessage => ({
    id,
    sessionId: "sess-1",
    sessionIndex: 1,
    type: "agent",
    content: { rawPayload: { type: "result", result: text, is_error: false } },
    receivedAt: "now",
  });
  const api = new FakeApi(["idle"], [msg("m1", 'MILO_RESULT={"outcome":"discovery","wroteCode":false}')]);
  const res = await runConductor(baseOpts(api) as never);
  assert.match(res.output, /MILO_RESULT=/);
});

test("session status `error` ends the run non-zero with the reason in output", async () => {
  const api = new FakeApi(["working", "error"]);
  const res = await runConductor(baseOpts(api) as never);
  assert.equal(res.code, 1);
  assert.match(res.output, /reported an error/i);
});

// ---------------------------------------------------------------- resume / idempotency

test("resuming an existing session does NOT create a second workspace", async () => {
  // The recoverOnStartup hazard: a daemon restart re-dispatches the job, and creating a second
  // cloud workspace would mean two branches and two PRs for one ticket.
  const api = new FakeApi(["working", "idle"]);
  await runConductor(
    baseOpts(api, {
      resume: { workspaceId: "ws-existing", sessionId: "sess-existing", deepLink: "d", sawWorking: true },
    }) as never,
  );
  assert.equal(api.createdWorkspaces, 0, "must reattach, never re-create");
  assert.equal(api.sentMessages.length, 0, "must not re-send the prompt on resume");
});

test("a resumed workspace that was archived falls back to creating a fresh one", async () => {
  const api = new FakeApi(["working", "idle"]);
  api.workspaceState = "archived";
  await runConductor(
    baseOpts(api, {
      resume: { workspaceId: "ws-gone", sessionId: "sess-gone", deepLink: "d" },
    }) as never,
  );
  assert.equal(api.createdWorkspaces, 1);
  assert.equal(api.sentMessages.length, 1);
});

test("a resume past the saved cursor still rebuilds output from the WHOLE transcript", async () => {
  // The live failure (SBX-16, 2026-08-05): a first resume consumed the transcript and persisted its
  // cursor, then a second resume drained from that cursor, found nothing, and finalized on an EMPTY
  // output. The agent's MILO_RESULT — a good 311-character summary — was never read, so the gate
  // opened PR #19 described as nothing but "Implements SBX-16". `output` starts empty on every
  // invocation, so a resume must replay everything, not just what arrived since.
  const messages = fixtureMessages();
  const lastId = messages[messages.length - 1]!.id;
  const api = new FakeApi(["idle"], messages);

  const res = await runConductor(
    baseOpts(api, {
      resume: {
        workspaceId: "ws-existing",
        sessionId: "sess-existing",
        deepLink: "d",
        sawWorking: true,
        cursor: lastId, // everything already consumed by a previous tracker
      },
    }) as never,
  );

  assert.match(res.output, /MILO_PROBE=/, "the agent's final line must be recovered, not lost");
  assert.equal(api.createdWorkspaces, 0, "still a reattach, not a re-create");
});

test("replaying a resumed transcript does not re-emit its narration or rewind the cursor", async () => {
  // The replay exists only to rebuild `output`. Re-emitting would repost the whole run's narration
  // to the Linear agent session, and re-persisting a rewound cursor would make the next resume
  // replay from scratch again.
  const messages = fixtureMessages();
  const lastId = messages[messages.length - 1]!.id;
  const api = new FakeApi(["idle"], messages);
  const events: RunnerEvent[] = [];
  const cursors: Array<string | undefined> = [];

  const res = await runConductor(
    baseOpts(api, {
      resume: { workspaceId: "ws", sessionId: "s", deepLink: "d", sawWorking: true, cursor: lastId },
      onEvent: (e: RunnerEvent) => events.push(e),
      onSession: (s: { cursor?: string }) => cursors.push(s.cursor),
    }) as never,
  );

  assert.match(res.output, /MILO_PROBE=/, "the replay must still happen — otherwise this proves nothing");
  assert.equal(
    events.filter((e) => e.kind === "narration").length,
    0,
    "a silent replay must not repost the transcript",
  );
  assert.ok(!cursors.includes(undefined), "the durable cursor must never be rewound to the start");
});

test("session state is persisted BEFORE the prompt is sent, so a crash resumes", async () => {
  const api = new FakeApi(["working", "idle"]);
  const seen: Array<{ workspaceId: string; sessionId: string }> = [];
  await runConductor(
    baseOpts(api, { onSession: (s: { workspaceId: string; sessionId: string }) => seen.push({ ...s }) }) as never,
  );
  assert.ok(seen.length > 0, "session must be persisted");
  assert.equal(seen[0]!.workspaceId, "ws-1");
  assert.equal(seen[0]!.sessionId, "sess-1");
});

// ---------------------------------------------------------------- prompt-echo hazard

test("our own prompt echoed back never reaches output (it contains a MILO_RESULT example)", async () => {
  const echoed: ConductorMessage = {
    id: "m1",
    sessionId: "sess-1",
    sessionIndex: 0,
    type: "userMessage",
    content: { message: 'MILO_RESULT={"outcome":"implemented","prUrl":"https://github.com/o/r/pull/123"}' },
    receivedAt: "now",
  };
  const api = new FakeApi(["working", "idle"], [echoed]);
  const res = await runConductor(baseOpts(api) as never);
  assert.ok(
    !res.output.includes("pull/123"),
    "the prompt's example PR URL must never be parseable as a real result",
  );
});

// ---------------------------------------------------------------- cancellation

test("an aborted signal cancels the remote session instead of killing a local process", async () => {
  const api = new FakeApi(["working", "working", "working"]);
  const ctrl = new AbortController();
  const p = runConductor(baseOpts(api, { signal: ctrl.signal }) as never);
  setTimeout(() => ctrl.abort(), 5);
  const res = await p;
  assert.equal(api.cancelled, 1);
  assert.equal(res.code, 1);
});

test("an already-aborted signal never creates a workspace at all", async () => {
  const api = new FakeApi(["idle"]);
  const ctrl = new AbortController();
  ctrl.abort();
  const res = await runConductor(baseOpts(api, { signal: ctrl.signal }) as never);
  assert.equal(api.createdWorkspaces, 0);
  assert.equal(res.code, 1);
});

// ---------------------------------------------------------------- unreachable work

test("work that never reached origin fails loudly and PRESERVES the workspace", async () => {
  const api = new FakeApi(["working", "idle"]);
  const res = await runConductor(baseOpts(api) as never);
  assert.equal(res.unreachableWork, true);
  assert.equal(res.code, 1);
  assert.match(res.output, /is not on origin/);
  assert.match(res.output, /conductor:\/\/workspace/, "must tell the human where the work is");
  assert.equal(api.archived, 0, "NEVER archive a workspace holding unreachable work");
  assert.equal(api.slept, 0, "and never sleep it either");
});

test("the remediation message is narrow and names the exact branch", () => {
  const msg = buildPushRemediationMessage("feature/sbx-1-thing");
  assert.match(msg, /git push -u origin feature\/sbx-1-thing/);
  assert.match(msg, /ls-remote --exit-code origin feature\/sbx-1-thing/);
  assert.match(msg, /no other code changes/i);
});

test("remediation sends exactly one focused nudge when configured to", async () => {
  const api = new FakeApi(["working", "idle"]);
  await runConductor(baseOpts(api, { remediationAttempts: 1 }) as never);
  const nudges = api.sentMessages.filter((m) => /has not reached GitHub/.test(m.message));
  assert.equal(nudges.length, 1);
});

// ---------------------------------------------------------------- messageId shape

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("every messageId is a well-formed UUID", async () => {
  // Conductor stores messageId in a `uuid` column and rejects anything else with
  // `invalid input syntax for type uuid` — which surfaces as an opaque failed run.
  const api = new FakeApi(["working", "idle"]);
  await runConductor(baseOpts(api, { remediationAttempts: 1 }) as never);
  assert.ok(api.sentMessages.length >= 2, "expected a prompt and a remediation nudge");
  for (const m of api.sentMessages) {
    assert.match(m.messageId ?? "", UUID_RE, `messageId "${m.messageId}" must be a UUID`);
  }
});

test("messageIds are deterministic per job but distinct per message", async () => {
  // Deterministic so a resend after a network blip can't double-prompt the agent; distinct so the
  // remediation nudge isn't deduped against the original prompt.
  const run = async () => {
    const api = new FakeApi(["working", "idle"]);
    await runConductor(baseOpts(api, { remediationAttempts: 1, workspaceName: "milo-fixed-name" }) as never);
    return api.sentMessages.map((m) => m.messageId);
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b, "same job → same message ids");
  assert.equal(new Set(a).size, a.length, "each message needs its own id");
});
