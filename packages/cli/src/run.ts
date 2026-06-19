import { readdirSync, readFileSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  loadConfig,
  resolveRepo,
  openDatabase,
  JobStore,
  JobQueue,
  makeProcessJob,
  LinearClient,
  isDaemonRunning,
  readDaemon,
  pidAlive,
  logsDir,
  syncDependencies,
  reconcileDependencies,
  TERMINAL_STATES,
  type PersistedEvent,
} from "@milo/core";
import { runClaude, runCodex, parseRunnerResult } from "@milo/runners";
import { createClient, type JobsFilter } from "./viewmodel.js";

/**
 * Enqueue one or more Linear issues and drain the queue with managed concurrency.
 * `milo SBX-1` runs a single issue; `milo SBX-1 SBX-2 SBX-3` enqueues all three and
 * runs at most `config.concurrency` at once (the rest wait), one job per issue.
 */
export async function runIssues(issueIds: string[]): Promise<number> {
  const { config } = loadConfig();
  const db = openDatabase();
  const store = new JobStore(db);
  const daemonUp = isDaemonRunning();

  // Only recover stranded jobs in standalone mode — never while a daemon owns the queue.
  if (!daemonUp) {
    const recovered = store.recoverOnStartup();
    if (recovered > 0) console.log(`[milo] recovered ${recovered} in-flight job(s) from a prior run`);
  }

  for (const issueId of issueIds) {
    const teamKey = issueId.split("-")[0]!;
    const repoGuess = resolveRepo(config, teamKey)?.name ?? teamKey;
    const { job, disposition } = store.enqueue({
      source: "cli",
      entityId: issueId,
      triggerType: "issue.start",
      repo: repoGuess,
    });
    console.log(`[milo] ${issueId}: ${disposition} (job ${job.id}, state ${job.state})`);
  }

  // If the daemon is running, it owns processing — just enqueue and let it work.
  if (daemonUp) {
    console.log(`\n[milo] daemon is running — ${issueIds.length} issue(s) enqueued; it will process them.`);
    console.log(`[milo] watch with: milo jobs`);
    db.close();
    return 0;
  }

  const linear = LinearClient.fromConfig();
  const processJob = makeProcessJob({
    config,
    store,
    linear,
    runners: { claude: runClaude, codex: runCodex },
    parseResult: parseRunnerResult,
    // single issue: stream to the terminal; many: keep stdout clean, use per-job logs + `milo jobs`
    echo: issueIds.length === 1 ? process.stdout : undefined,
  });

  // Dependency sequencing (MILO-4): discover blockedBy edges for the issues just enqueued, then
  // reconcile each loop iteration so a stacked dependent runs in this same drain once its blocker
  // finishes. (wait-mode dependents stay queued until their blocker's PR merges — a later
  // `milo poll` / the daemon picks them up; the inline summary will show them still queued.)
  const depDeps = { config, store, linear };
  try {
    await syncDependencies(depDeps);
  } catch (err) {
    console.error(`[milo] dependency discovery skipped: ${(err as Error).message}`);
  }

  const queue = new JobQueue(store, processJob, {
    concurrency: config.concurrency,
    onTick: () => reconcileDependencies(depDeps),
  });
  console.log(`[milo] draining queue (concurrency ${config.concurrency})…\n`);
  await queue.drain();

  // Summary.
  console.log("\n[milo] done. Results:");
  let anyFailed = false;
  for (const issueId of issueIds) {
    const teamKey = issueId.split("-")[0]!;
    const repoGuess = resolveRepo(config, teamKey)?.name ?? teamKey;
    const all = store.list({ limit: 500 });
    const job = all.find((j) => j.entityId === issueId);
    if (!job) continue;
    // A queued dependent held by an unresolved blockedBy gate isn't a failure — it's sequenced to
    // run later (wait strategy: once its blocker's PR merges, via the daemon or a `milo poll`).
    const heldBy = job.state === "queued"
      ? store.dependenciesFor(issueId).filter((d) => !d.resolved).map((d) => d.blockerEntityId)
      : [];
    if (heldBy.length > 0) {
      console.log(`  ⧗ ${issueId}  held — waiting on ${heldBy.join(", ")} (runs after its PR merges)`);
      continue;
    }
    const ok = job.state === "done" || job.state === "discovery-done";
    if (!ok) anyFailed = true;
    console.log(`  ${ok ? "✓" : "✗"} ${issueId}  ${job.state}  ${job.prUrl ?? job.failureDetail ?? ""}`);
  }
  db.close();
  return anyFailed ? 1 : 0;
}

const STATE_COLOR: Record<string, string> = {
  done: "\x1b[32m",
  "discovery-done": "\x1b[32m",
  failed: "\x1b[31m",
  "needs-attention": "\x1b[31m",
  abandoned: "\x1b[31m",
  cancelled: "\x1b[90m",
  running: "\x1b[36m",
  queued: "\x1b[33m",
};
const RESET = "\x1b[0m";

const STATE_ORDER = [
  "queued", "claimed", "setting-up", "running", "verifying", "remediating", "reporting",
  "done", "discovery-done", "retrying", "failed", "needs-attention", "cancelled", "abandoned",
];

/** `milo status [--json]` — daemon liveness + queue counts. */
export function status(json: boolean): number {
  const client = createClient();
  const d = client.daemon();
  client.close();
  if (json) {
    process.stdout.write(
      JSON.stringify({ daemon: { running: d.running, pid: d.pid, startedAt: d.startedAt }, jobs: d.counts }, null, 2) + "\n",
    );
    return 0;
  }
  console.log(`daemon:  ${d.running ? `\x1b[32mrunning\x1b[0m (pid ${d.pid})` : "\x1b[33mnot running\x1b[0m"}`);
  const parts = STATE_ORDER.filter((s) => d.counts[s]).map((s) => `${s}=${d.counts[s]}`);
  console.log(`jobs:    ${parts.length ? parts.join("  ") : "none"}`);
  if (!d.running) console.log(`\nStart it with:  milo daemon   (or install the launchd agent — see scripts/install-launchd.sh)`);
  return 0;
}

// --- Daemon control: `milo stop` / `milo restart` ---------------------------------------------

const LAUNCHD_LABEL = "com.milo.daemon";

function launchdTarget(): string {
  return `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`;
}

/** True when the launchd job is loaded (the daemon is launchd-managed). */
function launchdLoaded(): boolean {
  const r = spawnSync("launchctl", ["print", launchdTarget()], { stdio: "ignore" });
  return r.status === 0;
}

async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return cond();
}

/**
 * Re-spawn this CLI as a detached `milo daemon`, logging to $MILO_HOME/logs/daemon.log.
 * Reuses this process's node + tsx loader flags so the daemon runs the same way we do.
 */
function spawnDetachedDaemon(): void {
  mkdirSync(logsDir(), { recursive: true });
  const log = openSync(join(logsDir(), "daemon.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

/** Injectable seams so tests can run the real signal flow without launchctl or a real daemon spawn. */
export interface DaemonControlDeps {
  spawnDaemon?: () => void;
  isLaunchd?: () => boolean;
}

/**
 * `milo stop [--force]` — stop the running daemon.
 * launchd-managed: `launchctl bootout` (a plain SIGTERM would just get resurrected by KeepAlive).
 * manual: SIGTERM the daemon pid and let it drain in-flight jobs; `--force` SIGKILLs instead
 * (the lease watchdog / startup recovery requeues anything stranded).
 */
export async function stopDaemon(args: string[] = [], deps: DaemonControlDeps = {}): Promise<number> {
  const force = args.includes("--force");
  const isLaunchd = deps.isLaunchd ?? launchdLoaded;
  const info = readDaemon();
  if (!info || !pidAlive(info.pid)) {
    console.log("[milo] no daemon is running.");
    return 0;
  }

  if (isLaunchd()) {
    console.log(`[milo] daemon (pid ${info.pid}) is launchd-managed — booting out ${LAUNCHD_LABEL}…`);
    const r = spawnSync("launchctl", ["bootout", launchdTarget()], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[milo] launchctl bootout failed");
      return 1;
    }
    console.log(`[milo] note: launchd will not restart it until login or \`launchctl bootstrap\` — use \`milo restart\` to bring it back.`);
  } else {
    console.log(
      force
        ? `[milo] force-killing daemon (pid ${info.pid})…`
        : `[milo] stopping daemon (pid ${info.pid}) — letting it drain in-flight jobs…`,
    );
    try {
      process.kill(info.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* exited in between */
    }
  }

  const gone = await waitFor(() => !pidAlive(info.pid), force ? 10_000 : 60_000);
  if (!gone) {
    console.error(
      `[milo] daemon (pid ${info.pid}) is still running — likely draining a long job. Re-run with --force to SIGKILL it.`,
    );
    return 1;
  }
  console.log("[milo] daemon stopped.");
  return 0;
}

/**
 * `milo restart [--force]` — restart the daemon so it picks up new code.
 * launchd-managed: `launchctl kickstart -k`. Manual: graceful stop, then re-spawn detached.
 * Not running: just start it. Always confirms liveness (a fresh pid in daemon.pid) before returning.
 */
export async function restartDaemon(args: string[] = [], deps: DaemonControlDeps = {}): Promise<number> {
  const isLaunchd = deps.isLaunchd ?? launchdLoaded;
  const spawnDaemon = deps.spawnDaemon ?? spawnDetachedDaemon;
  const info = readDaemon();
  const running = info !== undefined && pidAlive(info.pid);
  const oldPid = running ? info.pid : undefined;

  if (running && isLaunchd()) {
    console.log(`[milo] daemon (pid ${oldPid}) is launchd-managed — kickstarting ${LAUNCHD_LABEL}…`);
    const r = spawnSync("launchctl", ["kickstart", "-k", launchdTarget()], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[milo] launchctl kickstart failed");
      return 1;
    }
  } else {
    if (running) {
      const code = await stopDaemon(args, deps);
      if (code !== 0) return code;
    } else {
      console.log("[milo] no daemon was running — starting one.");
    }
    spawnDaemon();
  }

  // Confirm liveness: a fresh pid (not the old one) recorded and alive.
  const ok = await waitFor(() => {
    const d = readDaemon();
    return d !== undefined && d.pid !== oldPid && pidAlive(d.pid);
  }, 30_000);
  if (!ok) {
    console.error(`[milo] daemon did not come back within 30s — check ${join(logsDir(), "daemon.log")}`);
    return 1;
  }
  console.log(`[milo] daemon running (pid ${readDaemon()!.pid}).`);
  return 0;
}

/** `milo logs <ISSUE-ID>` — print the most recent runner log for an issue. */
export function tailLog(issueId: string): number {
  let files: string[];
  try {
    files = readdirSync(logsDir()).filter((f) => f.startsWith(`${issueId}-`) && f.endsWith(".log"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    console.error(`No logs for ${issueId} in ${logsDir()}`);
    return 1;
  }
  files.sort(); // timestamped names sort chronologically
  const newest = files[files.length - 1]!;
  process.stdout.write(readFileSync(join(logsDir(), newest), "utf8"));
  return 0;
}

const KIND_TAG: Record<string, string> = { "file-change": "±", tool: "›", notice: "!", narration: "·" };

function renderEvent(e: PersistedEvent, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  const color =
    e.kind === "file-change" ? "\x1b[32m" : e.kind === "tool" ? "\x1b[36m" : e.kind === "notice" ? "\x1b[33m" : "\x1b[2m";
  const label = e.tool ? `${e.tool}: ` : "";
  console.log(`${color}${KIND_TAG[e.kind] ?? "·"}${RESET} ${label}${e.text}`);
}

/**
 * `milo watch <ID|jobId> [--json]` — stream a job's normalized transcript to the terminal (the
 * narration/tool/file-change events as the agent works), replaying what already happened and then
 * tailing live until the job finishes. The redacted, UI-safe complement to `milo logs` (raw).
 */
export async function watchJob(ref: string, json: boolean): Promise<number> {
  const client = createClient();
  const job = client.resolveJob(ref);
  if (!job) {
    console.error(`No job for ${ref}.`);
    client.close();
    return 1;
  }
  const isTerminal = (s: string) => (TERMINAL_STATES as string[]).includes(s);

  if (isTerminal(job.state)) {
    // Already finished — replay the whole transcript and exit.
    for (const e of client.readTranscript(job.id)) renderEvent(e, json);
    if (!json) console.log(`\n[milo] ${job.state}  ${job.prUrl ?? job.failureDetail ?? ""}`);
    client.close();
    return 0;
  }

  if (!json) console.log(`[milo] watching ${job.id} (${job.entityRef ?? job.entityId}) — ${job.state} · Ctrl-C to stop\n`);
  const unsubscribe = client.tailTranscript(job.id, (e) => renderEvent(e, json));
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const j = client.store.get(job.id);
      if (!j || isTerminal(j.state)) {
        clearInterval(iv);
        resolve();
      }
    }, 1000);
  });
  await new Promise((r) => setTimeout(r, 400)); // let the tail flush its final events
  unsubscribe();
  const final = client.store.get(job.id);
  if (!json) console.log(`\n[milo] ${final?.state}  ${final?.prUrl ?? final?.failureDetail ?? ""}`);
  client.close();
  return 0;
}

/**
 * `milo rerun <ID|jobId>` — re-run a job from scratch as a new job. For a Linear/GitHub entity that
 * already shipped a PR this revises that PR (never a duplicate). Enqueue-only: the daemon runs it.
 */
export function rerunJob(ref: string): number {
  const client = createClient();
  const target = client.resolveJob(ref);
  if (!target) {
    console.error(`No job for ${ref}.`);
    client.close();
    return 1;
  }
  const res = client.rerun(target.id);
  const daemonUp = client.daemon().running;
  client.close();
  if (!res.ok) {
    console.error(`[milo] ${res.error}`);
    return 1;
  }
  console.log(`[milo] re-running ${target.entityRef ?? target.entityId} as job ${res.value.id} (queued).`);
  if (daemonUp) console.log(`[milo] daemon will process it. Watch: milo watch ${res.value.id}`);
  else console.log(`[milo] no daemon running — start it (milo daemon) to process it.`);
  return 0;
}

/** `milo retry <ID|jobId>` — re-queue a failed / needs-attention / abandoned job in place. */
export function retryJob(ref: string): number {
  const client = createClient();
  const target = client.resolveJob(ref);
  if (!target) {
    console.error(`No job for ${ref}.`);
    client.close();
    return 1;
  }
  const res = client.retry(target.id);
  const daemonUp = client.daemon().running;
  client.close();
  if (!res.ok) {
    console.error(`[milo] ${res.error}`);
    return 1;
  }
  console.log(`[milo] re-queued job ${res.value.id} (${target.entityRef ?? target.entityId}).`);
  if (daemonUp) console.log(`[milo] daemon will process it. Watch: milo watch ${res.value.id}`);
  else console.log(`[milo] no daemon running — start it (milo daemon) to process it.`);
  return 0;
}

/** `milo cancel <ID|jobId>` — cancel a queued or in-flight job (kills the runner if it's running). */
export function cancelJob(ref: string): number {
  const client = createClient();
  const target = client.resolveJob(ref);
  if (!target) {
    console.error(`No job for ${ref}.`);
    client.close();
    return 1;
  }
  const res = client.cancel(target.id);
  client.close();
  if (!res.ok) {
    console.error(`[milo] ${res.error}`);
    return 1;
  }
  if (res.value === "cancelled") console.log(`[milo] cancelled ${target.entityRef ?? target.entityId} (job ${target.id}).`);
  else console.log(`[milo] cancellation requested for job ${target.id} — the worker will stop it shortly.`);
  return 0;
}

/** `milo schedules [--json]` — list configured schedules with next/last run times. */
export async function listSchedules(json: boolean): Promise<number> {
  const client = createClient();
  const { rows, recent } = await client.schedules();
  client.close();
  if (json) {
    process.stdout.write(JSON.stringify({ schedules: rows, recent }, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    console.log("No schedules configured.");
    return 0;
  }
  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : "—");
  console.log(`${"NAME".padEnd(28)}${"KIND".padEnd(13)}${"CRON".padEnd(16)}${"NEXT".padEnd(22)}LAST`);
  for (const r of rows) {
    const name = r.enabled ? r.name : `${r.name} (off)`;
    console.log(`${name.padEnd(28)}${r.kind.padEnd(13)}${r.cron.padEnd(16)}${fmt(r.nextRun).padEnd(22)}${fmt(r.lastRun)}`);
  }
  if (recent.length) {
    console.log(`\nRecent runs:`);
    for (const run of recent) console.log(`  ${new Date(run.at).toLocaleString()}  ${run.name}  ${run.detail ?? ""}`);
  }
  return 0;
}

/**
 * `milo prompt <name>` — run a scheduled prompt right now (don't wait for its cron). `<name>` is the
 * schedule's namespaced `<repo>:<name>` or just `<name>` when unambiguous. Enqueues a `source:"prompt"`
 * job; the daemon runs it if up, otherwise we drain inline.
 */
export async function runPrompt(name: string): Promise<number> {
  const { config } = loadConfig();
  const { effectiveSchedules } = await import("@milo/daemon");
  const { resolvePromptScheduleJob } = await import("@milo/core");

  const promptDefs = effectiveSchedules(config).filter((d) => (d.intent?.["kind"] as string) === "prompt");
  const matches = promptDefs.filter((d) => d.name === name || d.name.endsWith(`:${name}`));
  if (matches.length === 0) {
    console.error(`No prompt schedule named "${name}".`);
    if (promptDefs.length) console.error(`Available: ${promptDefs.map((d) => d.name).join(", ")}`);
    else console.error(`Define one in <repo>/.milo/schedules.json (see docs/scheduling.md).`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`"${name}" is ambiguous — matches ${matches.map((d) => d.name).join(", ")}. Use the full <repo>:<name>.`);
    return 1;
  }
  const def = matches[0]!;

  const db = openDatabase();
  const store = new JobStore(db);
  const daemonUp = isDaemonRunning();
  if (!daemonUp) {
    const recovered = store.recoverOnStartup();
    if (recovered > 0) console.log(`[milo] recovered ${recovered} in-flight job(s) from a prior run`);
  }

  let job;
  try {
    const newJob = resolvePromptScheduleJob(config, def, store.lastScheduleRun(def.name));
    const res = store.enqueue(newJob);
    job = res.job;
    store.recordScheduleRun(def.name, "prompt", `${res.disposition} ${job.id} (manual)`);
    console.log(`[milo] ${def.name}: ${res.disposition} (job ${job.id}, repo ${newJob.repo}, runner ${newJob.runner ?? "default"})`);
  } catch (err) {
    console.error(`[milo] couldn't prepare "${def.name}": ${(err as Error).message}`);
    db.close();
    return 1;
  }

  if (daemonUp) {
    console.log(`\n[milo] daemon is running — the prompt is enqueued; it will process it.`);
    console.log(`[milo] watch with: milo jobs`);
    db.close();
    return 0;
  }

  const linear = LinearClient.fromConfig();
  const processJob = makeProcessJob({
    config,
    store,
    linear,
    runners: { claude: runClaude, codex: runCodex },
    parseResult: parseRunnerResult,
    echo: process.stdout,
  });
  const queue = new JobQueue(store, processJob, { concurrency: config.concurrency });
  console.log(`[milo] running the prompt inline…\n`);
  await queue.drain();

  const final = store.get(job.id);
  const ok = final?.state === "done" || final?.state === "discovery-done";
  console.log(`\n[milo] ${ok ? "✓" : "✗"} ${def.name}  ${final?.state}  ${final?.prUrl ?? final?.failureDetail ?? ""}`);
  db.close();
  return ok ? 0 : 1;
}

/** `milo poll` — run one Linear + GitHub poll pass and enqueue any new work. */
export async function pollNow(json: boolean): Promise<number> {
  const { config } = loadConfig();
  const db = openDatabase();
  const store = new JobStore(db);
  const linear = LinearClient.fromConfig();
  const { pollOnce } = await import("@milo/daemon");
  const counts = await pollOnce({ config, store, linear });
  const daemonUp = isDaemonRunning();
  if (json) {
    process.stdout.write(JSON.stringify({ enqueued: counts, daemonRunning: daemonUp }, null, 2) + "\n");
  } else {
    console.log(`[milo] polled — enqueued linear=${counts.linear} github=${counts.github}`);
    if (daemonUp) console.log(`[milo] daemon is running and will process them. Watch: milo jobs`);
    else console.log(`[milo] no daemon running — start it (milo daemon) or run an issue inline to process.`);
  }
  db.close();
  return 0;
}

/** Truncate to `n` chars with an ellipsis, for fixed-width table cells. */
function fit(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}

function ageStr(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** `milo jobs [--json] [--state <s>] [--repo <r>] [--search <q>]` — list jobs from the store. */
export function listJobs(json: boolean, filter: JobsFilter = {}): number {
  const client = createClient();
  const rows = client.jobs({ limit: 100, ...filter });
  client.close();
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    console.log(Object.keys(filter).length ? "No jobs match that filter." : "No jobs yet.");
    return 0;
  }
  console.log(`${"ID".padEnd(8)}${"ISSUE".padEnd(22)}${"STATE".padEnd(16)}${"RUNNER".padEnd(8)}${"AGE".padEnd(6)}PR / DETAIL`);
  for (const r of rows) {
    const color = STATE_COLOR[r.state] ?? "";
    console.log(
      `${r.id.slice(-6).padEnd(8)}${fit(r.ref, 21).padEnd(22)}${color}${r.state.padEnd(16)}${RESET}${(r.runner ?? "-").padEnd(8)}${ageStr(r.ageMs).padEnd(6)}${fit(r.detail ?? "", 80)}`,
    );
  }
  return 0;
}

/** `milo job <jobId> [--json]` — full detail for a single job (events, dependencies, PR, failure). */
export function showJob(jobId: string, json: boolean): number {
  const client = createClient();
  const detail = client.job(jobId) ?? (() => {
    const j = client.resolveJob(jobId);
    return j ? client.job(j.id) : undefined;
  })();
  client.close();
  if (!detail) {
    console.error(`No job ${jobId}.`);
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(detail, null, 2) + "\n");
    return 0;
  }
  const { job, events, dependencies } = detail;
  const color = STATE_COLOR[job.state] ?? "";
  console.log(`${job.id}  ${color}${job.state}${RESET}`);
  console.log(`  entity:   ${job.entityRef ?? job.entityId}  (${job.source}/${job.triggerType})`);
  console.log(`  repo:     ${job.repo}${job.branch ? `  branch ${job.branch}` : ""}`);
  console.log(`  runner:   ${job.runner ?? "-"}${job.model ? ` (${job.model})` : ""}  attempts ${job.attempts}/${job.maxAttempts}`);
  if (job.prUrl) console.log(`  pr:       ${job.prUrl}`);
  if (job.summary) console.log(`  summary:  ${job.summary}`);
  if (job.failureDetail) console.log(`  failure:  ${job.failureClass ?? ""} ${job.failureDetail}`);
  if (dependencies.length) {
    console.log(`  blockedBy:`);
    for (const d of dependencies) console.log(`    ${d.blockerEntityId}  ${d.strategy}  ${d.resolved ? "resolved" : "pending"}`);
  }
  if (events.length) {
    console.log(`  events:`);
    for (const e of events) {
      const when = new Date(e.at).toLocaleTimeString();
      const transition = e.from || e.to ? `  ${e.from ?? "—"}→${e.to ?? "—"}` : "";
      console.log(`    ${when}  ${e.kind}${transition}`);
    }
  }
  return 0;
}
