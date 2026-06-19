/**
 * A normalized, runner-agnostic progress event. Each runner translates its own native
 * stream (Claude `stream-json`, Codex `--json`) into these, so `core` can map them onto
 * Linear agent-session activities without ever importing a runner.
 *
 *  - `narration`   — the agent's high-level prose ("now I'll add the endpoint")  → `thought`
 *  - `tool`        — a tool/command step (e.g. a Bash command)                    → `action`
 *  - `file-change` — an edit/write to a file                                      → `action`
 *  - `notice`      — an out-of-band signal worth surfacing (e.g. a non-fatal error)→ `thought`
 */
export type RunnerEventKind = "narration" | "tool" | "file-change" | "notice";

export interface RunnerEvent {
  kind: RunnerEventKind;
  /** Tool name for `tool`/`file-change` events (e.g. "Edit", "Bash"). */
  tool?: string;
  /** A one-line, human-readable summary (becomes the thought body / action parameter). */
  text: string;
}

/**
 * Optional progress sink a runner may call as it works. Best-effort and synchronous from the
 * runner's view — implementations must never throw and never block the run.
 */
export type RunnerEventSink = (event: RunnerEvent) => void;
