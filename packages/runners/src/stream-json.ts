import type { RunnerEvent } from "@milo/core";

/**
 * Claude Code `stream-json` → normalized {@link RunnerEvent}s.
 *
 * Shared by two callers that receive the *same* payloads over different transports:
 *  - `runClaude` reads them as JSONL on the local CLI's stdout;
 *  - `runConductor` reads them out of `content.rawPayload` on Conductor Cloud session messages
 *    (Conductor runs Claude Code inside the cloud workspace and relays its stream verbatim).
 *
 * Kept pure and order-preserving so both transports produce identical transcripts, and so the
 * mapping can be unit-tested against real captured payloads without a process or a network.
 */

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);

/** Translate a Claude `tool_use` block into a normalized progress event. */
export function toolEvent(name: string, input: Record<string, unknown>): RunnerEvent {
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
 * One thing to do with a stream event, in the order it occurred:
 *  - `text`   — assistant narration: append to `output` AND emit as a `narration` event
 *  - `event`  — a tool call / file change: emit it (and echo a bullet)
 *  - `result` — the terminal event: its text carries `MILO_RESULT`, so it must reach `output`
 */
export type StreamItem =
  | { kind: "text"; text: string }
  | { kind: "event"; event: RunnerEvent }
  | { kind: "result"; text: string; isError: boolean };

/**
 * Map one parsed stream-json event to zero or more ordered items. Unknown/irrelevant event types
 * (`system`, `command_lifecycle`, `rate_limit_event`, tool results, thinking blocks) yield nothing —
 * tolerating any shape is deliberate, since a malformed event must never break a run.
 */
export function mapStreamJsonEvent(evt: unknown): StreamItem[] {
  const items: StreamItem[] = [];
  const e = evt as Record<string, any>;
  if (!e || typeof e !== "object") return items;

  try {
    if (e["type"] === "assistant" && e["message"]?.content) {
      const blocks = e["message"].content;
      if (!Array.isArray(blocks)) return items;
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          items.push({ kind: "text", text: block.text });
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          items.push({
            kind: "event",
            event: toolEvent(block.name, (block.input ?? {}) as Record<string, unknown>),
          });
        }
        // `thinking` blocks are intentionally dropped — they're noise in a transcript.
      }
    } else if (e["type"] === "result" && typeof e["result"] === "string") {
      items.push({ kind: "result", text: e["result"], isError: e["is_error"] === true });
    }
  } catch {
    /* tolerate any unexpected event shape */
  }
  return items;
}
