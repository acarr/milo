import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecoverableAgentSession, RECOVERABLE_AGENT_SESSION_STATUSES } from "../src/linear.js";

const ME = "app-user-milo";
const node = (status: string, opts: { appUserId?: string; issue?: string | null } = {}) => ({
  id: `sess-${status}`,
  status,
  appUser: { id: opts.appUserId ?? ME },
  issue: opts.issue === null ? undefined : { identifier: opts.issue ?? "SBX-1" },
});

test("the poll backstop reclaims pending, errored AND stale sessions (recovers dropped delegations)", () => {
  assert.ok(isRecoverableAgentSession(node("pending"), ME));
  assert.ok(isRecoverableAgentSession(node("error"), ME), "an errored session must be recoverable");
  // `stale` is what Linear leaves behind when the delegation webhook was never answered — a blocked
  // daemon or a dead tunnel. It is precisely the case the poll backstop exists to recover.
  assert.ok(isRecoverableAgentSession(node("stale"), ME), "a stale session must be recoverable");
});

test("non-recoverable statuses are excluded", () => {
  for (const status of ["active", "awaitingInput", "complete"]) {
    assert.equal(isRecoverableAgentSession(node(status), ME), false, `${status} should not be claimed`);
  }
});

test("sessions owned by another app user, or with no issue, are excluded", () => {
  assert.equal(isRecoverableAgentSession(node("pending", { appUserId: "someone-else" }), ME), false);
  assert.equal(isRecoverableAgentSession(node("error", { issue: null }), ME), false);
});

test("the recoverable set is exactly pending + error + stale", () => {
  assert.deepEqual([...RECOVERABLE_AGENT_SESSION_STATUSES].sort(), ["error", "pending", "stale"]);
});
