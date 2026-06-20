import type { RunnerEvent } from "./runner-events.js";

/**
 * Streams a runner's normalized progress into Linear agent-session activities while it works.
 *
 * The whole point is the *shape of the pipe*: a naive "post every event" floods the chat, trips
 * Linear's rate limits, and leaks low-signal noise. So this module does three things:
 *   1. **Signal filter** — surface high-value steps (edits, commands, milestone narration);
 *      suppress noise (file reads, greps, internal chatter) per a verbosity knob.
 *   2. **Throttle + coalesce** — at most one activity per `minIntervalMs`; a burst inside that
 *      window collapses into a single summarized `thought`. Never one post per token.
 *   3. **Best-effort, non-blocking** — a failed/limited post never throws and never stalls the
 *      job; repeated failures (likely a Linear 429) back the cadence off exponentially.
 */

export type Verbosity = "quiet" | "normal" | "verbose";

export interface ProgressPoster {
  /** Post a `thought` activity (narration). Resolves false on failure (e.g. rate limit). */
  thought(body: string): Promise<boolean>;
  /** Post an `action` activity (a tool/file step). Resolves false on failure. */
  action(action: string, parameter: string, result?: string): Promise<boolean>;
}

export interface ProgressOptions {
  enabled?: boolean;
  verbosity?: Verbosity;
  minIntervalMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_LEN = 200;

/** Tools whose use is itself a meaningful, surfaced step. */
const FILE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Update",
  "ApplyPatch",
  "apply_patch",
]);
/** Low-signal tools — suppressed unless verbosity is `verbose`. */
const LOW_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
  "NotebookRead",
]);

const SECRET_PATTERNS: RegExp[] = [
  /lin_(oauth|api)_[A-Za-z0-9]+/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace obvious secrets (OAuth/API tokens, JWTs, private-key headers) with a placeholder. */
export function redactSecrets(s: string): string {
  let out = s ?? "";
  for (const p of SECRET_PATTERNS) out = out.replace(p, "«redacted»");
  return out;
}

/** Collapse whitespace, redact obvious secrets, and bound length — nothing huge or sensitive leaks. */
export function sanitize(s: string, max = MAX_LEN): string {
  let out = redactSecrets((s ?? "").replace(/\s+/g, " ").trim());
  if (out.length > max) out = out.slice(0, max - 1) + "…";
  return out;
}

const MILESTONE = /\b(test|build|lint|typecheck|commit|push|pull request|\bpr\b|deploy|migrat|fix|implement|fail|pass|error)/i;
const TEST_CMD = /\b(test|jest|vitest|pytest|build|lint|tsc|typecheck|pnpm|npm run|yarn|cargo|go test|make)\b/i;

/** The signal filter: decide whether an event is worth a Linear activity at this verbosity. */
export function shouldPost(event: RunnerEvent, verbosity: Verbosity): boolean {
  switch (event.kind) {
    case "file-change":
      return true; // edits/writes are always high-signal
    case "notice":
      return true;
    case "tool": {
      const tool = event.tool ?? "";
      if (LOW_TOOLS.has(tool)) return verbosity === "verbose";
      if (verbosity === "quiet") return TEST_CMD.test(event.text); // only milestone-ish commands
      return true;
    }
    case "narration": {
      const t = event.text.trim();
      if (t.length < 12) return false; // skip terse filler ("ok", "done.")
      if (verbosity === "quiet") return MILESTONE.test(t);
      return true;
    }
    default:
      return false;
  }
}

/** Coalesce a burst of events into one readable line, leading with the latest narration if any. */
export function summarize(batch: RunnerEvent[]): string {
  const files = batch.filter((e) => e.kind === "file-change");
  const tools = batch.filter((e) => e.kind === "tool");
  const narration = batch.filter((e) => e.kind === "narration" || e.kind === "notice");

  const counts: string[] = [];
  if (files.length) counts.push(`edited ${files.length} file${files.length > 1 ? "s" : ""}`);
  if (tools.length) counts.push(`ran ${tools.length} step${tools.length > 1 ? "s" : ""}`);

  const lead = narration.length ? sanitize(narration[narration.length - 1]!.text, 140) : "";
  const tail = counts.join(", ");
  if (lead && tail) return sanitize(`${lead} (${tail})`);
  if (lead) return lead;
  if (tail) return sanitize(tail.charAt(0).toUpperCase() + tail.slice(1));
  return "Working…";
}

type Activity = { type: "thought"; body: string } | { type: "action"; action: string; parameter: string };

/** Map a (possibly coalesced) batch to a single Linear activity. Pure — easy to unit-test. */
export function buildActivity(batch: RunnerEvent[]): Activity {
  if (batch.length === 1) {
    const e = batch[0]!;
    if (e.kind === "narration" || e.kind === "notice") return { type: "thought", body: sanitize(e.text) };
    return { type: "action", action: e.tool ?? "step", parameter: sanitize(e.text) };
  }
  return { type: "thought", body: summarize(batch) };
}

export class ProgressStreamer {
  private buffer: RunnerEvent[] = [];
  private lastPostAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<unknown> = Promise.resolve();
  private interval: number;
  private readonly baseInterval: number;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly verbosity: Verbosity;
  private stopped = false;

  constructor(
    private readonly poster: ProgressPoster,
    opts: ProgressOptions = {},
  ) {
    this.enabled = opts.enabled ?? true;
    this.verbosity = opts.verbosity ?? "normal";
    this.baseInterval = Math.max(0, opts.minIntervalMs ?? DEFAULT_INTERVAL_MS);
    this.interval = this.baseInterval;
    this.now = opts.now ?? Date.now;
  }

  /** Feed one normalized event. Filters, buffers, and posts subject to the throttle. Never throws. */
  handle(event: RunnerEvent): void {
    if (!this.enabled || this.stopped) return;
    if (!shouldPost(event, this.verbosity)) return;
    this.buffer.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    const wait = Math.max(0, this.lastPostAt + this.interval - this.now());
    if (wait === 0) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
    // Don't keep the process alive just for a progress post.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.lastPostAt = this.now();
    const post = this.post(batch);
    this.inflight = post;
    const ok = await post;
    // Adaptive backoff: a failed post is most likely a Linear rate-limit — widen the window
    // rather than queue unboundedly. A success resets to the configured cadence.
    this.interval = ok === false ? Math.min(this.interval * 2, MAX_BACKOFF_MS) : this.baseInterval;
    if (this.buffer.length && !this.timer && !this.stopped) this.schedule();
  }

  private async post(batch: RunnerEvent[]): Promise<boolean> {
    try {
      const a = buildActivity(batch);
      return a.type === "thought" ? await this.poster.thought(a.body) : await this.poster.action(a.action, a.parameter);
    } catch {
      return false; // best-effort: a posting failure must never surface to the job
    }
  }

  /**
   * Flush whatever is pending and stop accepting events. Call this BEFORE posting the terminal
   * `response`/`error` so the final activity always lands last and ordering stays sane.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.stopped && this.buffer.length) {
      const batch = this.buffer;
      this.buffer = [];
      this.inflight = this.post(batch); // final flush ignores the throttle
    }
    this.stopped = true;
    try {
      await this.inflight;
    } catch {
      /* best-effort */
    }
  }

  /** Test hook: await the most recent in-flight post. */
  async settled(): Promise<void> {
    try {
      await this.inflight;
    } catch {
      /* ignore */
    }
  }

  /** Test hook: the current (possibly backed-off) interval. */
  get currentIntervalMs(): number {
    return this.interval;
  }
}
