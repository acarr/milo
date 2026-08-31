import type { MiloConfig, RepoConfig } from "./config.js";
import { resolveRepo, resolveRepoByName, resolveProgress } from "./config.js";
import { ProgressStreamer } from "./progress.js";
import { makeEventFileSink, eventsLogPath } from "./transcript.js";
import type { RunnerEventSink } from "./runner-events.js";
import type { JobStore, Job } from "./jobs.js";
import { LinearClient, type LinearIssue } from "./linear.js";
import { createWorktree, attachWorktree, teardownWorktree, isPermanentWorktreeError, type Worktree } from "./worktree.js";
import {
  buildPrompt,
  buildFreeformPrompt,
  buildAttachPrompt,
  buildLinearAttachPrompt,
  buildConductorPrompt,
} from "./prompt.js";
import { resolveGroundTruth, ensurePr, ensurePushed } from "./verify.js";
import { resolveRunner, modelFor, resolveRepoByGithub, isRemoteRunner, type RunnerId } from "./router.js";
import { fetchPr, prComments, addPrComment, githubSlugForPath, type PullRequest } from "./github.js";
import { worktreeBase } from "./paths.js";
import { logsDir } from "./paths.js";
import { logger } from "./logger.js";
import { join } from "node:path";

/**
 * Job/worktree context a runner may need beyond the prompt itself.
 *
 * Local runners ignore this — they work in `cwd` and the gate reads whatever they left there. A
 * REMOTE runner can't: it has to be told the branch to push (the cross-boundary contract) and where
 * to persist its remote session, and neither is derivable from `cwd` (a detached worktree reports
 * `HEAD` for its branch, and the base branch isn't recoverable from a worktree at all).
 */
export interface RunnerContext {
  jobId: string;
  ref: string;
  repoName: string;
  /** `owner/name`, when resolvable. */
  repoSlug?: string;
  branch: string;
  baseBranch: string;
  detached?: boolean;
  /** A previously-started remote session to resume instead of starting a new one. */
  remoteSession?: RemoteSession;
  /** Persist remote session state as soon as it exists, so a crash resumes rather than duplicates. */
  onRemoteSession?: (session: RemoteSession) => void;
  /**
   * Split a remote run so the local concurrency slot isn't held for the whole session:
   * `dispatch` starts it and returns; `track` reattaches and waits. Omit for all-in-one.
   */
  remotePhase?: "dispatch" | "track";
  /** Liveness ping while tracking a parked job — proves the tracker hasn't died. */
  onRemotePoll?: () => void;
}

/** Durable pointer to work happening on another machine. */
export interface RemoteSession {
  workspaceId: string;
  sessionId: string;
  deepLink: string;
  cursor?: string;
  sawWorking?: boolean;
}

/** A runner invocation, injected so core stays independent of @milo/runners. */
export interface RunnerFn {
  (opts: {
    cwd: string;
    prompt: string;
    model: string;
    appendSystemPrompt?: string;
    logFile: string;
    echo?: NodeJS.WritableStream;
    /** Optional progress sink — runners that emit structured events call this as they work. */
    onEvent?: RunnerEventSink;
    /** Abort the run (user-initiated cancel) — the runner kills its whole process group. */
    signal?: AbortSignal;
    /** Optional — existing runners and their tests are unaffected. */
    context?: RunnerContext;
  }): Promise<{
    code: number;
    output: string;
    logFile: string;
    /**
     * Why the run did not finish cleanly, when it didn't. Distinct from `code`: a runner can die
     * mid-response and still exit 0, so the gate needs the runner to say it outright.
     */
    errorDetail?: string;
  }>;
}

export interface RunnerResultLike {
  outcome: "implemented" | "discovery" | "blocked";
  wroteCode: boolean;
  prUrl: string | null;
  summary: string;
  /** Set when the `MILO_RESULT=` line existed but needed repair (or was unrecoverable). */
  parseNote?: string;
}

/**
 * What `makeProcessJob` returns: the queue's per-job entry point, plus `resumeRemote` for jobs
 * parked on an off-machine session (driven by the daemon's remote tracker, not the queue).
 */
export interface ProcessJobFn {
  (job: Job): Promise<void>;
  resumeRemote: (job: Job) => Promise<void>;
}

export interface PipelineDeps {
  config: MiloConfig;
  store: JobStore;
  linear: LinearClient;
  /** Runner functions keyed by id; the job's resolved runner picks one. */
  runners: Partial<Record<RunnerId, RunnerFn>>;
  parseResult: (output: string) => RunnerResultLike;
  echo?: NodeJS.WritableStream;
}

const BACKOFF_MS = [30_000, 120_000, 480_000];

function routingInstruction(repo: RepoConfig, issue: LinearIssue): string {
  for (const label of issue.labels) {
    const r = repo.routing?.[label.toLowerCase().trim()];
    if (r) return r;
  }
  return repo.defaultRouting ?? "No specific routing.";
}

/**
 * Did the run fail to finish? Returns the reason, or undefined for a clean run.
 *
 * The exit code alone isn't enough: `claude -p` can die mid-response (`is_error` on its terminal
 * event) and still exit 0, and a guard that kills a lingering-but-finished CLI exits non-zero on a
 * run that actually succeeded. So the runners report `errorDetail` explicitly and it wins.
 */
function runIncomplete(run: { code: number; errorDetail?: string }): { reason: string } | undefined {
  if (run.errorDetail) return { reason: run.errorDetail };
  if (run.code !== 0) return { reason: `the runner exited ${run.code}` };
  return undefined;
}

function logFilePath(ref: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(logsDir(), `${ref.replace(/[^A-Za-z0-9._-]/g, "_")}-${stamp}.log`);
}

/**
 * Preconditions a remote (Conductor) run needs that a local one doesn't. Returns a human-readable
 * reason when the repo can't be run remotely, or undefined when it can.
 *
 * `githubRepo` is optional in config (it opts a repo into GitHub PR polling), but a remote run is
 * defined entirely in terms of a GitHub branch, so here it is load-bearing.
 */
function remotePreconditions(repo: RepoConfig): string | undefined {
  const slug = repo.githubRepo ?? githubSlugForPath(repo.path);
  if (!slug) {
    return `Repo "${repo.name}" needs \`githubRepo: "owner/name"\` in config to run on Conductor Cloud (Milo verifies remote work through GitHub).`;
  }
  if (!repo.conductor?.projectId && !repo.conductor?.repositoryUrl) {
    // Not fatal on its own — the runner falls back to repositoryUrl — but an organization API key
    // rejects a repo that hasn't been added to the org's machine, so say so plainly up front.
    logger.warn(
      { repo: repo.name },
      "conductor: no projectId configured — falling back to repositoryUrl, which organization API keys reject for repos not on the org machine",
    );
  }
  return undefined;
}

/**
 * Tee a runner's event stream into (1) a per-job transcript file — always, so the TUI / `milo watch`
 * can show a live, replayable transcript even for label-only and scheduled jobs — and (2) the Linear
 * `ProgressStreamer`, when one exists (delegated jobs only). The file sink is best-effort and never
 * throws; `close()` flushes it after the run.
 */
function buildSinks(jobId: string, progress?: ProgressStreamer): { onEvent: RunnerEventSink; close: () => void } {
  const file = makeEventFileSink(jobId);
  const onEvent: RunnerEventSink = (e) => {
    file.sink(e);
    progress?.handle(e);
  };
  return { onEvent, close: file.close };
}

/**
 * Keep a Linear agent session "alive" while a long worktree setup runs: post a best-effort progress
 * thought every `intervalMs` so Linear doesn't stale the session to "error" during the otherwise
 * silent setup window. A fast setup (< intervalMs) posts nothing (the first tick is at intervalMs).
 * No-op when `post` is undefined (no session, or progress disabled). Exported and interval-injectable
 * so it's unit-testable in isolation.
 */
export async function withSetupKeepalive<T>(
  post: (() => void) | undefined,
  fn: () => Promise<T>,
  intervalMs = 30_000,
): Promise<T> {
  if (!post) return fn();
  const iv = setInterval(() => {
    try {
      post();
    } catch {
      /* best-effort — never let a progress post break setup */
    }
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(iv);
  }
}

/** Build the function that processes a single claimed job through its full lifecycle. */
export function makeProcessJob(deps: PipelineDeps) {
  const { config, store, linear, runners, parseResult, echo } = deps;

  /** The remote session already recorded for this job, if any (drives resume-vs-dispatch). */
  const remoteSessionFor = (job: Job): RemoteSession | undefined => {
    const fresh = store.get(job.id) ?? job;
    if (!fresh.remoteWorkspaceId || !fresh.remoteSessionId) return undefined;
    return {
      workspaceId: fresh.remoteWorkspaceId,
      sessionId: fresh.remoteSessionId,
      deepLink: fresh.remoteUrl ?? "",
      cursor: fresh.remoteCursor ?? undefined,
      sawWorking: fresh.remoteSawWorking,
    };
  };

  /**
   * Persist a remote session as soon as the runner reports one. Deliberately synchronous and
   * called BEFORE the prompt is sent: the window between "cloud workspace exists" and "Milo knows
   * about it" is exactly the window in which a crash orphans a workspace and a restart creates a
   * second one.
   */
  const persistRemoteSession = (jobId: string, s: RemoteSession): void => {
    try {
      store.transition(jobId, "running", {
        remote_provider: "conductor",
        remote_workspace_id: s.workspaceId,
        remote_session_id: s.sessionId,
        remote_url: s.deepLink,
        remote_cursor: s.cursor ?? null,
        remote_saw_working: s.sawWorking ? 1 : 0,
      });
    } catch (err) {
      logger.warn({ jobId, err: (err as Error).message }, "could not persist remote session");
    }
  };

  const fail = (job: Job, failureClass: string, detail: string, teardown?: () => void) => {
    const attempt = job.attempts; // attempts already reflects this run's count baseline
    if (attempt + 1 < job.maxAttempts) {
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      store.scheduleRetry(job.id, delay, failureClass, detail);
      logger.warn({ jobId: job.id, failureClass, delay }, "scheduled retry");
      teardown?.(); // fresh worktree next attempt
    } else {
      store.transition(job.id, "needs-attention", { failure_class: failureClass, failure_detail: detail });
      logger.error({ jobId: job.id, failureClass, detail }, "exhausted retries -> needs-attention");
      // keep worktree for debugging unless policy says always
    }
  };

  function selectRunner(runnerId: RunnerId): RunnerFn | undefined {
    return runners[runnerId];
  }

  /**
   * Classify a worktree-setup failure. Deterministic precondition failures (e.g. the branch is
   * checked out in another worktree) go straight to needs-attention — retrying can never fix them,
   * and they are NOT repo infrastructure being flaky, so they must never count toward the circuit
   * breaker. Everything else keeps today's transient-infra retry/breaker behavior.
   */
  async function failWorktreeSetup(
    job: Job,
    repoName: string,
    err: Error,
    notify?: (msg: string) => Promise<void>,
  ): Promise<void> {
    if (isPermanentWorktreeError(err.message)) {
      try {
        await notify?.(`Milo can't work on this right now: ${err.message}`);
      } catch {
        /* best-effort */
      }
      store.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: err.message });
      logger.error({ jobId: job.id, detail: err.message }, "permanent worktree failure -> needs-attention");
      return;
    }
    store.recordRepoInfraFailure(repoName);
    fail(job, "transient-infra", err.message);
  }

  /**
   * Keep the job's lease fresh while a long runner executes (runs can take many minutes; the lease
   * is ~60s). Without this, the watchdog would reclaim a perfectly healthy in-flight job — so an
   * expired lease reliably means the worker is actually gone.
   */
  async function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const iv = setInterval(() => {
      try {
        store.heartbeat(jobId);
      } catch {
        /* ignore transient db contention */
      }
    }, 30_000);
    try {
      return await fn();
    } finally {
      clearInterval(iv);
    }
  }

  /**
   * Circuit breaker: if a repo has tripped (too many consecutive infra failures), abandon the job
   * instead of burning attempts on a broken repo — posting at most ONE comment per open period.
   * Returns true if the job was abandoned.
   */
  async function breakerBlocked(job: Job, repoName: string, notify: (msg: string) => Promise<void>): Promise<boolean> {
    const health = store.repoHealth(repoName);
    if (health.breakerState !== "open") return false;
    const sideKey = `breaker:${repoName}:${health.openedAt}`;
    if (store.alreadyDid(sideKey) === undefined) {
      const until = health.cooldownUntil ? new Date(health.cooldownUntil).toISOString() : "soon";
      try {
        await notify(`Milo paused work on \`${repoName}\` — repeated infrastructure failures tripped the circuit breaker (retry after ${until}).`);
      } catch {
        /* best-effort */
      }
      store.recordSideEffect(sideKey, "breaker-notice");
    }
    store.transition(job.id, "abandoned", {
      failure_class: "breaker",
      failure_detail: `repo ${repoName} circuit breaker open until ${health.cooldownUntil}`,
    });
    logger.warn({ jobId: job.id, repo: repoName }, "circuit breaker open — job abandoned");
    return true;
  }

  function teardownIfNeeded(repo: RepoConfig, worktreePath: string, success: boolean, force = false): void {
    if (!force && repo.teardownPolicy === "keep-on-failure" && !success) {
      logger.info({ worktreePath }, "keeping worktree for debugging");
      return;
    }
    // Best-effort cleanup — fire-and-forget so a heavy teardown script doesn't block the caller (the
    // job is already in its terminal state by here). `teardownWorktree` is async; swallow rejections.
    void teardownWorktree(repo, worktreePath).catch((err) =>
      logger.warn({ err: (err as Error).message }, "teardown had issues"),
    );
  }

  /**
   * Run the agent with cooperative cancellation. Polls the job's cancel flag (~2s — far finer than
   * the 30s heartbeat) and aborts the runner's process group when it flips. Returns whether the run
   * was cancelled so the caller can skip the verification gate (a cancel means "don't ship half-done
   * work"). The lease-owning worker is the only thing that kills + finalizes, so there's no race
   * with the watchdog or the CLI/TUI (which only set the flag).
   */
  async function runWithCancel(
    job: Job,
    opts: Omit<Parameters<RunnerFn>[0], "signal">,
    runner: RunnerFn,
  ): Promise<{ run: Awaited<ReturnType<RunnerFn>>; cancelled: boolean }> {
    const ctrl = new AbortController();
    if (store.isCancelRequested(job.id)) ctrl.abort(); // requested during setup → abort before any work
    const iv = setInterval(() => {
      try {
        if (store.isCancelRequested(job.id)) ctrl.abort();
      } catch {
        /* ignore transient db contention */
      }
    }, 2_000);
    if (typeof iv.unref === "function") iv.unref();
    try {
      const run = await runner({ ...opts, signal: ctrl.signal });
      return { run, cancelled: ctrl.signal.aborted };
    } finally {
      clearInterval(iv);
    }
  }

  /** Finalize a cancelled run: notify (best-effort), mark `cancelled`, and discard the worktree. */
  async function finalizeCancelled(
    job: Job,
    repo: RepoConfig,
    worktreePath: string,
    notify?: () => Promise<void>,
  ): Promise<void> {
    try {
      await notify?.();
    } catch {
      /* best-effort */
    }
    store.transition(job.id, "cancelled", { failure_class: "cancelled", failure_detail: "cancelled by user" });
    teardownIfNeeded(repo, worktreePath, false, true); // force-discard the half-done worktree
    logger.info({ jobId: job.id }, "job cancelled by user");
  }

  // ---------------------------------------------------------------- Linear (create mode)

  async function processLinearJob(job: Job): Promise<void> {
    const ref = job.entityRef ?? job.entityId;
    const teamKey = job.entityId.split("-")[0]!;
    let repo: RepoConfig | undefined;
    let worktree: Worktree | undefined;

    store.transition(job.id, "setting-up");
    store.heartbeat(job.id);

    const issue = await linear.fetchIssue(job.entityId);
    // If the issue was delegated to the Milo agent, drive its "chat" transcript (best-effort).
    const sessionId = await linear.agentSessionForIssue(job.entityId).catch(() => undefined);
    const thought = (body: string) => {
      if (sessionId) void linear.agentThought(sessionId, body);
    };
    // Acknowledge the moment we pick this up, BEFORE the multi-minute setup — otherwise the session
    // sits silent through setup and Linear stales it to "error". This is the authoritative "started"
    // signal (it only fires once the job is actually claimed and about to set up).
    thought("Starting now — setting up an isolated worktree…");

    repo = resolveRepo(config, teamKey, issue.labels);
    if (!repo) {
      if (sessionId) await linear.agentError(sessionId, `Milo couldn't find a configured repo for ${teamKey}.`);
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: `no repo for team key ${teamKey}`,
      });
      return;
    }
    if (repo.name !== job.repo) store.transition(job.id, "setting-up", { repo: repo.name });

    if (await breakerBlocked(job, repo.name, async (msg) => {
      if (sessionId) await linear.agentError(sessionId, msg);
      else await linear.addComment(issue.id, msg);
    })) return;

    const runnerId = resolveRunner(config, repo, {
      labels: issue.labels,
      text: `${issue.title}\n${issue.description}`,
    });
    const runner = selectRunner(runnerId);
    if (!runner) {
      if (sessionId) await linear.agentError(sessionId, `Runner "${runnerId}" isn't registered on this Milo.`);
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: `runner "${runnerId}" is not registered`,
      });
      return;
    }
    const model = modelFor(config, runnerId, repo);
    const remote = isRemoteRunner(runnerId);

    // A remote run's whole contract is "push this branch to this GitHub repo", and the agent is
    // told the slug explicitly. Without one there is nothing to hand it — fail before spending a
    // cloud workspace on a run that cannot be verified.
    if (remote) {
      const gate = remotePreconditions(repo);
      if (gate) {
        if (sessionId) await linear.agentError(sessionId, gate);
        store.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: gate });
        return;
      }
    }

    // Stacked dependency (MILO-4): if a resolved `stacked` blocker recorded its head branch, base
    // this worktree off it so the PRs stack; otherwise base off the repo default.
    const stackedBase = store.stackedBaseFor(job.entityId);
    if (stackedBase) thought(`Stacking on the blocker's branch \`${stackedBase}\` (this PR will target it).`);
    // Keep the session alive across the (often multi-minute) setup so Linear doesn't stale it.
    const setupKeepalive =
      sessionId && resolveProgress(config, repo).enabled ? () => thought("Still preparing the worktree…") : undefined;
    try {
      worktree = await withSetupKeepalive(setupKeepalive, () =>
        withHeartbeat(job.id, () =>
          // A remote run never touches this worktree — it exists only as the git/gh working
          // directory for the verification gate — so installing dependencies here is pure waste
          // (and would hard-fail any repo whose setupScript needs docker).
          createWorktree(repo, job.entityId, issue.title, worktreeBase(config.worktreeBase), stackedBase, undefined, {
            skipSetup: remote,
          }),
        ),
      );
    } catch (err) {
      await failWorktreeSetup(job, repo.name, err as Error, async (msg) => {
        if (sessionId) await linear.agentError(sessionId, msg);
      });
      return;
    }
    const logFile = logFilePath(ref);
    store.transition(job.id, "running", {
      worktree_path: worktree.path,
      branch: worktree.branch,
      base_branch: worktree.baseBranch,
      runner: runnerId,
      model,
      events_log: eventsLogPath(job.id),
      runner_log: logFile,
    });

    // Best-effort In Progress.
    try {
      const inProgress = await linear.findStateId(teamKey, "In Progress", "started");
      if (inProgress) await linear.setIssueState(issue.id, inProgress);
    } catch {
      /* non-fatal */
    }
    const repoSlug = repo.githubRepo ?? githubSlugForPath(repo.path) ?? undefined;
    thought(
      remote
        ? `Handing this to a Conductor Cloud workspace on \`${worktree.branch}\` (${model}).`
        : `Set up an isolated worktree on \`${worktree.branch}\` and started work with ${runnerId} (${model}).`,
    );

    const augment = [config.promptAugmentation.global, repo.promptAugmentation].filter(Boolean).join("\n\n");
    const prompt = remote
      ? buildConductorPrompt({
          repo,
          issue,
          routingInstruction: routingInstruction(repo, issue),
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          githubRepo: repoSlug!, // guaranteed by the remote precondition check above
        })
      : buildPrompt({ repo, worktree, issue, routingInstruction: routingInstruction(repo, issue) });
    store.heartbeat(job.id);

    // Phase C: only stream live progress when the issue was delegated to the agent (has a session).
    // Label-only jobs (no session) stay minimal — they must NOT start spamming issue comments.
    const progressCfg = resolveProgress(config, repo);
    const progress =
      sessionId && progressCfg.enabled
        ? new ProgressStreamer(
            {
              thought: (body) => linear.agentThought(sessionId, body),
              action: (action, parameter, result) => linear.agentAction(sessionId, action, parameter, result),
            },
            { enabled: true, verbosity: progressCfg.verbosity, minIntervalMs: progressCfg.minIntervalMs },
          )
        : undefined;

    const sinks = buildSinks(job.id, progress);
    const { run, cancelled } = await runWithCancel(
      job,
      {
        cwd: worktree.path,
        prompt,
        model,
        appendSystemPrompt: augment || undefined,
        logFile,
        echo,
        onEvent: sinks.onEvent,
        context: {
          jobId: job.id,
          ref,
          repoName: repo.name,
          repoSlug,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          detached: worktree.detached,
          remoteSession: remoteSessionFor(job),
          onRemoteSession: (s) => persistRemoteSession(job.id, s),
          // Dispatch and return, so the local slot isn't held for the whole remote session.
          remotePhase: remote ? "dispatch" : undefined,
        },
      },
      runner,
    );
    sinks.close();
    // Flush any buffered progress and stop before the terminal response so it always lands last.
    await progress?.stop();

    // Remote dispatch succeeded: the cloud session is live and its ids are persisted. Park the job
    // and RETURN — the queue's cap is in-process `inFlight` accounting, so returning here frees the
    // local slot while the (possibly hour-long) remote work continues. A tracker resumes it.
    if (remote && run.code === 0 && !cancelled && store.get(job.id)?.remoteSessionId) {
      store.parkOnRemote(job.id);
      thought("Working in a Conductor Cloud workspace — I'll report back when it finishes.");
      logger.info({ jobId: job.id, entity: job.entityId }, "parked on remote session (slot released)");
      return;
    }

    await finalizeCreateRun({
      job,
      repo,
      worktree,
      issue,
      teamKey,
      sessionId,
      thought,
      ref,
      run,
      cancelled,
    });
  }

  /**
   * The tail every create-mode run shares: cancel handling → parse → verification gate → PR →
   * report → terminal state. Extracted so a LOCAL run (which reaches it inline) and a REMOTE run
   * (which reaches it later, from the tracker, after being parked) cannot drift apart.
   */
  async function finalizeCreateRun(i: {
    job: Job;
    repo: RepoConfig;
    worktree: Worktree;
    issue: LinearIssue;
    teamKey: string;
    sessionId: string | undefined;
    thought: (body: string) => void;
    ref: string;
    run: { code: number; output: string };
    cancelled: boolean;
  }): Promise<void> {
    const { job, repo, worktree, issue, teamKey, sessionId, thought, ref, run, cancelled } = i;

    if (cancelled) {
      await finalizeCancelled(job, repo, worktree.path, async () => {
        if (sessionId) await linear.agentError(sessionId, "Milo cancelled this run.");
      });
      return;
    }
    const result = parseResult(run.output);
    if (result.parseNote) logger.warn({ jobId: job.id, ref, note: result.parseNote }, "runner result needed repair");

    // ---- Verification gate (never trust the self-report) ----
    store.transition(job.id, "verifying", {
      declared_outcome: result.outcome,
      declared_pr_url: result.prUrl,
      declared_wrote_code: result.wroteCode ? 1 : 0,
      summary: result.summary,
    });
    const gt = await resolveGroundTruth(worktree.path, worktree.baseBranch, worktree.branch);
    const incomplete = runIncomplete(run);

    if (gt.codeChanged) {
      let prUrl: string;
      try {
        if (!gt.prUrl) store.transition(job.id, "remediating");
        const ensured = await ensurePr({
          worktreePath: worktree.path,
          baseBranch: worktree.baseBranch,
          branch: worktree.branch,
          ref,
          title: issue.title,
          summary: result.summary,
          closes: ref, // Linear ticket auto-closes on merge
          incomplete,
        });
        prUrl = ensured.prUrl;
        if (ensured.remediated) store.recordEvent(job.id, "remediation", { action: "milo-created-pr", prUrl });
        if (sessionId) await linear.agentAction(sessionId, ensured.remediated ? "opened_pr" : "found_pr", prUrl);
      } catch (err) {
        if (sessionId) await linear.agentError(sessionId, `Code was written but Milo couldn't open a PR: ${(err as Error).message}`);
        fail(job, "no-pr", (err as Error).message);
        return;
      }

      // A run that died mid-flight left code, so it still gets a PR (drafted, and captioned as
      // partial by `ensurePr`) — but it must NOT be recorded as a shipped implementation. WAZ-1150
      // did exactly that on 2026-08-07: an API error at turn 140 produced PR #707 described as
      // "Implements WAZ-1150" and a job marked done, with nothing anywhere saying the run had died.
      if (incomplete) {
        store.transition(job.id, "reporting");
        const sideKey = `${job.id}:report`;
        if (store.alreadyDid(sideKey) === undefined) {
          const body = `Milo's run didn't finish (${incomplete.reason}).\n\nThe partial work is preserved in a **draft** PR — it has NOT been verified and is not ready to merge: ${prUrl}`;
          try {
            // `agentError`, not `agentResponse`: the session must end as failed, not as a delivery.
            if (sessionId) await linear.agentError(sessionId, body);
            else await linear.addComment(issue.id, body);
            store.recordSideEffect(sideKey, "report", prUrl);
          } catch (err) {
            logger.warn({ jobId: job.id, err: (err as Error).message }, "reporting an unfinished run to Linear failed");
          }
        }
        store.transition(job.id, "needs-attention", {
          verified_outcome: "incomplete",
          pr_url: prUrl,
          failure_class: "runner-crash",
          failure_detail: incomplete.reason,
        });
        logger.warn({ jobId: job.id, ref, prUrl, reason: incomplete.reason }, "run did not finish — draft PR, needs attention");
        teardownIfNeeded(repo, worktree.path, false);
        return;
      }

      await reportLinear(job, issue, teamKey, sessionId, { kind: "implemented", prUrl, summary: result.summary });
      store.transition(job.id, "done", { verified_outcome: "implemented", pr_url: prUrl });
      store.recordRepoSuccess(repo.name);
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    if (result.outcome === "discovery" && !incomplete) {
      await reportLinear(job, issue, teamKey, sessionId, { kind: "discovery", summary: result.summary });
      store.transition(job.id, "discovery-done", { verified_outcome: "discovery" });
      store.recordRepoSuccess(repo.name);
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    const detail = incomplete ? incomplete.reason : `declared ${result.outcome} but no code was produced`;
    const willRetry = job.attempts + 1 < job.maxAttempts;
    if (sessionId) {
      if (willRetry) thought(`Hit a snag (${detail}); retrying with a fresh worktree.`);
      else await linear.agentError(sessionId, `Milo couldn't complete this: ${detail}.`);
    }
    fail(job, incomplete ? "runner-crash" : "wrong-outcome", detail, () =>
      teardownIfNeeded(repo, worktree.path, false, true),
    );
  }

  /**
   * Resume a job parked on a remote session: reattach, poll it to completion, then run the same
   * verification tail a local run would. Driven by the daemon's remote tracker, which has its own
   * concurrency cap so waiting on the cloud never starves local work.
   */
  async function resumeRemoteJob(job: Job): Promise<void> {
    const ref = job.entityRef ?? job.entityId;
    const teamKey = job.entityId.split("-")[0]!;
    const repo = resolveRepoByName(config, job.repo);
    const session = remoteSessionFor(job);

    if (!repo || !job.worktreePath || !job.branch || !session) {
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: "parked remote job is missing its repo/worktree/session",
      });
      return;
    }

    const runner = selectRunner((job.runner as RunnerId) ?? "conductor");
    if (!runner) {
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: `runner "${job.runner}" is not registered`,
      });
      return;
    }

    const issue = await linear.fetchIssue(job.entityId);
    const sessionId = await linear.agentSessionForIssue(job.entityId).catch(() => undefined);
    const thought = (body: string) => {
      if (sessionId) void linear.agentThought(sessionId, body);
    };
    const worktree: Worktree = {
      path: job.worktreePath,
      branch: job.branch,
      baseBranch: job.baseBranch ?? repo.baseBranch,
    };

    const progressCfg = resolveProgress(config, repo);
    const progress =
      sessionId && progressCfg.enabled
        ? new ProgressStreamer(
            {
              thought: (body) => linear.agentThought(sessionId, body),
              action: (action, parameter, result) => linear.agentAction(sessionId, action, parameter, result),
            },
            { enabled: true, verbosity: progressCfg.verbosity, minIntervalMs: progressCfg.minIntervalMs },
          )
        : undefined;

    const sinks = buildSinks(job.id, progress);
    const { run, cancelled } = await runWithCancel(
      job,
      {
        cwd: worktree.path,
        prompt: "", // the prompt was delivered at dispatch; this phase only tracks
        model: job.model ?? "",
        logFile: job.runnerLog ?? logFilePath(ref),
        echo,
        onEvent: sinks.onEvent,
        context: {
          jobId: job.id,
          ref,
          repoName: repo.name,
          repoSlug: repo.githubRepo ?? githubSlugForPath(repo.path) ?? undefined,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          detached: worktree.detached,
          remoteSession: session,
          onRemoteSession: (s) => persistRemoteSession(job.id, s),
          remotePhase: "track",
          // Prove the tracker is alive; a parked job holds no worker lease for the watchdog to see.
          onRemotePoll: () => store.remotePoll(job.id),
        },
      },
      runner,
    );
    sinks.close();
    await progress?.stop();

    await finalizeCreateRun({ job, repo, worktree, issue, teamKey, sessionId, thought, ref, run, cancelled });
  }

  // ---------------------------------------------------------------- Linear (revise existing PR)

  /**
   * A follow-up on a Linear ticket Milo already shipped a PR for: attach to that branch, apply the
   * requested revision (the latest `@milo` comment), and push follow-up commits — never a second PR.
   * `prior` is the existing branch/baseBranch/PR from the last implemented job for this entity.
   */
  async function processLinearAttachJob(
    job: Job,
    prior: { branch: string; baseBranch: string; prUrl: string },
  ): Promise<void> {
    const ref = job.entityRef ?? job.entityId;
    const teamKey = job.entityId.split("-")[0]!;
    let repo: RepoConfig | undefined;
    let worktree: Worktree | undefined;

    store.transition(job.id, "setting-up");
    store.heartbeat(job.id);

    const issue = await linear.fetchIssue(job.entityId);
    const sessionId = await linear.agentSessionForIssue(job.entityId).catch(() => undefined);
    const thought = (body: string) => {
      if (sessionId) void linear.agentThought(sessionId, body);
    };
    // Acknowledge on pickup, before attaching the branch, so the session doesn't stale to "error".
    thought("Picked up your follow-up — preparing the branch…");

    repo = resolveRepo(config, teamKey, issue.labels);
    if (!repo) {
      if (sessionId) await linear.agentError(sessionId, `Milo couldn't find a configured repo for ${teamKey}.`);
      store.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: `no repo for team key ${teamKey}` });
      return;
    }
    if (repo.name !== job.repo) store.transition(job.id, "setting-up", { repo: repo.name });

    if (await breakerBlocked(job, repo.name, async (msg) => {
      if (sessionId) await linear.agentError(sessionId, msg);
      else await linear.addComment(issue.id, msg);
    })) return;

    const runnerId = resolveRunner(config, repo, { labels: issue.labels, text: `${issue.title}\n${issue.description}` });
    const runner = selectRunner(runnerId);
    if (!runner) {
      if (sessionId) await linear.agentError(sessionId, `Runner "${runnerId}" isn't registered on this Milo.`);
      store.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: `runner "${runnerId}" is not registered` });
      return;
    }
    const model = modelFor(config, runnerId);

    // Attach to the ticket's existing branch (a distinct worktree dir from create mode's). When the
    // branch is checked out elsewhere (e.g. the developer's tree), attachWorktree falls back to a
    // detached worktree at its head, so this only throws on real failures.
    const setupKeepalive =
      sessionId && resolveProgress(config, repo).enabled ? () => thought("Still preparing the branch…") : undefined;
    try {
      worktree = await withSetupKeepalive(setupKeepalive, () =>
        withHeartbeat(job.id, () =>
          attachWorktree(repo, `${job.entityId}-revise`, prior.branch, prior.baseBranch, worktreeBase(config.worktreeBase)),
        ),
      );
    } catch (err) {
      await failWorktreeSetup(job, repo.name, err as Error, async (msg) => {
        if (sessionId) await linear.agentError(sessionId, msg);
        else await linear.addComment(issue.id, msg);
      });
      return;
    }
    const logFile = logFilePath(ref);
    store.transition(job.id, "running", {
      worktree_path: worktree.path,
      branch: worktree.branch,
      base_branch: worktree.baseBranch,
      runner: runnerId,
      model,
      events_log: eventsLogPath(job.id),
      runner_log: logFile,
    });
    thought(`Picked up your follow-up — revising the existing branch \`${worktree.branch}\` (PR ${prior.prUrl}).`);

    // The revision instruction: prefer the latest delegate-chat prompt (the primary path), falling
    // back to the latest `@milo` issue comment for the non-delegate flow.
    const promptBody = sessionId ? await linear.latestPromptBody(sessionId).catch(() => undefined) : undefined;
    const instruction = (promptBody && promptBody.trim()) || latestMentionInstruction(issue);

    const augment = [config.promptAugmentation.global, repo.promptAugmentation].filter(Boolean).join("\n\n");
    const prompt = buildLinearAttachPrompt({ repo, worktree, issue, prUrl: prior.prUrl, instruction });
    store.heartbeat(job.id);

    const sinks = buildSinks(job.id);
    const { run, cancelled } = await runWithCancel(
      job,
      { cwd: worktree.path, prompt, model, appendSystemPrompt: augment || undefined, logFile, echo, onEvent: sinks.onEvent },
      runner,
    );
    sinks.close();
    if (cancelled) {
      await finalizeCancelled(job, repo, worktree.path, async () => {
        if (sessionId) await linear.agentError(sessionId, "Milo cancelled this revision.");
      });
      return;
    }
    const result = parseResult(run.output);
    if (result.parseNote) logger.warn({ jobId: job.id, ref, note: result.parseNote }, "runner result needed repair");

    store.transition(job.id, "verifying", {
      declared_outcome: result.outcome,
      declared_pr_url: result.prUrl,
      declared_wrote_code: result.wroteCode ? 1 : 0,
      summary: result.summary,
    });
    const gt = await resolveGroundTruth(worktree.path, worktree.baseBranch, worktree.branch);
    const incomplete = runIncomplete(run);

    if (gt.codeChanged) {
      // Push follow-up commits to the EXISTING branch — the open PR updates itself.
      if (!gt.pushed || gt.dirty) store.transition(job.id, "remediating");
      const message = incomplete ? `${ref}: follow-up (partial — run did not finish)` : `${ref}: follow-up`;
      const pushed = await ensurePushed(worktree.path, worktree.baseBranch, worktree.branch, message);
      if (!pushed.pushed) {
        if (sessionId) await linear.agentError(sessionId, `Milo made changes but couldn't push the follow-up to the PR branch.`);
        fail(job, "no-pr", "failed to push follow-up commits to the PR branch");
        return;
      }
      if (pushed.committed) store.recordEvent(job.id, "remediation", { action: "milo-pushed-followup" });

      // Same rule as create mode: pushed, but not delivered. The PR already exists and is the
      // user's, so the revision can't be drafted — the session error is what carries the warning.
      if (incomplete) {
        store.transition(job.id, "reporting");
        const sideKey = `${job.id}:report`;
        if (store.alreadyDid(sideKey) === undefined) {
          const body = `Milo's revision didn't finish (${incomplete.reason}).\n\nPartial work has been pushed to ${prior.prUrl} so it isn't lost, but it has NOT been verified — review it before merging.`;
          try {
            if (sessionId) await linear.agentError(sessionId, body);
            else await linear.addComment(issue.id, body);
            store.recordSideEffect(sideKey, "report", prior.prUrl);
          } catch (err) {
            logger.warn({ jobId: job.id, err: (err as Error).message }, "reporting an unfinished revision to Linear failed");
          }
        }
        store.transition(job.id, "needs-attention", {
          verified_outcome: "incomplete",
          pr_url: prior.prUrl,
          failure_class: "runner-crash",
          failure_detail: incomplete.reason,
        });
        logger.warn({ jobId: job.id, ref, prUrl: prior.prUrl, reason: incomplete.reason }, "revision did not finish — needs attention");
        teardownIfNeeded(repo, worktree.path, false);
        return;
      }

      await reportLinear(job, issue, teamKey, sessionId, { kind: "followup", prUrl: prior.prUrl, summary: result.summary });
      store.transition(job.id, "done", { verified_outcome: "implemented", pr_url: prior.prUrl });
      store.recordRepoSuccess(repo.name);
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    if (result.outcome === "discovery" && !incomplete) {
      // No code change needed (e.g. the comment was a question Milo answered in the summary).
      await reportLinear(job, issue, teamKey, sessionId, { kind: "discovery", summary: result.summary });
      store.transition(job.id, "discovery-done", { verified_outcome: "discovery", pr_url: prior.prUrl });
      store.recordRepoSuccess(repo.name);
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    const detail = incomplete ? incomplete.reason : `declared ${result.outcome} but no code was produced`;
    const willRetry = job.attempts + 1 < job.maxAttempts;
    if (sessionId) {
      if (willRetry) thought(`Hit a snag (${detail}); retrying the revision.`);
      else await linear.agentError(sessionId, `Milo couldn't complete this revision: ${detail}.`);
    }
    fail(job, incomplete ? "runner-crash" : "wrong-outcome", detail, () =>
      teardownIfNeeded(repo!, worktree!.path, false, true),
    );
  }

  // ---------------------------------------------------------------- GitHub (attach mode)

  async function processGithubJob(job: Job): Promise<void> {
    const ref = job.entityRef ?? job.entityId;
    // entityId format: "owner/name#<number>"
    const hash = job.entityId.lastIndexOf("#");
    const slug = job.entityId.slice(0, hash);
    const number = parseInt(job.entityId.slice(hash + 1), 10);
    let repo: RepoConfig | undefined;
    let worktree: Worktree | undefined;

    store.transition(job.id, "setting-up");
    store.heartbeat(job.id);

    repo = resolveRepoByGithub(config, slug);
    if (!repo) {
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: `no configured repo for GitHub ${slug}`,
      });
      return;
    }
    if (repo.name !== job.repo) store.transition(job.id, "setting-up", { repo: repo.name });

    const pr = await fetchPr(slug, number);
    if (!pr) {
      store.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: `PR ${slug}#${number} not found` });
      return;
    }
    if (pr.state !== "OPEN") {
      store.transition(job.id, "discovery-done", { verified_outcome: "skipped", summary: `PR is ${pr.state}, nothing to do` });
      return;
    }
    if (pr.isCrossRepository) {
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: "cross-repository (fork) PRs are not supported in attach mode yet",
      });
      return;
    }

    if (await breakerBlocked(job, repo.name, async (msg) => void (await addPrComment(slug, number, msg)))) return;

    const runnerId = resolveRunner(config, repo, { labels: pr.labels, text: `${pr.title}\n${pr.body}` });
    const runner = selectRunner(runnerId);
    if (!runner) {
      store.transition(job.id, "needs-attention", { failure_class: "logic", failure_detail: `runner "${runnerId}" is not registered` });
      return;
    }
    const model = modelFor(config, runnerId);
    const instruction = await attachInstruction(slug, pr);

    const wtKey = `${repo.name}-pr-${number}`;
    try {
      worktree = await withHeartbeat(job.id, () =>
        attachWorktree(repo, wtKey, pr.headRefName, pr.baseRefName, worktreeBase(config.worktreeBase)),
      );
    } catch (err) {
      await failWorktreeSetup(job, repo.name, err as Error, async (msg) => void (await addPrComment(slug, number, msg)));
      return;
    }
    const logFile = logFilePath(ref);
    store.transition(job.id, "running", {
      worktree_path: worktree.path,
      branch: worktree.branch,
      base_branch: worktree.baseBranch,
      runner: runnerId,
      model,
      events_log: eventsLogPath(job.id),
      runner_log: logFile,
    });

    const augment = [config.promptAugmentation.global, repo.promptAugmentation].filter(Boolean).join("\n\n");
    const prompt = buildAttachPrompt({ repo, worktree, pr, instruction });
    store.heartbeat(job.id);

    const sinks = buildSinks(job.id);
    const { run, cancelled } = await runWithCancel(
      job,
      { cwd: worktree.path, prompt, model, appendSystemPrompt: augment || undefined, logFile, echo, onEvent: sinks.onEvent },
      runner,
    );
    sinks.close();
    if (cancelled) {
      await finalizeCancelled(job, repo, worktree.path, async () => void (await addPrComment(slug, number, "Milo cancelled this run.")));
      return;
    }
    const result = parseResult(run.output);
    if (result.parseNote) logger.warn({ jobId: job.id, ref, note: result.parseNote }, "runner result needed repair");

    store.transition(job.id, "verifying", {
      declared_outcome: result.outcome,
      declared_pr_url: result.prUrl,
      declared_wrote_code: result.wroteCode ? 1 : 0,
      summary: result.summary,
    });
    const gt = await resolveGroundTruth(worktree.path, worktree.baseBranch, worktree.branch);
    const incomplete = runIncomplete(run);

    if (gt.codeChanged) {
      // Update the EXISTING PR — push follow-up commits, never open a second PR.
      if (!gt.pushed || gt.dirty) store.transition(job.id, "remediating");
      const message = incomplete ? `${ref}: follow-up (partial — run did not finish)` : `${ref}: follow-up`;
      const pushed = await ensurePushed(worktree.path, worktree.baseBranch, worktree.branch, message);
      if (!pushed.pushed) {
        fail(job, "no-pr", "failed to push follow-up commits to the PR branch");
        return;
      }
      if (pushed.committed) store.recordEvent(job.id, "remediation", { action: "milo-pushed-followup" });

      // Same rule as create mode: a run that died still pushes (the work exists) but must not be
      // reported as a delivered follow-up. Attach mode can't draft — the PR is someone else's — so
      // the comment carries the warning instead.
      if (incomplete) {
        store.transition(job.id, "reporting");
        const sideKey = `${job.id}:report`;
        if (store.alreadyDid(sideKey) === undefined) {
          await addPrComment(
            slug,
            number,
            `⚠️ **Milo's run didn't finish** (${incomplete.reason}).\n\nPartial work has been pushed to this branch so it isn't lost, but it has NOT been verified — review it before merging.`,
          );
          store.recordSideEffect(sideKey, "report", pr.url);
        }
        store.transition(job.id, "needs-attention", {
          verified_outcome: "incomplete",
          pr_url: pr.url,
          failure_class: "runner-crash",
          failure_detail: incomplete.reason,
        });
        logger.warn({ jobId: job.id, ref, prUrl: pr.url, reason: incomplete.reason }, "attach run did not finish — needs attention");
        teardownIfNeeded(repo, worktree.path, false);
        return;
      }

      await reportGithub(job, slug, number, { kind: "implemented", summary: result.summary, prUrl: pr.url });
      store.transition(job.id, "done", { verified_outcome: "implemented", pr_url: pr.url });
      store.recordRepoSuccess(repo.name);
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    if (result.outcome === "discovery" && !incomplete) {
      await reportGithub(job, slug, number, { kind: "discovery", summary: result.summary, prUrl: pr.url });
      store.transition(job.id, "discovery-done", { verified_outcome: "discovery", pr_url: pr.url });
      store.recordRepoSuccess(repo.name);
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    const detail = incomplete ? incomplete.reason : `declared ${result.outcome} but no code was produced`;
    fail(job, incomplete ? "runner-crash" : "wrong-outcome", detail, () =>
      teardownIfNeeded(repo!, worktree!.path, false, true),
    );
  }

  // ---------------------------------------------------------------- scheduled prompt (no ticket)

  /**
   * A scheduled-prompt job (`source: "prompt"`): run the job's `customPrompt` autonomously in a fresh
   * worktree, with no Linear issue / GitHub PR to fetch or report to. The same verification gate
   * applies — code written ⇒ Milo opens a PR; no code ⇒ a logged report. There is no external thread
   * to comment on, so the runner log + the job's `summary`/`pr_url` columns are the record.
   */
  async function processPromptJob(job: Job): Promise<void> {
    const ref = job.entityRef ?? job.entityId; // the (namespaced) schedule name, e.g. "milo:nightly-tidy"
    let worktree: Worktree | undefined;

    store.transition(job.id, "setting-up");
    store.heartbeat(job.id);

    const repo = resolveRepoByName(config, job.repo);
    if (!repo) {
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: `no configured repo named "${job.repo}"`,
      });
      return;
    }

    if (await breakerBlocked(job, repo.name, async () => {})) return;

    const runnerId: RunnerId = (job.runner as RunnerId) || resolveRunner(config, repo, {});
    const runner = selectRunner(runnerId);
    if (!runner) {
      store.transition(job.id, "needs-attention", {
        failure_class: "logic",
        failure_detail: `runner "${runnerId}" is not registered`,
      });
      return;
    }
    const model = job.model || modelFor(config, runnerId);

    // A per-run worktree key (entityId is stable for per-entity serialization) so each fire gets a
    // fresh branch — and therefore a fresh PR — rather than reusing/attaching to a prior one. The
    // branch mirrors the key (no doubled schedule slug): feature/prompt-<repo>-<name>-<id6>.
    const runKey = `${job.entityId}-${job.id.slice(-6)}`.toLowerCase();
    try {
      worktree = await withHeartbeat(job.id, () =>
        createWorktree(repo, runKey, ref, worktreeBase(config.worktreeBase), undefined, `feature/${runKey}`),
      );
    } catch (err) {
      await failWorktreeSetup(job, repo.name, err as Error);
      return;
    }
    const logFile = logFilePath(ref);
    store.transition(job.id, "running", {
      worktree_path: worktree.path,
      branch: worktree.branch,
      base_branch: worktree.baseBranch,
      runner: runnerId,
      model,
      events_log: eventsLogPath(job.id),
      runner_log: logFile,
    });

    const augment = [config.promptAugmentation.global, repo.promptAugmentation].filter(Boolean).join("\n\n");
    const prompt = buildFreeformPrompt({ repo, worktree, instruction: job.customPrompt ?? "" });
    store.heartbeat(job.id);

    const sinks = buildSinks(job.id);
    const { run, cancelled } = await runWithCancel(
      job,
      { cwd: worktree.path, prompt, model, appendSystemPrompt: augment || undefined, logFile, echo, onEvent: sinks.onEvent },
      runner,
    );
    sinks.close();
    if (cancelled) {
      await finalizeCancelled(job, repo, worktree.path); // no external thread to notify
      return;
    }
    const result = parseResult(run.output);
    if (result.parseNote) logger.warn({ jobId: job.id, ref, note: result.parseNote }, "runner result needed repair");

    store.transition(job.id, "verifying", {
      declared_outcome: result.outcome,
      declared_pr_url: result.prUrl,
      declared_wrote_code: result.wroteCode ? 1 : 0,
      summary: result.summary,
    });
    const gt = await resolveGroundTruth(worktree.path, worktree.baseBranch, worktree.branch);
    const incomplete = runIncomplete(run);

    if (gt.codeChanged) {
      let prUrl: string;
      try {
        if (!gt.prUrl) store.transition(job.id, "remediating");
        const ensured = await ensurePr({
          worktreePath: worktree.path,
          baseBranch: worktree.baseBranch,
          branch: worktree.branch,
          ref,
          title: `Scheduled task: ${ref}`,
          summary: result.summary,
          // No ticket to auto-close — omit the `Closes` line.
          incomplete,
        });
        prUrl = ensured.prUrl;
        if (ensured.remediated) store.recordEvent(job.id, "remediation", { action: "milo-created-pr", prUrl });
      } catch (err) {
        fail(job, "no-pr", (err as Error).message);
        return;
      }
      if (incomplete) {
        store.transition(job.id, "needs-attention", {
          verified_outcome: "incomplete",
          pr_url: prUrl,
          failure_class: "runner-crash",
          failure_detail: incomplete.reason,
        });
        logger.warn({ jobId: job.id, schedule: ref, prUrl, reason: incomplete.reason }, "scheduled prompt did not finish — draft PR");
        teardownIfNeeded(repo, worktree.path, false);
        return;
      }
      store.transition(job.id, "done", { verified_outcome: "implemented", pr_url: prUrl });
      store.recordRepoSuccess(repo.name);
      logger.info({ jobId: job.id, schedule: ref, prUrl, summary: result.summary }, "scheduled prompt opened a PR");
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    if (result.outcome === "discovery" && !incomplete) {
      store.transition(job.id, "discovery-done", { verified_outcome: "discovery" });
      store.recordRepoSuccess(repo.name);
      logger.info({ jobId: job.id, schedule: ref, summary: result.summary }, "scheduled prompt ran (no code change)");
      teardownIfNeeded(repo, worktree.path, true);
      return;
    }

    const detail = incomplete ? incomplete.reason : `declared ${result.outcome} but no code was produced`;
    fail(job, incomplete ? "runner-crash" : "wrong-outcome", detail, () =>
      teardownIfNeeded(repo, worktree!.path, false, true),
    );
  }

  // ---------------------------------------------------------------- dispatch

  const processJob = async function processJob(job: Job): Promise<void> {
    try {
      // Heartbeat for the whole active lifecycle so the lease only expires if processing truly dies.
      await withHeartbeat(job.id, () => {
        if (job.source === "prompt") return processPromptJob(job);
        if (job.source === "github") return processGithubJob(job);
        // A Linear re-trigger (a new @milo comment or re-delegation) on a ticket Milo already shipped
        // a PR for becomes a revision of that same branch — never a second PR. The first run, with no
        // prior PR, goes through create mode.
        const prior = store.lastImplementedForEntity(job.entityId);
        return prior ? processLinearAttachJob(job, prior) : processLinearJob(job);
      });
    } catch (err) {
      logger.error({ jobId: job.id, err: (err as Error).message }, "pipeline error");
      fail(job, "unexpected", (err as Error).message);
    }
  } as ProcessJobFn;

  /**
   * Continue a job parked on a remote session. Separate from `processJob` because it must NOT be
   * re-dispatched through the main queue — the whole point is that it doesn't consume a local slot.
   * The daemon's remote tracker drives this under its own cap.
   */
  processJob.resumeRemote = async (job: Job): Promise<void> => {
    try {
      await resumeRemoteJob(job);
    } catch (err) {
      const detail = (err as Error).message;
      // The tick failed, but the cloud session is almost certainly still working (this fires for
      // things like a Linear API blip while fetching the issue). Keep the job parked WITH its
      // session so the next tracker tick reattaches — never requeue, which would dispatch a second
      // workspace and abandon the one doing the work.
      const outcome = store.retryRemoteTracking(job.id, "transient-infra", detail);
      logger.warn({ jobId: job.id, err: detail, outcome }, "remote resume tick failed");
    }
  };

  return processJob;

  // ---------------------------------------------------------------- reporting

  async function reportLinear(
    job: Job,
    issue: LinearIssue,
    teamKey: string,
    sessionId: string | undefined,
    r: { kind: "implemented" | "discovery" | "followup"; prUrl?: string; summary: string },
  ): Promise<void> {
    store.transition(job.id, "reporting");
    // followups happen repeatedly on one ticket — scope the idempotency key per job, not per report.
    const sideKey = `${job.id}:report`;
    if (store.alreadyDid(sideKey) !== undefined) return;
    // An empty summary means the agent's MILO_RESULT line was missing or unrecoverable. Say that,
    // rather than posting a report whose body is nothing but a bare link (WAZ-1107, 2026-08-06).
    const summary = r.summary.trim() || "_The agent didn't leave a summary — see the PR description for what changed._";
    const body =
      r.kind === "followup" && r.prUrl
        ? `Milo pushed a follow-up to the PR (${r.prUrl}):\n\n${summary}`
        : r.kind === "implemented" && r.prUrl
          ? `Milo submitted a PR for this ticket: ${r.prUrl}\n\n${summary}`
          : `Milo investigated this ticket (no code change required):\n\n${summary}`;
    try {
      // When the issue was delegated to the agent, the canonical reply is the agent-session
      // "response" (which also completes the chat). Otherwise fall back to an issue comment.
      if (sessionId) await linear.agentResponse(sessionId, body);
      else await linear.addComment(issue.id, body);

      if (r.kind === "implemented" || r.kind === "followup") {
        const inReview = await linear.findStateId(teamKey, "In Review", "started");
        if (inReview) await linear.setIssueState(issue.id, inReview);
      }
      store.recordSideEffect(sideKey, "report", r.prUrl ?? "discovery");
    } catch (err) {
      logger.warn({ jobId: job.id, err: (err as Error).message }, "report to Linear failed");
    }
  }

  async function reportGithub(
    job: Job,
    slug: string,
    number: number,
    r: { kind: "implemented" | "discovery"; summary: string; prUrl: string },
  ): Promise<void> {
    store.transition(job.id, "reporting");
    const sideKey = `${job.id}:report`;
    if (store.alreadyDid(sideKey) !== undefined) return;
    const body =
      r.kind === "implemented"
        ? `Milo pushed a follow-up to this PR:\n\n${r.summary}`
        : `Milo looked into this PR (no code change made):\n\n${r.summary}`;
    try {
      await addPrComment(slug, number, body);
      store.recordSideEffect(sideKey, "report", r.prUrl);
    } catch (err) {
      logger.warn({ jobId: job.id, err: (err as Error).message }, "report to GitHub failed");
    }
  }
}

/** The revision request from a Linear ticket: the most recent `@milo` comment, else a default. */
function latestMentionInstruction(issue: LinearIssue): string {
  const mentions = issue.comments.filter((c) => /@milo\b/i.test(c.body));
  const latest = mentions[mentions.length - 1];
  if (latest) return latest.body.replace(/@milo\b/gi, "").trim() || "Address the request in the latest comment.";
  return "Address the latest feedback on this ticket and update the existing PR accordingly.";
}

/** The instruction that triggered an attach job: the most recent `@milo` comment, else a default. */
async function attachInstruction(slug: string, pr: PullRequest): Promise<string> {
  const number = pr.number;
  const mentions = (await prComments(slug, number)).filter((c) => /@milo\b/i.test(c.body));
  const latest = mentions[mentions.length - 1];
  if (latest) return latest.body.replace(/@milo\b/gi, "").trim() || "Address the request in the latest comment.";
  return "Address the latest review feedback on this PR and update it accordingly.";
}
