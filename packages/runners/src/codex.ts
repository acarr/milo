import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RunnerEvent, RunnerEventSink } from "@milo/core";
import { RunGuards, onAbortKill, type GuardTimeouts } from "./guards.js";

export interface CodexRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  /** Folded into the prompt (codex exec has no --append-system-prompt). */
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
}

export interface CodexRunResult {
  code: number;
  output: string;
  logFile: string;
}

/**
 * Keys to unset so Codex uses the ChatGPT subscription (~/.codex/auth.json), not API billing,
 * and so no Claude/Anthropic env leaks in.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDECODE",
    "CLAUDE_AGENT_SDK_VERSION",
    "__CFBundleIdentifier",
  ]) {
    delete env[k];
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith("CLAUDE_CODE_")) delete env[k];
  }
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${env["HOME"]}/.local/bin`];
  const parts = (env["PATH"] ?? "").split(delimiter);
  for (const p of extra) if (!parts.includes(p)) parts.unshift(p);
  env["PATH"] = parts.join(delimiter);
  return env;
}

/**
 * Translate a Codex `--json` event into a normalized progress event (best-effort).
 *
 * Codex's event schema has shifted across versions (the older `{msg:{type}}` envelope and the
 * newer `{type:"item.*", item:{type}}` one), so we parse both shapes defensively and return
 * `undefined` for anything we don't recognize — an unknown shape simply yields no progress.
 */
function codexEvent(evt: any): RunnerEvent | undefined {
  const msg = evt?.msg ?? evt;
  const item = evt?.item ?? msg?.item;
  const type: string = item?.type ?? msg?.type ?? evt?.type ?? "";

  const asCommand = (c: unknown): string =>
    Array.isArray(c) ? c.map(String).join(" ") : typeof c === "string" ? c : "";

  if (/agent_message|assistant_message|agent_reasoning/.test(type)) {
    const text = item?.text ?? msg?.message ?? msg?.text ?? evt?.text;
    if (typeof text === "string" && text.trim()) return { kind: "narration", text };
    return undefined;
  }
  if (/command|exec/.test(type)) {
    const cmd = asCommand(item?.command ?? msg?.command);
    if (cmd) return { kind: "tool", tool: "Bash", text: `$ ${cmd}` };
    return undefined;
  }
  if (/patch|file_change|apply/.test(type)) {
    const changes = item?.changes ?? msg?.changes;
    const files = changes && typeof changes === "object" ? Object.keys(changes) : [];
    const where = files.length ? files.join(", ") : (item?.path ?? "");
    return { kind: "file-change", tool: "Edit", text: `Edited ${where}`.trim() };
  }
  return undefined;
}

/**
 * The repo's real git directory (`git rev-parse --git-common-dir`, absolute). For a linked worktree
 * this is `<main>/.git` — and the worktree's own index/HEAD/locks live under it at
 * `worktrees/<name>`, OUTSIDE the worktree dir. Codex's `workspace-write` sandbox only makes `cwd`
 * writable, so without this Codex can't create `index.lock` and leaves the tree dirty. Returns
 * undefined if git can't resolve it (then the verification gate is the backstop, as before).
 */
function gitCommonDir(cwd: string): string | undefined {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0 || !out) return undefined;
  return resolve(cwd, out);
}

/**
 * Run Codex headlessly on a prompt inside `cwd` (sandbox `workspace-write`, never
 * `danger-full-access`), streaming + logging its output. We add the repo's git dir to the sandbox's
 * `writable_roots` so Codex can commit/push/open a PR itself — like Claude — instead of leaving a
 * dirty tree for the gate (which still backstops). The agent's final message is captured via
 * `--output-last-message` and appended to the returned output as a clean block, so the shared
 * MILO_RESULT parser finds it without wading through JSONL escaping.
 */
export function runCodex(opts: CodexRunOptions): Promise<CodexRunResult> {
  const prompt = opts.appendSystemPrompt
    ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  const lastMsgFile = join(tmpdir(), `milo-codex-${process.pid}-${Date.now()}.txt`);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    // Let the agent push/open PRs itself; Milo's verification gate is the backstop either way.
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-C",
    opts.cwd,
    "--output-last-message",
    lastMsgFile,
  ];
  // Make the repo's git dir writable so Codex can commit/push (its worktree's git metadata lives
  // outside `cwd`). Without it Codex can't create index.lock and leaves a dirty tree for the gate.
  const gitDir = gitCommonDir(opts.cwd);
  if (gitDir) args.push("-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(gitDir)}]`);
  if (opts.model && opts.model !== "default") args.push("-m", opts.model);
  args.push(prompt);

  mkdirSync(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: "a" });

  return new Promise((resolve, reject) => {
    // detached: true — the child leads its own process group, so the run guards can kill the whole
    // tree if it goes silent or runs forever (MILO-16). Codex has no reliable terminal stream event,
    // so only the inactivity + wall-clock guards apply (completion is signaled by process exit).
    const child = spawn(opts.bin ?? "codex", args, {
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

    let stdoutBuf = "";
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const e = codexEvent(JSON.parse(trimmed));
        if (e) {
          emit(e);
          opts.echo?.write(`• ${e.text}\n`);
        }
      } catch {
        /* non-JSON or unexpected shape — ignore for progress (raw output is still captured) */
      }
    };

    child.stdout.on("data", (buf: Buffer) => {
      guards.touch();
      const s = buf.toString();
      output += s; // keep full JSONL so --output-last-message backstop + parser still work
      log.write(s);
      stdoutBuf += s;
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
      log.end();
      reject(err);
    });
    child.on("close", (code) => {
      guards.clear();
      disposeAbort();
      // Append the clean final message so MILO_RESULT is parseable (JSONL escapes it otherwise).
      let lastMsg = "";
      try {
        lastMsg = readFileSync(lastMsgFile, "utf8");
      } catch {
        /* no final message file — fall back to scanning the JSONL */
      } finally {
        try {
          rmSync(lastMsgFile);
        } catch {
          /* ignore */
        }
      }
      if (lastMsg) {
        const block = `\n\n--- codex final message ---\n${lastMsg}\n`;
        output += block;
        log.write(block);
      }
      log.end();
      resolve({ code: code ?? 1, output, logFile: opts.logFile });
    });
  });
}
