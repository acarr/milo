import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { loadConfig, miloHome, worktreeBase, openDatabase, dbPath } from "@milo/core";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  required: boolean;
}

function tryRun(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (e.stdout ?? e.stderr ?? e.message ?? "").toString().trim() };
  }
}

function which(bin: string): string | null {
  const r = tryRun("/usr/bin/which", [bin]);
  return r.ok && r.out ? r.out : null;
}

/** Free space (GiB) on the volume holding `path`, via `df -Pk`. */
function freeGiB(path: string): number | null {
  const r = tryRun("/bin/df", ["-Pk", path]);
  if (!r.ok) return null;
  const lines = r.out.split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  const cols = last.trim().split(/\s+/);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb)) return null;
  return availKb / 1024 / 1024;
}

const DISK_WARN_GIB = 5;

/**
 * The environment-only checks: CLIs and daemons that don't depend on where Milo's home/paths
 * live. `milo init` runs these (quietly) before its wizard, when paths haven't been chosen yet.
 */
export function runToolChecks(): CheckResult[] {
  const results: CheckResult[] = [];

  // claude CLI (required)
  const claudePath = which("claude");
  if (claudePath) {
    const v = tryRun(claudePath, ["--version"]);
    results.push({ name: "claude", status: "ok", detail: `${v.out || "found"} (${claudePath})`, required: true });
  } else {
    results.push({ name: "claude", status: "fail", detail: "not on PATH", required: true });
  }

  // codex CLI (optional unless using the codex runner)
  const codexPath = which("codex");
  if (codexPath) {
    const v = tryRun(codexPath, ["--version"]);
    results.push({ name: "codex", status: "ok", detail: `${v.out || "found"} (${codexPath})`, required: false });
  } else {
    results.push({ name: "codex", status: "warn", detail: "not on PATH (codex runner unavailable)", required: false });
  }

  // gh CLI + auth (required for PR ops)
  const ghPath = which("gh");
  if (!ghPath) {
    results.push({ name: "gh", status: "fail", detail: "not on PATH", required: true });
  } else {
    const auth = tryRun(ghPath, ["auth", "status"]);
    results.push({
      name: "gh",
      status: auth.ok ? "ok" : "fail",
      detail: auth.ok ? "authenticated" : "not authenticated (run `gh auth login`)",
      required: true,
    });
  }

  // docker daemon (needed by heavy worktree setups)
  const dockerPath = which("docker");
  if (!dockerPath) {
    results.push({ name: "docker", status: "warn", detail: "not on PATH", required: false });
  } else {
    const info = tryRun(dockerPath, ["info", "--format", "{{.ServerVersion}}"]);
    results.push({
      name: "docker",
      status: info.ok ? "ok" : "warn",
      detail: info.ok ? `daemon up (${info.out})` : "daemon not running (heavy worktree setups will fail)",
      required: false,
    });
  }

  return results;
}

export function runDoctor(): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. Config
  try {
    const { config, rawVersion } = loadConfig();
    results.push({
      name: "config",
      status: "ok",
      detail: `v${rawVersion} parsed, ${config.repositories.length} repos, default runner ${config.runnerDefaults.default}`,
      required: true,
    });
  } catch (err) {
    results.push({
      name: "config",
      status: "fail",
      detail: `${(err as Error).message}`,
      required: true,
    });
  }

  // 2-5. Tool checks (claude, codex, gh, docker)
  results.push(...runToolChecks());

  // 6. Disk free on MILO_HOME volume
  const free = freeGiB(miloHome());
  if (free === null) {
    results.push({ name: "disk", status: "warn", detail: "could not determine free space", required: false });
  } else {
    results.push({
      name: "disk",
      status: free < DISK_WARN_GIB ? "warn" : "ok",
      detail: `${free.toFixed(1)} GiB free on ${miloHome()}${free < DISK_WARN_GIB ? " (low — relocate worktreeBase)" : ""}`,
      required: false,
    });
  }

  // 7. SQLite store opens
  try {
    const db = openDatabase();
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    db.close();
    results.push({ name: "store", status: "ok", detail: `sqlite ok @ ${dbPath()} (schema v${row?.value ?? "?"})`, required: true });
  } catch (err) {
    results.push({ name: "store", status: "fail", detail: `${(err as Error).message}`, required: true });
  }

  // 8. Worktree base writable
  try {
    const base = (() => {
      try {
        return worktreeBase(loadConfig().config.worktreeBase);
      } catch {
        return worktreeBase();
      }
    })();
    if (!existsSync(base)) mkdirSync(base, { recursive: true });
    accessSync(base, constants.W_OK);
    results.push({ name: "worktreeBase", status: "ok", detail: `writable @ ${base}`, required: true });
  } catch (err) {
    results.push({
      name: "worktreeBase",
      status: "fail",
      detail: `not writable (${(err as Error).message}) — check permissions or pick a different worktrees path`,
      required: true,
    });
  }

  return results;
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
const COLOR: Record<CheckStatus, string> = {
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  fail: "\x1b[31m",
};
const RESET = "\x1b[0m";

export function printDoctor(results: CheckResult[], json: boolean): number {
  const failed = results.filter((r) => r.required && r.status === "fail");
  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2) + "\n",
    );
    return failed.length === 0 ? 0 : 1;
  }
  console.log("milo doctor\n");
  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const tag = r.required ? "" : " (optional)";
    console.log(`  ${COLOR[r.status]}${ICON[r.status]}${RESET} ${r.name.padEnd(pad)}  ${r.detail}${tag}`);
  }
  console.log("");
  if (failed.length === 0) {
    console.log(`${COLOR.ok}✓ all required checks passed${RESET}`);
    return 0;
  }
  console.log(`${COLOR.fail}✗ ${failed.length} required check(s) failed: ${failed.map((f) => f.name).join(", ")}${RESET}`);
  return 1;
}
