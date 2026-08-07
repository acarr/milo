import { test } from "node:test";
import assert from "node:assert/strict";
import { ConductorClient, ConductorError } from "../src/conductor-api.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fake fetch that replays a scripted list of responses and records every call. */
function fakeFetch(script: Array<{ status: number; body?: unknown; text?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: unknown, init: unknown) => {
    const opts = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    calls.push({
      url: String(url),
      method: opts.method ?? "GET",
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    const step = script[Math.min(i++, script.length - 1)]!;
    const text = step.text ?? (step.body === undefined ? "" : JSON.stringify(step.body));
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => text,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (script: Parameters<typeof fakeFetch>[0], extra = {}) => {
  const { impl, calls } = fakeFetch(script);
  return {
    calls,
    c: new ConductorClient({
      apiKey: "sk_test_key",
      fetchImpl: impl,
      sleep: async () => {}, // no real backoff waits
      ...extra,
    }),
  };
};

test("every request carries bearer auth, Accept and an explicit User-Agent", async () => {
  const { c, calls } = client([{ status: 200, body: { userId: "u1", email: "a@b.c", organizationId: "o1" } }]);
  await c.me();
  assert.equal(calls[0]!.headers["Authorization"], "Bearer sk_test_key");
  assert.equal(calls[0]!.headers["Accept"], "application/json");
  // Not cosmetic: Conductor's proxy 403s some default client signatures (e.g. Node's undici).
  assert.ok(calls[0]!.headers["User-Agent"], "User-Agent must always be sent");
});

test("GET /me hangs off the origin, NOT the /v0 base path", async () => {
  const { c, calls } = client([{ status: 200, body: { userId: "u1", email: "a@b.c", organizationId: "o1" } }]);
  await c.me();
  assert.equal(calls[0]!.url, "https://api.conductor.build/me");
  assert.ok(!calls[0]!.url.includes("/v0"));
});

test("other endpoints DO use the /v0 base path", async () => {
  const { c, calls } = client([{ status: 200, body: { status: "idle" } }]);
  await c.sessionStatus("sess-1");
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sessions/sess-1/status");
});

test("a StructuredError body maps onto ConductorError with userMessage preserved", async () => {
  const { c } = client([
    {
      status: 400,
      body: {
        code: "INVALID_REQUEST",
        userMessage: "The organization's machine does not include the repository.",
        debugMessage: "internal detail",
        retryable: false,
        source: "network",
      },
    },
  ]);
  await assert.rejects(
    () => c.createWorkspace({ repositoryUrl: "https://github.com/x/y" }),
    (err: unknown) => {
      assert.ok(err instanceof ConductorError);
      assert.equal(err.code, "INVALID_REQUEST");
      assert.equal(err.httpStatus, 400);
      assert.equal(err.retryable, false);
      assert.match(err.userMessage, /does not include the repository/);
      return true;
    },
  );
});

test("a 4xx with retryable:false is NOT retried — a bad project id must fail fast", async () => {
  const { c, calls } = client([
    { status: 400, body: { userMessage: "bad project", retryable: false } },
    { status: 200, body: { workspaceId: "w", sessionId: "s", deepLink: "d" } },
  ]);
  await assert.rejects(() => c.createWorkspace({ projectId: "nope" }));
  assert.equal(calls.length, 1, "must not retry a non-retryable 4xx");
});

test("429 and 5xx are retried, then succeed", async () => {
  const { c, calls } = client([
    { status: 429, body: { userMessage: "slow down" } },
    { status: 503, body: { userMessage: "upstream" } },
    { status: 201, body: { workspaceId: "w1", sessionId: "s1", deepLink: "conductor://x" } },
  ]);
  const ws = await c.createWorkspace({ projectId: "p1" });
  assert.equal(calls.length, 3);
  assert.equal(ws.workspaceId, "w1");
});

test("retries are bounded and the final error propagates", async () => {
  const { c, calls } = client([{ status: 500, body: { userMessage: "boom" } }]);
  await assert.rejects(() => c.sessionStatus("s"), /boom/);
  assert.equal(calls.length, 4, "3 backoff steps + the initial attempt");
});

test("a missing deepLink is synthesized rather than failing a workspace that exists", async () => {
  const { c } = client([{ status: 201, body: { workspaceId: "w9", sessionId: "s9" } }]);
  const ws = await c.createWorkspace({ projectId: "p" });
  assert.equal(ws.workspaceId, "w9");
  assert.match(ws.deepLink, /w9/);
});

test("a workspace response missing ids is a hard, non-retryable failure", async () => {
  const { c, calls } = client([{ status: 201, body: { somethingElse: true } }]);
  await assert.rejects(() => c.createWorkspace({ projectId: "p" }), /no workspaceId/);
  assert.equal(calls.length, 1);
});

test("sessionMessages uses `after` OR `limit`, never both", async () => {
  const { c, calls } = client([
    { status: 200, body: { data: [], hasMore: false } },
    { status: 200, body: { data: [], hasMore: false } },
  ]);
  await c.sessionMessages("s1", { after: "m-7" });
  await c.sessionMessages("s1", {});
  assert.match(calls[0]!.url, /after=m-7/);
  assert.ok(!calls[0]!.url.includes("limit="), "after= must not be combined with limit=");
  assert.match(calls[1]!.url, /limit=/);
  assert.ok(!calls[1]!.url.includes("after="));
});

test("listProjects drains the {data, hasMore} pagination envelope", async () => {
  const { c, calls } = client([
    { status: 200, body: { data: [{ id: "1", name: "a" }, { id: "2", name: "b" }], hasMore: true } },
    { status: 200, body: { data: [{ id: "3", name: "c" }], hasMore: false } },
  ]);
  const projects = await c.listProjects();
  assert.deepEqual(projects.map((p) => p.id), ["1", "2", "3"]);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.url, /offset=2/);
});

test("sendMessage passes a client-supplied messageId as an idempotency key", async () => {
  const { c, calls } = client([{ status: 201, body: { messageId: "mid-1", state: "sent" } }]);
  await c.sendMessage("s1", "do the thing", "mid-1");
  assert.deepEqual(calls[0]!.body, { message: "do the thing", messageId: "mid-1" });
});

test("a non-JSON error body still produces a usable ConductorError", async () => {
  const { c } = client([{ status: 403, text: "<html>Forbidden</html>" }]);
  await assert.rejects(
    () => c.me(),
    (err: unknown) => {
      assert.ok(err instanceof ConductorError);
      assert.equal(err.httpStatus, 403);
      assert.match(err.userMessage, /HTTP 403/);
      return true;
    },
  );
});
