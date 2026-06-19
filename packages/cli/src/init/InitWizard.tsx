import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import { completePath, type PathCompletion } from "./path-complete.js";

/**
 * The Phase A wizard of `milo init`: welcome → paths → Linear → webhooks → options → shell setup.
 *
 * Pure presentation (like AddRepo): environment detection happens before render and is passed in;
 * side effects (the Linear OAuth flow) are injected via the `authenticate` prop so the component
 * stays headlessly testable with ink-testing-library. The assembled choices are handed to
 * `onDone` (null when cancelled) for the orchestrator to act on (write config, install the
 * daemon, apply shell setup, then Phase B).
 */

export interface InitDefaults {
  miloHome: string;
  worktreeBase: string;
  /** What miloHome resolves to with no MILO_HOME env override (~/.milo) — drives the shell-export row. */
  standardMiloHome: string;
}

export type AuthOutcome =
  | { ok: true; token: string; refreshToken: string; actorName: string; orgName: string }
  | { ok: false; error: string };

export interface InitResult {
  miloHome: string;
  worktreeBase: string;
  /** Linear connection state; tokens are present when the in-wizard Authenticate succeeded. */
  linear: { connected: boolean; clientId: string; clientSecret: string; token?: string; refreshToken?: string };
  /** "claude" unless the user opts into Codex as the default runner. */
  defaultRunner: "claude" | "codex";
  enableWebhook: boolean;
  autoMerge: boolean;
  shell: { createSymlink: boolean; writeMiloHomeExport: boolean };
}

type Step = "welcome" | "paths" | "linear" | "webhook" | "options" | "shell";

const YES_NO = ["no", "yes"] as const;

const CAT = ["  /\\_/\\", " ( o.o )", "  > ^ <"];

export function InitWizard({
  defaults,
  codexAvailable,
  linearConnected,
  configExists,
  miloOnPath,
  authenticate,
  completePathFn = completePath,
  onDone,
}: {
  defaults: InitDefaults;
  /** True when the codex CLI is on PATH — the Codex option is only shown then. */
  codexAvailable: boolean;
  /** True when config.json already holds a Linear token — the Linear step becomes a no-op. */
  linearConnected: boolean;
  /** True when a config.json already exists — init edits it, never silently overwrites. */
  configExists: boolean;
  /** True when `milo` already resolves on PATH — hides the symlink row of the shell step. */
  miloOnPath: boolean;
  /** Runs the Linear OAuth flow (injected; tests stub it, init wires runLinearOAuth). */
  authenticate: (creds: { clientId: string; clientSecret: string }, signal?: AbortSignal) => Promise<AuthOutcome>;
  /** Tab-completion for path fields (injected for tests). */
  completePathFn?: (input: string) => PathCompletion;
  onDone: (result: InitResult | null) => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("welcome");

  // Step: paths. worktrees tracks the home until the user edits it directly.
  const [miloHome, setMiloHome] = useState(defaults.miloHome);
  const [worktreeBase, setWorktreeBase] = useState(defaults.worktreeBase);
  const [worktreeTouched, setWorktreeTouched] = useState(false);
  const [pathsFocus, setPathsFocus] = useState(0); // 0=home 1=worktrees 2=Next
  const [pathCandidates, setPathCandidates] = useState<string[]>([]);

  // Step: linear.
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [linearFocus, setLinearFocus] = useState(0); // 0=clientId 1=clientSecret 2=Authenticate 3=Next
  const [authState, setAuthState] = useState<"idle" | "authenticating" | "connected" | "error">("idle");
  const [authError, setAuthError] = useState("");
  const [authIdentity, setAuthIdentity] = useState("");
  const authTokens = useRef<{ token: string; refreshToken: string } | null>(null);
  const authAbort = useRef<AbortController | null>(null);
  const authAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once creds are typed, Next locks until auth succeeds (clearing the fields re-enables skip).
  const credsTyped = !!clientId.trim() || !!clientSecret.trim();
  const linearNextEnabled = linearConnected || authState === "connected" || !credsTyped;

  // Step: webhook.
  const [webhookIdx, setWebhookIdx] = useState(0); // no/yes
  const [webhookFocus, setWebhookFocus] = useState(0); // 0=toggle 1=Next

  // Step: options.
  const [runnerIdx, setRunnerIdx] = useState(0); // 0=claude 1=codex
  const [autoMergeIdx, setAutoMergeIdx] = useState(0); // no/yes
  const [optFocus, setOptFocus] = useState(0);
  const optRows = codexAvailable ? 2 : 1; // last row index = Next

  // Step: shell setup — both default to yes; rows hide when nothing to do.
  const [symlinkIdx, setSymlinkIdx] = useState(1);
  const [exportIdx, setExportIdx] = useState(1);
  const [shellFocus, setShellFocus] = useState(0);
  const homeDiffers = (miloHome.trim() || defaults.miloHome) !== defaults.standardMiloHome;
  const shellRows: ("symlink" | "export")[] = [
    ...(!miloOnPath ? (["symlink"] as const) : []),
    ...(homeDiffers ? (["export"] as const) : []),
  ];

  const setHome = (v: string) => {
    setMiloHome(v);
    if (!worktreeTouched) setWorktreeBase(v ? `${v}/worktrees` : "");
  };

  const finish = () => {
    const home = miloHome.trim() || defaults.miloHome;
    onDone({
      miloHome: home,
      worktreeBase: worktreeBase.trim() || `${home}/worktrees`,
      linear: {
        connected: linearConnected || authState === "connected",
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(authTokens.current ?? {}),
      },
      defaultRunner: codexAvailable && runnerIdx === 1 ? "codex" : "claude",
      enableWebhook: webhookIdx === 1,
      autoMerge: autoMergeIdx === 1,
      shell: {
        createSymlink: !miloOnPath && symlinkIdx === 1,
        writeMiloHomeExport: homeDiffers && exportIdx === 1,
      },
    });
    exit();
  };

  const cancel = () => {
    authAbort.current?.abort();
    if (authAdvanceTimer.current) clearTimeout(authAdvanceTimer.current);
    onDone(null);
    exit();
  };

  const startAuth = () => {
    if (authState === "authenticating" || authState === "connected") return;
    if (!clientId.trim() || !clientSecret.trim()) {
      setAuthState("error");
      setAuthError("Enter the Client ID and Client Secret first.");
      return;
    }
    setAuthState("authenticating");
    setAuthError("");
    const controller = new AbortController();
    authAbort.current = controller;
    authenticate({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }, controller.signal)
      .then((r) => {
        if (r.ok) {
          authTokens.current = { token: r.token, refreshToken: r.refreshToken };
          setAuthIdentity(`${r.actorName} in ${r.orgName}`);
          setAuthState("connected");
          // A successful authentication IS the step's goal — show the identity, then move on.
          authAdvanceTimer.current = setTimeout(() => setStep("webhook"), 1000);
        } else {
          setAuthState("error");
          setAuthError(r.error);
        }
      })
      .catch((err) => {
        setAuthState("error");
        setAuthError((err as Error).message);
      });
  };

  const editText = (
    value: string,
    set: (v: string) => void,
    input: string,
    key: { backspace?: boolean; delete?: boolean; tab?: boolean },
  ) => {
    if (key.backspace || key.delete) set(value.slice(0, -1));
    else if (input && input !== "\t" && !key.tab) set(value + input);
  };

  useInput((input, key) => {
    if (key.escape) return cancel();

    if (step === "welcome") {
      if (key.return) setStep("paths");
      return;
    }

    if (step === "paths") {
      if (key.upArrow) return setPathsFocus((f) => Math.max(0, f - 1));
      if (key.downArrow) return setPathsFocus((f) => Math.min(2, f + 1));
      if (key.return) {
        setPathCandidates([]);
        if (pathsFocus === 2) return setStep("linear");
        return setPathsFocus((f) => Math.min(2, f + 1));
      }
      if (key.tab) {
        // Shell-style completion on whichever path field is focused.
        if (pathsFocus === 0) {
          const r = completePathFn(miloHome);
          setHome(r.completed);
          setPathCandidates(r.candidates);
        } else if (pathsFocus === 1) {
          const r = completePathFn(worktreeBase);
          setWorktreeTouched(true);
          setWorktreeBase(r.completed);
          setPathCandidates(r.candidates);
        }
        return;
      }
      setPathCandidates([]);
      if (pathsFocus === 0) editText(miloHome, setHome, input, key);
      else if (pathsFocus === 1) {
        setWorktreeTouched(true);
        editText(worktreeBase, setWorktreeBase, input, key);
      }
      return;
    }

    if (step === "linear") {
      if (linearConnected) {
        if (key.return) setStep("webhook");
        return;
      }
      // While the browser flow is in flight, only Esc (handled above) gets through.
      if (authState === "authenticating") return;
      // Once connected, the Authenticate row (2) disappears — navigation skips over it.
      const skipAuthRow = (f: number, dir: 1 | -1) => (f === 2 && authState === "connected" ? f + dir : f);
      if (key.upArrow) return setLinearFocus((f) => skipAuthRow(Math.max(0, f - 1), -1));
      if (key.downArrow) return setLinearFocus((f) => skipAuthRow(Math.min(3, f + 1), 1));
      if (key.return) {
        if (linearFocus === 2) return startAuth();
        if (linearFocus === 3) {
          if (!linearNextEnabled) return; // creds typed but not authenticated — Next is locked
          return setStep("webhook");
        }
        return setLinearFocus((f) => skipAuthRow(Math.min(3, f + 1), 1));
      }
      if (linearFocus === 0) editText(clientId, setClientId, input, key);
      else if (linearFocus === 1) editText(clientSecret, setClientSecret, input, key);
      return;
    }

    if (step === "webhook") {
      if (key.upArrow) return setWebhookFocus((f) => Math.max(0, f - 1));
      if (key.downArrow) return setWebhookFocus((f) => Math.min(1, f + 1));
      if (key.return) {
        if (webhookFocus === 1) return setStep("options");
        return setWebhookFocus(1);
      }
      if (webhookFocus === 0 && (key.leftArrow || key.rightArrow)) setWebhookIdx((i) => (i + 1) % 2);
      return;
    }

    if (step === "options") {
      if (key.upArrow) return setOptFocus((f) => Math.max(0, f - 1));
      if (key.downArrow) return setOptFocus((f) => Math.min(optRows, f + 1));
      if (key.return) {
        if (optFocus === optRows) return setStep("shell");
        return setOptFocus((f) => Math.min(optRows, f + 1));
      }
      if (key.leftArrow || key.rightArrow) {
        let row = optFocus;
        if (codexAvailable) {
          if (row === 0) return setRunnerIdx((i) => (i + 1) % 2);
          row -= 1;
        }
        if (row === 0) setAutoMergeIdx((i) => (i + 1) % 2);
      }
      return;
    }

    // step === "shell"
    if (key.upArrow) return setShellFocus((f) => Math.max(0, f - 1));
    if (key.downArrow) return setShellFocus((f) => Math.min(shellRows.length, f + 1));
    if (key.return) {
      if (shellFocus === shellRows.length) return finish();
      return setShellFocus((f) => Math.min(shellRows.length, f + 1));
    }
    if (key.leftArrow || key.rightArrow) {
      const row = shellRows[shellFocus];
      if (row === "symlink") setSymlinkIdx((i) => (i + 1) % 2);
      else if (row === "export") setExportIdx((i) => (i + 1) % 2);
    }
  });

  const field = (label: string, value: string, focused: boolean, hint?: string) => (
    <Box>
      <Text color={focused ? "cyan" : undefined}>{focused ? "› " : "  "}</Text>
      <Text dimColor>{label.padEnd(16)}</Text>
      <Text color={focused ? "cyan" : undefined}>{value || <Text dimColor>(empty)</Text>}</Text>
      {focused && hint ? <Text dimColor>{`   ${hint}`}</Text> : null}
    </Box>
  );

  const toggleRow = (label: string, value: string, focused: boolean, hint = "←/→ to change") => (
    <Box>
      <Text color={focused ? "cyan" : undefined}>{focused ? "› " : "  "}</Text>
      <Text dimColor>{label.padEnd(20)}</Text>
      <Text color={focused ? "cyan" : undefined}>[{value}]</Text>
      {focused ? <Text dimColor>{`   ${hint}`}</Text> : null}
    </Box>
  );

  const action = (label: string, focused: boolean, hint: string, disabled = false) => (
    <Box marginTop={1}>
      <Text color={focused && !disabled ? "cyan" : undefined} dimColor={disabled}>
        {focused ? "› " : "  "}
      </Text>
      <Text bold={!disabled} dimColor={disabled} color={focused && !disabled ? "cyan" : undefined}>
        {label}
      </Text>
      {focused ? <Text dimColor>{`   ${hint}`}</Text> : null}
    </Box>
  );

  /** Step title: bold + orange, with its body starting on the very next line. */
  const title = (text: string) => (
    <Text bold color="#ff9900">
      {text}
    </Text>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      {step === "welcome" && (
        <Box flexDirection="column">
          <Box flexDirection="column">
            <Text color="yellow">{CAT[0]}</Text>
            <Box>
              <Text color="yellow">{CAT[1]}</Text>
              <Text bold>{"   Welcome to Milo"}</Text>
            </Box>
            <Text color="yellow">{CAT[2]}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>Milo is an autonomous coding agent that runs on your machine.</Text>
            <Text>
              Assign it a Linear ticket or @milo a GitHub PR, and it implements the change,
            </Text>
            <Text>verifies it, and opens a pull request — all locally.</Text>
          </Box>
          {configExists && (
            <Box marginTop={1}>
              <Text color="yellow">
                A config already exists — setup will keep its values and only fill in gaps (it
                never overwrites repos or credentials).
              </Text>
            </Box>
          )}
          {action("Start", true, "Enter to begin")}
        </Box>
      )}

      {step !== "welcome" && (
        <Box marginTop={1}>
          <Text bold>Milo setup</Text>
        </Box>
      )}

      {step === "paths" && (
        <Box marginTop={1} flexDirection="column">
          {title("Where should Milo live?")}
          <Box flexDirection="column">
            {field(".milo", miloHome, pathsFocus === 0, "Milo's home — config, database, and logs")}
            {field("worktrees", worktreeBase, pathsFocus === 1, "where Milo checks out code")}
          </Box>
          {pathCandidates.length > 1 && (
            <Box marginTop={1}>
              <Text dimColor>{pathCandidates.slice(0, 8).join("  ")}</Text>
            </Box>
          )}
          {action("Next", pathsFocus === 2, "Enter to continue")}
        </Box>
      )}

      {step === "linear" && linearConnected && (
        <Box marginTop={1} flexDirection="column">
          {title("Connect Linear")}
          <Box>
            <Text color="green">✓ Linear is already connected.</Text>
          </Box>
          {action("Next", true, "Enter to continue")}
        </Box>
      )}

      {step === "linear" && !linearConnected && (
        <Box marginTop={1} flexDirection="column">
          {title("Connect Linear")}
          <Box flexDirection="column">
            <Text dimColor>
              Milo registers as a Linear agent so you can delegate tickets to it, and it can post
            </Text>
            <Text dimColor>progress and updates back on the issue.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>1. Create a Linear OAuth app: https://linear.app/settings/api/applications/new</Text>
            <Text dimColor>{"     • Callback URL:  http://localhost:8989/callback"}</Text>
            <Text dimColor>{"     • Enable \"Agent session events\""}</Text>
            <Text>2. Paste its Client ID below</Text>
            <Text>3. Paste its Client Secret below</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {field("Client ID", clientId, linearFocus === 0)}
            {field("Client Secret", clientSecret ? "•".repeat(clientSecret.length) : "", linearFocus === 1)}
          </Box>
          {authState === "idle" && action("Authenticate", linearFocus === 2, "opens your browser for approval")}
          {authState === "authenticating" && (
            <Box marginTop={1}>
              <Text color="cyan">⏳ Waiting for browser approval… (Esc to cancel)</Text>
            </Box>
          )}
          {authState === "connected" && (
            <Box marginTop={1}>
              <Text color="green">✓ Connected as {authIdentity}</Text>
            </Box>
          )}
          {authState === "error" && (
            <Box marginTop={1} flexDirection="column">
              <Text color="red">✗ {authError}</Text>
              {action("Authenticate", linearFocus === 2, "try again")}
            </Box>
          )}
          {action(
            "Next",
            linearFocus === 3,
            authState === "connected"
              ? "Enter to continue"
              : credsTyped
                ? "authenticate first — or clear the fields to skip"
                : "Enter to skip — `milo linear-auth` works later",
            !linearNextEnabled,
          )}
        </Box>
      )}

      {step === "webhook" && (
        <Box marginTop={1} flexDirection="column">
          {title("Webhook acceleration")}
          <Box flexDirection="column">
            <Text dimColor>Milo polls Linear and GitHub for new work. Webhooks let it react instantly</Text>
            <Text dimColor>instead of waiting for the next poll. They need a public HTTPS URL</Text>
            <Text dimColor>(e.g. a Tailscale Funnel) — you can finish that part later.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {toggleRow("enable webhooks", YES_NO[webhookIdx]!, webhookFocus === 0)}
          </Box>
          {action("Next", webhookFocus === 1, "Enter to continue")}
        </Box>
      )}

      {step === "options" && (
        <Box marginTop={1} flexDirection="column">
          {title("Options")}
          <Box flexDirection="column">
            {codexAvailable && toggleRow("default runner", runnerIdx === 1 ? "codex" : "claude", optFocus === 0)}
            {toggleRow("auto-merge PRs", YES_NO[autoMergeIdx]!, optFocus === (codexAvailable ? 1 : 0))}
          </Box>
          {action("Next", optFocus === optRows, "Enter to continue")}
        </Box>
      )}

      {step === "shell" && (
        <Box marginTop={1} flexDirection="column">
          {title("Shell setup")}
          {shellRows.length === 0 ? (
            <Box>
              <Text color="green">✓ Your shell is already set up — `milo` works from anywhere.</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text dimColor>Make `milo` available everywhere:</Text>
              <Box marginTop={1} flexDirection="column">
                {shellRows.map((row, i) =>
                  row === "symlink" ? (
                    <Box key="symlink" flexDirection="column">
                      {toggleRow('add "milo" to PATH', YES_NO[symlinkIdx]!, shellFocus === i)}
                      {shellFocus === i && (
                        <Text dimColor>{"     symlinks ~/.local/bin/milo so the `milo` command works in any terminal"}</Text>
                      )}
                    </Box>
                  ) : (
                    <Box key="export" flexDirection="column">
                      {toggleRow("save Milo's home", YES_NO[exportIdx]!, shellFocus === i)}
                      {shellFocus === i && (
                        <Text dimColor>{`     adds export MILO_HOME="${miloHome.trim() || defaults.miloHome}" to your shell profile so milo finds it`}</Text>
                      )}
                    </Box>
                  ),
                )}
              </Box>
            </Box>
          )}
          {action("Finish", shellFocus === shellRows.length, "Enter to finish setup")}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {step === "paths"
            ? "↑/↓ move · Tab complete path · Enter next · Esc cancel"
            : "↑/↓ move · Enter next · Esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
