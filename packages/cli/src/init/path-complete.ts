import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Shell-style Tab completion for the wizard's path fields.
 *
 * Pure and throw-free: list the directory the input points into, match directory entries against
 * the typed prefix, and complete to the longest common prefix (with a trailing `/` on a unique
 * match). Anything unexpected (missing dir, permissions) is a no-op so the TUI never crashes.
 */

export interface PathCompletion {
  /** The input advanced as far as the matches allow (unchanged when there are no matches). */
  completed: string;
  /** Directory names that match the typed prefix (empty when none or exactly one consumed). */
  candidates: string[];
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function longestCommonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export function completePath(input: string): PathCompletion {
  const noop: PathCompletion = { completed: input, candidates: [] };
  if (!input.trim()) return noop;

  const expanded = expandTilde(input);
  // "…/foo" → list "…" and match "foo"; "…/foo/" → list "…/foo" and match everything in it.
  const dir = expanded.endsWith("/") ? expanded.slice(0, -1) || "/" : dirname(expanded);
  const prefix = expanded.endsWith("/") ? "" : basename(expanded);

  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name.startsWith(prefix))
      // Hidden dirs only complete when explicitly asked for (prefix starts with ".").
      .filter((name) => prefix.startsWith(".") || !name.startsWith("."))
      .sort();
  } catch {
    return noop;
  }
  if (entries.length === 0) return noop;

  if (entries.length === 1) {
    return { completed: join(dir, entries[0]!) + "/", candidates: [] };
  }
  const common = longestCommonPrefix(entries);
  const completed = common.length > prefix.length ? join(dir, common) : expanded;
  return { completed, candidates: entries };
}
