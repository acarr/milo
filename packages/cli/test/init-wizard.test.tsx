import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "ink-testing-library";
import { InitWizard, type InitResult, type AuthOutcome } from "../src/init/InitWizard.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const DOWN = "\u001B[B";
const RIGHT = "\u001B[C";
const ESC = "\u001B";
const TAB = "\t";

const defaults = {
  miloHome: "/Users/dev/.milo",
  worktreeBase: "/Users/dev/.milo/worktrees",
  standardMiloHome: "/Users/dev/.milo",
};

/** A stub authenticate that should never be reached unless a test opts in. */
const neverAuth = async (): Promise<AuthOutcome> => ({ ok: false, error: "stub authenticate called unexpectedly" });

type Props = Parameters<typeof InitWizard>[0];

function wizard(overrides: Partial<Props> = {}) {
  let result: InitResult | null | undefined;
  const props: Props = {
    defaults,
    codexAvailable: false,
    linearConnected: false,
    configExists: false,
    miloOnPath: true,
    authenticate: neverAuth,
    onDone: (r) => {
      result = r;
    },
    ...overrides,
  };
  const rendered = render(<InitWizard {...props} />);
  return { ...rendered, result: () => result };
}

/** Press keys with small settle delays. */
async function press(stdin: { write: (s: string) => void }, ...keys: string[]) {
  for (const k of keys) {
    stdin.write(k);
    await delay(15);
  }
}

/** Walk a step: arrow down to its trailing action row, then Enter. */
async function advance(stdin: { write: (s: string) => void }, downs: number) {
  for (let i = 0; i < downs; i++) await press(stdin, DOWN);
  await press(stdin, ENTER);
  await delay(15);
}

// ---- Welcome ----

test("welcome: shows the cat, the plain-language intro, and the existing-config notice", async () => {
  const { lastFrame, unmount } = wizard({ configExists: true });
  await delay(40);
  const frame = lastFrame() ?? "";
  unmount();
  assert.ok(frame.includes("( o.o )"), "shows the cat");
  assert.ok(frame.includes("Welcome to Milo"), "shows the welcome title");
  assert.ok(frame.includes("autonomous coding agent"), "explains what Milo is");
  assert.match(frame, /A config already exists/, "warns instead of silently overwriting");
  assert.match(frame, /Start/, "shows the Start action");
  assert.doesNotMatch(frame, /sensible default/, "internal jargon copy is gone");
});

// ---- Happy path ----

test("happy path: Enter through every step yields all defaults and every opt-in off", async () => {
  const { stdin, lastFrame, unmount, result } = wizard({ linearConnected: true });
  await delay(40);

  await press(stdin, ENTER); // welcome → paths
  assert.match(lastFrame() ?? "", /\.milo/, "paths step shows the .milo label");
  assert.match(lastFrame() ?? "", /worktrees/, "paths step shows the worktrees label");
  assert.doesNotMatch(lastFrame() ?? "", /MILO_HOME/, "internal env-var name is not user-facing");
  assert.doesNotMatch(lastFrame() ?? "", /worktreeBase/, "internal field name is not user-facing");

  await advance(stdin, 2); // paths → linear (down past 2 fields to Next)
  assert.match(lastFrame() ?? "", /already connected/, "linear step is a no-op when connected");

  await press(stdin, ENTER); // linear (connected) → webhook
  assert.match(lastFrame() ?? "", /Webhook acceleration/, "webhook step");
  assert.match(lastFrame() ?? "", /react instantly/, "webhook step explains why");

  await advance(stdin, 1); // webhook → options
  assert.match(lastFrame() ?? "", /auto-merge PRs/, "options step");
  assert.doesNotMatch(lastFrame() ?? "", /default runner/, "codex option hidden when codex unavailable");
  assert.doesNotMatch(lastFrame() ?? "", /launchd/, "the daemon is no longer an opt-in toggle");

  await advance(stdin, 1); // options → shell
  assert.match(lastFrame() ?? "", /Shell setup/, "shell step");
  assert.match(lastFrame() ?? "", /already set up/, "nothing to do: milo on PATH + default home");

  await press(stdin, ENTER); // Finish
  unmount();

  const r = result();
  assert.ok(r, "onDone received a result");
  assert.equal(r!.miloHome, defaults.miloHome);
  assert.equal(r!.worktreeBase, defaults.worktreeBase);
  assert.equal(r!.defaultRunner, "claude");
  assert.equal(r!.enableWebhook, false, "webhooks are opt-in (off by default)");
  assert.equal(r!.autoMerge, false, "autoMerge is opt-in (off by default)");
  assert.equal(r!.linear.connected, true, "already connected");
  assert.equal(r!.shell.createSymlink, false, "milo already on PATH");
  assert.equal(r!.shell.writeMiloHomeExport, false, "default home needs no export");
});

// ---- Paths ----

test("paths: editing the home tracks the worktrees default until worktrees is edited directly", async () => {
  const { stdin, unmount, result } = wizard({
    defaults: { miloHome: "", worktreeBase: "", standardMiloHome: "/Users/dev/.milo" },
    linearConnected: true,
  });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths

  // Type a custom home (focus starts on the .milo field).
  for (const ch of "/data/milo") await press(stdin, ch);
  await advance(stdin, 2); // paths → linear
  await press(stdin, ENTER); // linear (connected) → webhook
  await advance(stdin, 1); // webhook → options
  await advance(stdin, 1); // options → shell
  // Custom home ≠ standard home → the shell step shows the export row (default yes) + Finish.
  await advance(stdin, 1);
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.miloHome, "/data/milo");
  assert.equal(r!.worktreeBase, "/data/milo/worktrees", "worktrees tracked the custom home");
  assert.equal(r!.shell.writeMiloHomeExport, true, "non-default home defaults to writing the export");
});

test("paths: Tab completes the focused path field", async () => {
  const { stdin, lastFrame, unmount, result } = wizard({
    linearConnected: true,
    completePathFn: (input: string) => ({ completed: input + "-completed/", candidates: [] }),
  });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths

  await press(stdin, TAB);
  assert.match(lastFrame() ?? "", /\.milo-completed\//, "Tab completed the home field");

  await advance(stdin, 2); // paths → linear
  await press(stdin, ENTER); // → webhook
  await advance(stdin, 1); // → options
  await advance(stdin, 1); // → shell
  // Completed home ≠ standard home → export row + Finish.
  await advance(stdin, 1);
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.miloHome, "/Users/dev/.milo-completed/");
});

test("paths: ambiguous Tab completion lists the candidates", async () => {
  const { stdin, lastFrame, unmount } = wizard({
    linearConnected: true,
    completePathFn: () => ({ completed: "/Users/dev/.milo", candidates: ["alpha", "alphabet"] }),
  });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await press(stdin, TAB);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /alpha\s+alphabet/, "candidates rendered for an ambiguous completion");
});

// ---- Linear ----

test("linear: instructions, Authenticate success connects in-wizard and carries tokens", async () => {
  const calls: Array<{ clientId: string; clientSecret: string }> = [];
  const { stdin, lastFrame, unmount, result } = wizard({
    authenticate: async (creds) => {
      calls.push(creds);
      return { ok: true, token: "tok-1", refreshToken: "ref-1", actorName: "Milo", orgName: "Acme" };
    },
  });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear

  const instructions = lastFrame() ?? "";
  assert.match(instructions, /Connect Linear/);
  assert.match(instructions, /linear\.app\/settings\/api\/applications\/new/, "links to the OAuth app page");
  assert.match(instructions, /localhost:8989\/callback/, "states the callback URL");
  assert.match(instructions, /Client ID/, "asks for the client id");
  assert.doesNotMatch(instructions, /skip for now/i, "the skip toggle is gone");

  // Type creds, then Enter on the Authenticate row.
  for (const ch of "abc123") await press(stdin, ch);
  await press(stdin, ENTER); // → Client Secret field
  for (const ch of "s3cret") await press(stdin, ch);
  await press(stdin, ENTER); // → Authenticate row
  await press(stdin, ENTER); // run it
  await delay(60);

  assert.match(lastFrame() ?? "", /Connected as Milo in Acme/, "shows the connected identity");
  assert.deepEqual(calls, [{ clientId: "abc123", clientSecret: "s3cret" }]);

  // A successful authentication auto-advances to the next step.
  await delay(1100);
  assert.match(lastFrame() ?? "", /Webhook acceleration/, "auto-advanced to the webhook step");

  await advance(stdin, 1); // webhook → options
  await advance(stdin, 1); // options → shell
  await press(stdin, ENTER); // Finish
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.linear.connected, true);
  assert.equal(r!.linear.token, "tok-1", "token carried into the result");
  assert.equal(r!.linear.refreshToken, "ref-1");
  assert.equal(r!.linear.clientId, "abc123");
});

test("linear: Authenticate failure shows the error and stays retryable", async () => {
  const { stdin, lastFrame, unmount } = wizard({
    authenticate: async () => ({ ok: false, error: "Token exchange failed: bad creds" }),
  });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear

  for (const ch of "id") await press(stdin, ch);
  await press(stdin, ENTER);
  for (const ch of "secret") await press(stdin, ch);
  await press(stdin, ENTER); // → Authenticate
  await press(stdin, ENTER); // run it
  await delay(60);

  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /bad creds/, "the auth error is shown");
  assert.match(frame, /try again/, "the Authenticate button remains for a retry");
});

test("linear: Authenticate with empty fields prompts for credentials instead of running", async () => {
  let called = false;
  const { stdin, lastFrame, unmount } = wizard({
    authenticate: async () => {
      called = true;
      return { ok: false, error: "should not run" };
    },
  });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear
  await press(stdin, DOWN, DOWN, ENTER); // straight to Authenticate with no creds
  await delay(40);
  const frame = lastFrame() ?? "";
  unmount();
  assert.equal(called, false, "OAuth flow not started without credentials");
  assert.match(frame, /Enter the Client ID and Client Secret first/);
});

test("linear: Next is locked while credentials are typed but not authenticated", async () => {
  const { stdin, lastFrame, unmount, result } = wizard({});
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear

  for (const ch of "abc123") await press(stdin, ch); // type a client id only
  await advance(stdin, 3); // try to leave via Next
  const frame = lastFrame() ?? "";
  assert.match(frame, /Connect Linear/, "still on the Linear step — Next is locked");
  assert.match(frame, /authenticate first/, "explains why Next is locked");

  unmount();
  assert.equal(result(), undefined, "wizard never finished");
});

test("linear: skipping (no credentials, straight to Next) yields connected=false", async () => {
  const { stdin, unmount, result } = wizard({});
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear
  await advance(stdin, 3); // linear: down past id/secret/Authenticate to Next → webhook
  await advance(stdin, 1); // webhook → options
  await advance(stdin, 1); // options → shell
  await press(stdin, ENTER); // Finish
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.linear.connected, false, "no credentials -> nothing connected");
  assert.equal(r!.linear.token, undefined);
});

// ---- Webhook + options ----

test("webhook: toggling on flows into the result", async () => {
  const { stdin, unmount, result } = wizard({ linearConnected: true });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear
  await press(stdin, ENTER); // linear → webhook
  await press(stdin, RIGHT); // toggle on
  await advance(stdin, 1); // webhook → options
  await advance(stdin, 1); // options → shell
  await press(stdin, ENTER); // Finish
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.enableWebhook, true);
});

test("options: codex runner toggle appears when available; auto-merge flips with arrows", async () => {
  const { stdin, lastFrame, unmount, result } = wizard({ linearConnected: true, codexAvailable: true });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear
  await press(stdin, ENTER); // linear → webhook
  await advance(stdin, 1); // webhook → options

  const frame = lastFrame() ?? "";
  assert.match(frame, /default runner/, "codex option visible when codex is on PATH");

  await press(stdin, RIGHT); // runner: claude → codex
  await press(stdin, DOWN, RIGHT); // auto-merge: no → yes
  await advance(stdin, 1); // → shell
  await press(stdin, ENTER); // Finish
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.defaultRunner, "codex");
  assert.equal(r!.autoMerge, true);
});

// ---- Shell setup ----

test("shell: symlink row shows (default yes) when milo is not on PATH", async () => {
  const { stdin, lastFrame, unmount, result } = wizard({ linearConnected: true, miloOnPath: false });
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await advance(stdin, 2); // paths → linear
  await press(stdin, ENTER); // linear → webhook
  await advance(stdin, 1); // webhook → options
  await advance(stdin, 1); // options → shell

  const frame = lastFrame() ?? "";
  assert.match(frame, /add "milo" to PATH/, "symlink row shown");
  assert.match(frame, /\[yes\]/, "defaults to yes");

  await advance(stdin, 1); // down to Finish, Enter
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.shell.createSymlink, true, "default yes → create the symlink");
});

test("shell: symlink row can be toggled off", async () => {
  const { stdin, unmount, result } = wizard({ linearConnected: true, miloOnPath: false });
  await delay(40);
  await press(stdin, ENTER);
  await advance(stdin, 2);
  await press(stdin, ENTER);
  await advance(stdin, 1);
  await advance(stdin, 1);
  await press(stdin, RIGHT); // toggle symlink yes → no
  await advance(stdin, 1); // Finish
  unmount();

  const r = result();
  assert.ok(r);
  assert.equal(r!.shell.createSymlink, false);
});

// ---- Cancel ----

test("Esc cancels at any step without a result", async () => {
  const { stdin, unmount, result } = wizard({});
  await delay(40);
  await press(stdin, ENTER); // welcome → paths
  await press(stdin, ESC);
  unmount();
  assert.equal(result(), null, "cancelled -> onDone(null)");
});
