/**
 * Per-job transcript persistence (the local, UI-safe record of what a runner did).
 *
 * The runner's normalized `RunnerEvent` stream already feeds `ProgressStreamer` → Linear, but that
 * is (a) Linear-only and (b) only constructed for delegated jobs. To let the TUI / `milo watch`
 * show a live, replayable transcript for ANY job, we tee the same stream into a per-job JSONL file.
 *
 * Invariants:
 *  - **Best-effort, never blocks the run** — append via a buffered `createWriteStream`; every write
 *    is try/caught and the stream's `error` is swallowed (disk-full / perms must not break a job).
 *  - **Redacted at the sink** — `ProgressStreamer` only redacts what it posts, so we redact here too;
 *    this file is the safe artifact the UI reads, never the raw (unredacted) stream-json log.
 */
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logsDir } from "./paths.js";
import { redactSecrets } from "./progress.js";
import type { RunnerEvent, RunnerEventSink } from "./runner-events.js";

export interface PersistedEvent {
  kind: RunnerEvent["kind"];
  tool?: string;
  text: string;
  at: number;
}

/** Keep the full message for the UI (far more generous than Linear's 200-char activity cap). */
const MAX_TEXT = 4000;

/** Deterministic per-job path, so a reader can find a transcript from just the job id. */
export function eventsLogPath(jobId: string): string {
  return join(logsDir(), `${jobId}.events.jsonl`);
}

/**
 * A `RunnerEventSink` that appends redacted JSONL to the job's transcript file. Returns the sink
 * plus a `close()` to flush/end the stream after the run. Never throws.
 */
export function makeEventFileSink(
  jobId: string,
  now: () => number = () => Date.now(),
): { sink: RunnerEventSink; close: () => void } {
  const path = eventsLogPath(jobId);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* best-effort; createWriteStream will surface any real problem via its error handler */
  }
  const stream = createWriteStream(path, { flags: "a" });
  stream.on("error", () => {
    /* best-effort: a write failure must never surface to the job */
  });
  const sink: RunnerEventSink = (e) => {
    try {
      const rec: PersistedEvent = {
        kind: e.kind,
        ...(e.tool ? { tool: redactSecrets(e.tool) } : {}),
        text: redactSecrets(e.text ?? "").slice(0, MAX_TEXT),
        at: now(),
      };
      stream.write(JSON.stringify(rec) + "\n");
    } catch {
      /* swallow */
    }
  };
  return {
    sink,
    close: () => {
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    },
  };
}

function parseLine(line: string): PersistedEvent | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t) as PersistedEvent;
  } catch {
    return undefined; // skip a partial/corrupt line (e.g. mid-write tail)
  }
}

/** Replay the whole transcript (for a finished job, or an initial paint before tailing). */
export function readEvents(jobId: string): PersistedEvent[] {
  const path = eventsLogPath(jobId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: PersistedEvent[] = [];
  for (const line of raw.split("\n")) {
    const e = parseLine(line);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Tail a job's transcript: emits every already-written event immediately (replay), then polls for
 * appended lines. Returns an unsubscribe function. Uses an incremental size-poll (not `fs.watch`,
 * which is flaky across platforms) and tolerates the file not existing yet (a job writes nothing
 * until it reaches `running`).
 */
export function tailEvents(
  jobId: string,
  onEvent: (e: PersistedEvent) => void,
  intervalMs = 300,
): () => void {
  const path = eventsLogPath(jobId);
  let offset = 0;
  let partial = "";
  let stopped = false;

  const poll = () => {
    if (stopped) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // ENOENT until the job starts writing
    }
    if (size < offset) {
      // file truncated/rotated — restart from the top
      offset = 0;
      partial = "";
    }
    if (size === offset) return;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const len = size - offset;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, offset);
      offset += n;
      partial += buf.toString("utf8", 0, n);
      const lines = partial.split("\n");
      partial = lines.pop() ?? ""; // keep a trailing partial line for the next tick
      for (const line of lines) {
        const e = parseLine(line);
        if (e) onEvent(e);
      }
    } catch {
      /* ignore this tick */
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  };

  poll(); // initial replay
  const iv = setInterval(poll, intervalMs);
  if (typeof iv.unref === "function") iv.unref();
  return () => {
    stopped = true;
    clearInterval(iv);
  };
}
