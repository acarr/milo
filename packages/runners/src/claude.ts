import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, delimiter } from "node:path";
import { logChildExit, type RunnerEvent, type RunnerEventSink } from "@milo/core";
import { RunGuards, onAbortKill, type GuardTimeouts } from "./guards.js";
import { mapStreamJsonEvent } from "./stream-json.js";

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  appendSystemPrompt?: string;
  logFile: string;
  /** Mirror the runner's output to this stream (e.g. process.stdout). */
  echo?: NodeJS.WritableStream;
  /** Receive normalized progress events as the run streams (best-effort). */
  onEvent?: RunnerEventSink;
  /** Abort the run (user-initiated cancel) — kills the whole runner process group. */
  signal?: AbortSignal;
  /** Override the run-guard timeouts (MILO-16). Tests use tiny values; production uses the defaults. */
  guards?: Partial<GuardTimeouts>;
  /** Override the binary to spawn — a test seam so guard behavior can be exercised with a fake CLI. */
  bin?: string;
  /** Cap on agentic turns (`--max-turns`), from the repo's `.milo/config.json`. Unlimited when unset. */
  maxTurns?: number;
}

export interface ClaudeRunResult {
  code: number;
  /**
   * The signal that killed the runner, when Node saw one. `null` for an ordinary exit — including a
   * process that caught the signal itself and exited 128+N, which is indistinguishable from a real
   * `exit 143` at this layer. A bare signal here (with no `errorDetail`) means the kill came from
   * outside Milo: our own guard kills always set `errorDetail`, and a cancel never reaches the
   * incomplete path.
   */
  signal?: NodeJS.Signals | null;
  output: string;
  logFile: string;
  /**
   * Why the run did not finish cleanly, when it didn't. A `claude -p` run that dies mid-response
   * still emits a terminal `result` event (with `is_error`) and can still exit 0, so the exit code
   * alone cannot tell a finished run from an abandoned one — and the verification gate must not
   * ship a half-written worktree as a completed implementation (WAZ-1150 / PR #707, 2026-08-07).
   */
  errorDetail?: string;
}

/**
 * The child environment: the daemon's env minus the keys that would flip Claude Code from the Max
 * subscription (OAuth) to API billing, plus the usual binary locations on PATH. Everything else is
 * inherited on purpose — in particular `GH_TOKEN`, which the daemon's launchd start script exports
 * so `gh pr create` inside the run (and in the verification gate) authenticates as the intended
 * GitHub identity. Exported so a test can pin that guarantee.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  delete env["CLAUDECODE"];
  delete env["CLAUDE_AGENT_SDK_VERSION"];
  delete env["__CFBundleIdentifier"];
  for (const k of Object.keys(env)) {
    if (k.startsWith("CLAUDE_CODE_")) delete env[k];
  }
  // Make sure the usual binary locations are reachable.
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${env["HOME"]}/.local/bin`];
  const parts = (env["PATH"] ?? "").split(delimiter);
  for (const p of extra) if (!parts.includes(p)) parts.unshift(p);
  env["PATH"] = parts.join(delimiter);
  return env;
}

/**
 * Run Claude Code headlessly on a prompt inside `cwd`, streaming + logging its output.
 *
 * Uses `--output-format stream-json` so we can surface structured progress (assistant narration,
 * tool calls, file edits) via `onEvent` while it works. The raw JSONL goes to `logFile` for
 * debugging; `output` is reconstructed as the agent's plain text (so the shared `MILO_RESULT`
 * parser still finds the final result line), and `echo` mirrors a readable rendering for the TUI.
 */
export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--model",
    opts.model,
    "--verbose",
    "--output-format",
    "stream-json",
  ];
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.maxTurns && Number.isFinite(opts.maxTurns) && opts.maxTurns > 0) args.push("--max-turns", String(opts.maxTurns));

  mkdirSync(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: "a" });

  return new Promise((resolve, reject) => {
    // stdin: "pipe" — the prompt is PIPED, not passed as an argv element, and stdin is closed
    // immediately after (which also avoids claude -p's "no stdin data received in 3s" stall).
    //
    // Keeping the prompt out of argv is a safety property, not a style choice. The prompt embeds
    // `<working_directory>/path/to/worktree`, which put that path in `ps` output — and made the
    // runner killable by a path-matching `pkill`. The chain that exploited it, verified on disk:
    //
    //   any worktree created anywhere in the repo (several agent tools do this)
    //     -> Claude Code's WorktreeCreate hook -> the repo's worktree-init.sh
    //       -> worktree-cleanup.sh --merged-only, which enumerates EVERY worktree
    //          `git worktree list` reports — Milo's included
    //         -> worktree-teardown.sh -> `pkill -f "$WORKTREE_PATH"`
    //           -> SIGTERM -> claude's own handler -> exit 143
    //
    // That killed five wazzon runs over two months (WAZ-1346, WAZ-1356, WAZ-1482, WAZ-1814,
    // WAZ-1792), always 2-3s after a successful tool action, always 143 and never 137 — a plain
    // SIGTERM, never a SIGKILL. Two of them died 4.0s apart in different worktrees, which is one
    // cleanup pass looping over its list. `ps`/`pkill -f` cannot see stdin, so piping the prompt
    // takes Milo out of that blast radius. Note the Codex runner is still exposed (it needs
    // `-C <cwd>` in argv).
    //
    // detached: true — the child leads its own process group, so the run guards can kill the whole
    // tree (claude + MCP servers + stray shells) when it hangs after finishing (MILO-16).
    const child = spawn(opts.bin ?? "claude", args, {
      cwd: opts.cwd,
      env: cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    // A child that dies before draining stdin gives us EPIPE; that's its `close` to report, not a
    // crash of the daemon.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.prompt);
    let output = "";
    let errorDetail: string | undefined;

    const emit = (e: RunnerEvent) => {
      try {
        opts.onEvent?.(e);
      } catch {
        /* a sink must never break the run */
      }
    };

    // Watchdogs for the three ways a runner outlives its usefulness: hanging after its result,
    // going silent, or running forever. Each kills the process group; `close` still fires and
    // resolves the promise below.
    const guards = new RunGuards(child.pid, opts.guards, (reason) => {
      const note = `\n[milo] runner guard fired: ${reason} — killing the runner process group\n`;
      log.write(note);
      opts.echo?.write(note);
      emit({ kind: "notice", text: `Runner guard fired: ${reason}` });
    });

    // User-initiated cancel: kill the whole runner tree. `close` still fires and resolves below;
    // the pipeline detects the cancel from its own AbortController and skips the verification gate.
    const disposeAbort = onAbortKill(opts.signal, child.pid, () => {
      const note = `\n[milo] cancellation requested — killing the runner process group\n`;
      log.write(note);
      opts.echo?.write(note);
      emit({ kind: "notice", text: "Cancellation requested — stopping the runner." });
    });

    /**
     * Resolve only once the run log is really flushed. `createWriteStream` opens lazily, so
     * `log.end()` returning does NOT mean the file is written — the pipeline reads `logFile`
     * immediately after this promise settles, and a test that cleans up its temp dir could race
     * the open and crash with ENOENT (cancel.test.ts, ~1 run in 3).
     */
    const finishLog = (): Promise<void> =>
      new Promise((res) => {
        let settled = false;
        const once = () => {
          if (settled) return;
          settled = true;
          res();
        };
        log.once("error", once); // a log we can't write must never hang or crash the run
        log.end(once);
      });

    /** Append plain text to the reconstructed output + mirror it to the echo stream. */
    const appendText = (s: string) => {
      output += s.endsWith("\n") ? s : s + "\n";
      opts.echo?.write(s.endsWith("\n") ? s : s + "\n");
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        // Not JSON (e.g. a stray warning) — treat as plain output so nothing is lost.
        appendText(line);
        return;
      }
      for (const item of mapStreamJsonEvent(evt)) {
        if (item.kind === "text") {
          appendText(item.text);
          emit({ kind: "narration", text: item.text });
        } else if (item.kind === "event") {
          emit(item.event);
          opts.echo?.write(`• ${item.event.text}\n`);
        } else {
          // The final result text carries MILO_RESULT — keep it in `output` for the parser.
          output += (output.endsWith("\n") ? "" : "\n") + item.text + "\n";
          if (item.isError) {
            errorDetail = item.text.trim().slice(0, 300);
            emit({ kind: "notice", text: `Run reported an error: ${item.text}` });
          }
          // The work is done; if the CLI lingers (MCP children holding it open), the guard kills it.
          guards.sawResult();
        }
      }
    };

    let stdoutBuf = "";
    child.stdout.on("data", (buf: Buffer) => {
      guards.touch();
      log.write(buf); // full-fidelity raw JSONL for debugging
      stdoutBuf += buf.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });

    child.stderr.on("data", (buf: Buffer) => {
      guards.touch();
      const s = buf.toString();
      output += s;
      log.write(s);
      opts.echo?.write(s);
    });

    child.on("error", (err) => {
      guards.clear();
      disposeAbort();
      void finishLog().then(() => reject(err));
    });
    child.on("close", (code, signal) => {
      guards.clear();
      disposeAbort();
      if (stdoutBuf.trim()) handleLine(stdoutBuf); // flush any partial trailing line
      // `detached: true` means the child leads its own group, so pgid === pid.
      logChildExit({ cmd: opts.bin ?? "claude", pid: child.pid, pgid: child.pid, cwd: opts.cwd, logFile: opts.logFile }, code, signal);
      // A guard kill after the final result is still a successful run — the output is complete and
      // the pipeline's verification gate re-derives the real outcome from git/GitHub state anyway.
      // A guard kill BEFORE any result means the run was abandoned mid-flight; say so, since the
      // exit code of a killed process doesn't distinguish that from an ordinary failure.
      if (!errorDetail && guards.killReason && !guards.completedBeforeKill) {
        errorDetail = `runner was killed: ${guards.killReason}`;
      }
      void finishLog().then(() => resolve({
        code: guards.completedBeforeKill ? 0 : (code ?? 1),
        // `signal` mirrors whatever `code` does — suppressed under completedBeforeKill for the same
        // reason. A post-result guard kill IS a success, and reporting its SIGTERM here would make
        // `runIncomplete` flip every one of them to needs-attention.
        signal: guards.completedBeforeKill ? null : (signal ?? null),
        output,
        logFile: opts.logFile,
        ...(errorDetail ? { errorDetail } : {}),
      }));
    });
  });
}
