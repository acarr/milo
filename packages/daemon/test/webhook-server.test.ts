import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-webhook-"));
import { openDatabase, JobStore, MiloConfigSchema } from "@milo/core";
import { startWebhookServer } from "../src/webhook-server.js";

const SECRET = "test-secret";
let nextPort = 38461; // avoid the default 3457 a live daemon may hold

function freshStore(): JobStore {
  return new JobStore(openDatabase(join(mkdtempSync(join(os.tmpdir(), "milo-wh-")), "milo.db")));
}

function makeConfig(port: number, concurrency = 3) {
  return MiloConfigSchema.parse({
    repositories: [{ name: "sandbox", path: "/nope", teamKeys: ["SBX"] }],
    webhook: { enabled: true, host: "127.0.0.1", port },
    trust: { webhookSecrets: { linear: SECRET } },
    concurrency,
    // Keep the fire-and-forget dependency sync (which would call Linear) inert in tests.
    dependencies: { enabled: false },
  });
}

/** A LinearClient stand-in that records the agent-session thoughts the server posts. */
function recordingLinear() {
  const thoughts: { sessionId: string; body: string }[] = [];
  return {
    thoughts,
    agentThought: (sessionId: string, body: string) => {
      thoughts.push({ sessionId, body });
      return Promise.resolve(true);
    },
  } as any;
}

const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

const agentSessionEvent = (sessionId: string, issue: string, ageMs: number) =>
  JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: Date.now() - ageMs,
    actor: { name: "alex" },
    agentSession: { id: sessionId, issue: { identifier: issue } },
  });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST to the local webhook server, retrying through the brief listen() startup race. */
async function post(port: number, body: string, sig: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== undefined) headers["linear-signature"] = sig;
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      return await fetch(`http://127.0.0.1:${port}/webhooks/linear`, { method: "POST", headers, body });
    } catch (err) {
      lastErr = err; // ECONNREFUSED until the server is listening
      await delay(25);
    }
  }
  throw lastErr;
}

/** Run a block against a started webhook server, always tearing it down. */
async function withServer(
  store: JobStore,
  fn: (port: number) => Promise<void>,
  opts: { linear?: any; concurrency?: number } = {},
): Promise<void> {
  const port = nextPort++;
  const stop = startWebhookServer({
    config: makeConfig(port, opts.concurrency),
    store,
    linear: opts.linear ?? ({} as any),
  });
  try {
    await fn(port);
  } finally {
    stop();
  }
}

/** Pre-fill the queue with N waiting jobs so the next delegation is over the cap (will wait). */
function fillQueue(store: JobStore, n: number): void {
  for (let i = 0; i < n; i++) {
    store.enqueue({ source: "linear", entityId: `FILL-${i}`, triggerType: "issue.delegate", repo: "sandbox" });
  }
}

const jobsFor = (store: JobStore, entityId: string) => store.list().filter((j) => j.entityId === entityId);

test("a stale-but-valid AgentSessionEvent still enqueues a job and returns 200", async () => {
  const store = freshStore();
  await withServer(store, async (port) => {
    const body = agentSessionEvent("sess-stale-1", "SBX-42", 5 * 60_000); // 5 min old → past the 60s window
    const res = await post(port, body, sign(body));
    assert.equal(res.status, 200, "stale delegation must be accepted, not 401");

    const job = store.latestJobForEntity("SBX-42");
    assert.ok(job, "a job should have been enqueued for the late delegation");
    assert.equal(job.contentHash, "session:sess-stale-1");
    assert.equal(job.triggerType, "issue.delegate");
    assert.equal(job.repo, "sandbox");
    assert.equal(job.state, "queued");
  });
});

test("replaying the same stale delegation dedupes to a single job", async () => {
  const store = freshStore();
  await withServer(store, async (port) => {
    const body = agentSessionEvent("sess-dup-1", "SBX-7", 5 * 60_000);
    const first = await post(port, body, sign(body));
    const second = await post(port, body, sign(body));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(jobsFor(store, "SBX-7").length, 1, "replayed delegation must not create a second job");
  });
});

test("a stale NON-AgentSessionEvent is acked with 200 (not 401) and enqueues nothing", async () => {
  const store = freshStore();
  await withServer(store, async (port) => {
    const body = JSON.stringify({ type: "Issue", action: "update", webhookTimestamp: Date.now() - 5 * 60_000, data: {} });
    const res = await post(port, body, sign(body));
    assert.equal(res.status, 200, "a late non-delegation event must not 401 (that errors the session)");
    assert.equal(store.list().length, 0, "non-delegation events do not enqueue work");
  });
});

test("a bad signature is still rejected with 401", async () => {
  const store = freshStore();
  await withServer(store, async (port) => {
    const body = agentSessionEvent("sess-evil", "SBX-9", 0);
    const res = await post(port, body, "deadbeef");
    assert.equal(res.status, 401);
    assert.equal(store.list().length, 0);
  });
});

test("a delegation that must WAIT (cap full) posts exactly one queued ack", async () => {
  const store = freshStore();
  const linear = recordingLinear();
  fillQueue(store, 3); // cap = 3, so the incoming delegation is the 4th → it waits
  await withServer(
    store,
    async (port) => {
      const body = agentSessionEvent("sess-q", "SBX-50", 0);
      await post(port, body, sign(body));
    },
    { linear, concurrency: 3 },
  );
  const acks = linear.thoughts.filter((t: any) => t.sessionId === "sess-q");
  assert.equal(acks.length, 1, "a waiting delegation should get one queued ack");
  assert.match(acks[0].body, /[Qq]ueued/);
});

test("a delegation that starts immediately gets NO queued ack", async () => {
  const store = freshStore();
  const linear = recordingLinear();
  await withServer(
    store,
    async (port) => {
      const body = agentSessionEvent("sess-now", "SBX-60", 0);
      await post(port, body, sign(body));
    },
    { linear, concurrency: 3 },
  );
  assert.equal(linear.thoughts.length, 0, "no queued ack when a slot is free — claim-time msg is authoritative");
  assert.ok(store.latestJobForEntity("SBX-60"), "the job is still enqueued");
});

test("replaying a waiting delegation does not post a second queued ack", async () => {
  const store = freshStore();
  const linear = recordingLinear();
  fillQueue(store, 3);
  await withServer(
    store,
    async (port) => {
      const body = agentSessionEvent("sess-rq", "SBX-70", 0);
      await post(port, body, sign(body)); // created → ack
      await post(port, body, sign(body)); // deduped → no ack
    },
    { linear, concurrency: 3 },
  );
  assert.equal(linear.thoughts.filter((t: any) => t.sessionId === "sess-rq").length, 1);
});
