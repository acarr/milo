import { logger } from "./logger.js";

/**
 * Child-process death forensics.
 *
 * Milo used to be structurally blind to an external kill. Every `child.on("close", …)` handler in
 * the codebase bound only `code` and discarded Node's second `signal` argument, and a signalled
 * child reports `(code=null, signal="SIGTERM")` — so `code ?? 1` collapsed it to a plain `1` and the
 * signal was lost. Five runs died with `exit 143` across two months (WAZ-1346, WAZ-1356, WAZ-1482,
 * WAZ-1814, WAZ-1792) with nothing in `daemon.log` to say who killed them, or even that a signal
 * was involved.
 */

/** The signals worth recognizing in a 128+N exit status. */
const BY_NUMBER: Record<number, NodeJS.Signals> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/**
 * Best-effort "was this child signalled, and with what?".
 *
 * Two shapes mean the same thing to an operator. A child killed outright reports
 * `(code=null, signal="SIGTERM")`. A child that installs its own SIGTERM handler — `claude` does —
 * exits `128+N` under its own power, and Node reports `(code=143, signal=null)`.
 *
 * HEURISTIC, and deliberately so: a program may legitimately exit 143. Use this for DIAGNOSTICS
 * ONLY. It must never drive control flow or reach a runner result — see `runIncomplete`, which
 * reports a bare `signal` and an `exit 143` differently on purpose.
 */
export function likelySignal(code: number | null, signal: NodeJS.Signals | null): NodeJS.Signals | null {
  if (signal) return signal;
  if (code !== null && code > 128 && code < 160) return BY_NUMBER[code - 128] ?? null;
  return null;
}

export interface ChildExitContext {
  /** The binary, for grepping daemon.log (e.g. "claude", "codex", "bash"). */
  cmd: string;
  pid?: number;
  /** The child's process group when it leads one — with `detached: true`, pgid === pid. */
  pgid?: number;
  cwd?: string;
  logFile?: string;
}

/**
 * Log one line when a child died by a signal, whoever sent it. No-op for an ordinary exit, so this
 * is safe to call from every spawn wrapper.
 *
 * `pgid` matters: it is the number an operator needs to reconstruct what happened
 * (`ps -g <pgid>`, `kill -TERM -<pgid>`), and a `detached` runner's whole tree shares it — which is
 * also why a stray `pkill -f <path>` or a `kill 0` from inside the tree reaches the runner itself.
 */
export function logChildExit(ctx: ChildExitContext, code: number | null, signal: NodeJS.Signals | null): void {
  const inferred = likelySignal(code, signal);
  if (!inferred) return;
  logger.warn(
    {
      ...ctx,
      exitCode: code,
      signal: signal ?? undefined,
      inferredSignal: inferred,
      // false ⇒ the child handled the signal and exited 128+N itself, so the kill came from
      // outside this process (Milo's own killTree would leave Node reporting the signal directly).
      killedBySignal: signal !== null,
    },
    `child process died by ${inferred}`,
  );
}
