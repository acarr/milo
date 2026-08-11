/** The structured outcome a runner declares (cross-checked against ground truth in Phase 2). */
export interface RunnerResult {
  outcome: "implemented" | "discovery" | "blocked";
  wroteCode: boolean;
  prUrl: string | null;
  summary: string;
  /**
   * Set when a `MILO_RESULT=` line was present but did not parse cleanly. The caller logs it —
   * silently degrading to an empty summary is how a good 450-character summary disappeared into
   * `Implements WAZ-1107` (2026-08-06), with nothing in the record to say it had ever existed.
   */
  parseNote?: string;
}

/**
 * Close a JSON value that was cut off mid-flight.
 *
 * Observed twice in a week on otherwise clean runs (`is_error:false`, `stop_reason:"end_turn"`): the
 * agent's final `MILO_RESULT={…}` line ends at the closing quote of `summary` with the `}` missing.
 * The payload is complete apart from its terminators, so re-adding them recovers the whole summary.
 * Returns undefined when the tail is too damaged to close (e.g. it ends on a bare `"key":`).
 */
function closeTruncatedJson(s: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (!stack.length && !inString) return undefined; // nothing to close — it failed for another reason

  let repaired = s;
  if (escaped) repaired = repaired.slice(0, -1); // a dangling backslash would escape our own quote
  if (inString) repaired += '"';
  // A tail like `{"a":1,"b":` or `{"a":1,` can't be closed by adding brackets — drop the partial pair.
  repaired = repaired.replace(/[,:]\s*$/, "");
  if (/[,:]\s*"[^"]*"$/.test(repaired) && !inString) {
    // `…,"summary"` — a key with no value; drop it rather than emit `{"summary"}`.
    repaired = repaired.replace(/,\s*"[^"]*"$/, "");
  }
  return repaired + stack.reverse().join("");
}

/** Last-ditch field extraction for a payload too mangled to repair — a summary beats nothing. */
function scrapeFields(s: string): Partial<RunnerResult> | undefined {
  const str = (key: string): string | undefined => {
    const m = s.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  };
  const summary = str("summary");
  const outcome = str("outcome");
  if (!summary && !outcome) return undefined;
  const out: Partial<RunnerResult> = {};
  if (summary) out.summary = summary;
  if (outcome === "implemented" || outcome === "discovery" || outcome === "blocked") out.outcome = outcome;
  const prUrl = s.match(/"prUrl"\s*:\s*"(https:\/\/[^"]+)"/);
  if (prUrl) out.prUrl = prUrl[1]!;
  if (/"wroteCode"\s*:\s*true/.test(s)) out.wroteCode = true;
  else if (/"wroteCode"\s*:\s*false/.test(s)) out.wroteCode = false;
  return out;
}

function shape(parsed: Partial<RunnerResult>, parseNote?: string): RunnerResult {
  return {
    outcome: parsed.outcome ?? "implemented",
    wroteCode: parsed.wroteCode ?? true,
    prUrl: parsed.prUrl ?? null,
    summary: parsed.summary ?? "",
    ...(parseNote ? { parseNote } : {}),
  };
}

/**
 * Extract the runner's declared result from its output. Prefers the explicit `MILO_RESULT={...}`
 * line; a malformed one is repaired (truncated tail) or scraped (field regex) before giving up,
 * because the fall-back — grepping for a PR URL — throws the summary away. Falls back to that grep
 * only when no `MILO_RESULT=` line exists at all (milo.sh behavior).
 */
export function parseRunnerResult(output: string): RunnerResult {
  const lines = output.split("\n");
  let firstNote: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    const idx = line.indexOf("MILO_RESULT=");
    if (idx === -1) continue;
    const jsonStr = line.slice(idx + "MILO_RESULT=".length).trim();

    try {
      return shape(JSON.parse(jsonStr) as Partial<RunnerResult>);
    } catch (err) {
      firstNote ??= `MILO_RESULT did not parse (${(err as Error).message})`;
    }

    const closed = closeTruncatedJson(jsonStr);
    if (closed) {
      try {
        return shape(JSON.parse(closed) as Partial<RunnerResult>, `${firstNote}; recovered by closing a truncated payload`);
      } catch {
        /* fall through to scraping */
      }
    }

    const scraped = scrapeFields(jsonStr);
    if (scraped) return shape(scraped, `${firstNote}; recovered by scraping fields`);
  }

  const prMatch = output.match(/https:\/\/github\.com\/[^\s)"']+\/pull\/\d+/g);
  const prUrl = prMatch ? prMatch[prMatch.length - 1]! : null;
  return {
    outcome: prUrl ? "implemented" : "discovery",
    wroteCode: prUrl !== null,
    prUrl,
    summary: "",
    ...(firstNote ? { parseNote: `${firstNote}; unrecoverable — fell back to a PR-URL grep` } : {}),
  };
}
