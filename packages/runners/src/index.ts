/**
 * Runner abstraction: ClaudeRunner (Phase 1) and CodexRunner (Phase 4) behind one interface.
 */
export interface RunContext {
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  model: string;
  budgetUsd?: number;
  resultSchemaPath?: string;
}

export interface Runner {
  readonly id: "claude" | "codex";
  supportsModel(model: string): boolean;
  run(ctx: RunContext): AsyncIterable<unknown>;
}

export { runClaude } from "./claude.js";
export type { ClaudeRunOptions, ClaudeRunResult } from "./claude.js";
export { runCodex } from "./codex.js";
export type { CodexRunOptions, CodexRunResult } from "./codex.js";
export { parseRunnerResult } from "./result.js";
export type { RunnerResult } from "./result.js";
export { RunGuards, killTree, DEFAULT_GUARDS } from "./guards.js";
export type { GuardTimeouts } from "./guards.js";
