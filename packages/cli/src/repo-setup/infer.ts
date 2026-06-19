import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { githubSlugForPath } from "@milo/core";

/**
 * Pure inference over a repo path — the foundation of `milo add-repo`.
 *
 * Everything here is a deterministic function of the filesystem + local git state for a single
 * directory: no TTY, no Linear/GitHub network calls. That keeps it unit-testable in isolation
 * (see test/repo-setup.test.ts) so the interactive layer only has to confirm/override the result.
 */

export interface InferredRepoDefaults {
  /** Absolute path to the git work-tree root. */
  path: string;
  /** package.json name (scope stripped) → directory basename. */
  name: string;
  /** owner/name parsed from the `origin` remote, if any. */
  githubRepo?: string;
  /** The real default branch from `origin/HEAD`, falling back to `main`. */
  baseBranch: string;
  /** Detected from the lockfile present at the repo root. */
  packageManager: "npm" | "pnpm" | "yarn";
}

function git(repoPath: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

/** The git work-tree root containing `dir` (its `--show-toplevel`), or undefined if `dir` isn't in a repo. */
export function findGitRoot(dir: string): string | undefined {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.out ? r.out : undefined;
}

/** True when `dir` is inside a git work tree. */
export function isGitRepo(dir: string): boolean {
  return findGitRoot(dir) !== undefined;
}

/** package.json `name` (with any `@scope/` prefix stripped) → directory basename. */
export function inferName(repoPath: string): string {
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        return pkg.name.trim().replace(/^@[^/]+\//, "");
      }
    } catch {
      /* malformed package.json — fall through to the directory name */
    }
  }
  return basename(repoPath);
}

/** owner/name from the `origin` remote (git@ or https), or undefined. */
export function inferGithubRepo(repoPath: string): string | undefined {
  return githubSlugForPath(repoPath);
}

/**
 * The repo's real default branch from `origin/HEAD` (e.g. `main` or `master`), never assumed.
 * Falls back to `main` when the symbolic ref isn't set locally (e.g. a fresh clone without HEAD).
 */
export function inferBaseBranch(repoPath: string): string {
  const sym = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.out) {
    const m = sym.out.match(/^origin\/(.+)$/);
    if (m) return m[1]!;
  }
  return "main";
}

/** Package manager from the lockfile at the repo root (pnpm > yarn > npm), default `npm`. */
export function inferPackageManager(repoPath: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  return "npm";
}

/** Infer every default RepoConfig value for the repo containing `dir`. */
export function inferRepoDefaults(dir: string): InferredRepoDefaults {
  const path = findGitRoot(dir) ?? dir;
  return {
    path,
    name: inferName(path),
    githubRepo: inferGithubRepo(path),
    baseBranch: inferBaseBranch(path),
    packageManager: inferPackageManager(path),
  };
}
