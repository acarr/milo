import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, delimiter } from "node:path";
import type { RunnerEvent, RunnerEventSink } from "@milo/core";
import { RunGuards, type GuardTimeouts } from "./guards.js";

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
  /** Override the run-guard timeouts (MILO-16). Tests use tiny values; production uses the defaults. */
  guards?: Partial<GuardTimeouts>;
  /** Override the binary to spawn — a test seam so guard behavior can be exercised with a fake CLI. */
  bin?: string;
}

export interface ClaudeRunResult {
  code: number;
  output: string;
  logFile: string;
}

/** Keys that must be unset so Claude Code uses the Max subscription (OAuth), not API billing. */
function cleanEnv(): NodeJS.ProcessEnv {
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

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);

/** Translate a Claude `tool_use` block into a normalized progress event. */
function toolEvent(name: string, input: Record<string, unknown>): RunnerEvent {
  const kind = FILE_TOOLS.has(name) ? "file-change" : "tool";
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  let text: string;
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "Update":
      text = `${name} ${str("file_path") || str("path")}`.trim();
      break;
    case "NotebookEdit":
      text = `NotebookEdit ${str("notebook_path")}`.trim();
      break;
    case "Bash":
      text = `$ ${str("command")}`.trim();
      break;
    case "Read":
      text = `Read ${str("file_path")}`.trim();
      break;
    case "Grep":
      text = `Grep ${str("pattern")}`.trim();
      break;
    case "Glob":
      text = `Glob ${str("pattern")}`.trim();
      break;
    case "Task":
      text = `Task: ${str("description")}`.trim();
      break;
    default:
      text = name;
  }
  return { kind, tool: name, text };
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
  args.push(opts.prompt);

  mkdirSync(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: "a" });

  return new Promise((resolve, reject) => {
    // stdin: "ignore" — the prompt is passed as an arg, so closing stdin avoids
    // claude -p's "no stdin data received in 3s" stall.
    // detached: true — the child leads its own process group, so the run guards can kill the whole
    // tree (claude + MCP servers + stray shells) when it hangs after finishing (MILO-16).
    const child = spawn(opts.bin ?? "claude", args, {
      cwd: opts.cwd,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";

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
      try {
        if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content as any[]) {
            if (block.type === "text" && typeof block.text === "string") {
              appendText(block.text);
              emit({ kind: "narration", text: block.text });
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              const e = toolEvent(block.name, (block.input ?? {}) as Record<string, unknown>);
              emit(e);
              opts.echo?.write(`• ${e.text}\n`);
            }
          }
        } else if (evt.type === "result" && typeof evt.result === "string") {
          // The final result text carries MILO_RESULT — keep it in `output` for the parser.
          output += (output.endsWith("\n") ? "" : "\n") + evt.result + "\n";
          if (evt.is_error) emit({ kind: "notice", text: `Run reported an error: ${evt.result}` });
          // The work is done; if the CLI lingers (MCP children holding it open), the guard kills it.
          guards.sawResult();
        }
      } catch {
        /* tolerate any unexpected event shape */
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
      log.end();
      reject(err);
    });
    child.on("close", (code) => {
      guards.clear();
      if (stdoutBuf.trim()) handleLine(stdoutBuf); // flush any partial trailing line
      log.end();
      // A guard kill after the final result is still a successful run — the output is complete and
      // the pipeline's verification gate re-derives the real outcome from git/GitHub state anyway.
      resolve({ code: guards.completedBeforeKill ? 0 : (code ?? 1), output, logFile: opts.logFile });
    });
  });
}
