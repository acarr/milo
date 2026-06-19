/** The structured outcome a runner declares (cross-checked against ground truth in Phase 2). */
export interface RunnerResult {
  outcome: "implemented" | "discovery" | "blocked";
  wroteCode: boolean;
  prUrl: string | null;
  summary: string;
}

/**
 * Extract the runner's declared result from its output. Prefers the explicit
 * `MILO_RESULT={...}` line; falls back to grepping a GitHub PR URL (milo.sh behavior).
 */
export function parseRunnerResult(output: string): RunnerResult {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    const idx = line.indexOf("MILO_RESULT=");
    if (idx !== -1) {
      const jsonStr = line.slice(idx + "MILO_RESULT=".length).trim();
      try {
        const parsed = JSON.parse(jsonStr) as Partial<RunnerResult>;
        return {
          outcome: parsed.outcome ?? "implemented",
          wroteCode: parsed.wroteCode ?? true,
          prUrl: parsed.prUrl ?? null,
          summary: parsed.summary ?? "",
        };
      } catch {
        // fall through to URL grep
      }
    }
  }

  const prMatch = output.match(/https:\/\/github\.com\/[^\s)"']+\/pull\/\d+/g);
  const prUrl = prMatch ? prMatch[prMatch.length - 1]! : null;
  return {
    outcome: prUrl ? "implemented" : "discovery",
    wroteCode: prUrl !== null,
    prUrl,
    summary: "",
  };
}
