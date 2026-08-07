import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MiloConfig, RunnerEvent, RunnerEventSink, RunnerFn } from "@milo/core";
import { conductorAgentFor, logger, resolveConductorApiKey, resolveRepoByName } from "@milo/core";
import {
  ConductorClient,
  ConductorError,
  type ConductorAgent,
  type ConductorEffort,
  type ConductorMessage,
  type CreatedWorkspace,
} from "./conductor-api.js";
import { syncWorktreeFromRemote, listRemoteBranches } from "./conductor-git.js";
import { mapStreamJsonEvent } from "./stream-json.js";

/**
 * ConductorRunner — the remote runner.
 *
 * Milo creates a Conductor Cloud workspace, sends the task as a chat message, polls the session to
 * completion, then fast-forwards the local worktree from the branch the remote pushed so the
 * ordinary verification gate can open the PR. The cross-boundary contract is a **branch name**: the
 * prompt tells the agent exactly which branch to push and forbids it from opening the PR itself.
 *
 * Conductor runs Claude Code inside the workspace and relays its `stream-json` verbatim as
 * `content.rawPayload`, so the transcript mapping is shared with `runClaude` (see `stream-json.ts`)
 * and `milo watch` / the TUI / Linear progress streaming all work unchanged.
 */

export interface ConductorSession {
  workspaceId: string;
  sessionId: string;
  deepLink: string;
  /** Last consumed message id — resume polls from here so nothing is re-emitted. */
  cursor?: string;
  /** Whether a `working` status has been observed (see the idle/working latch below). */
  sawWorking?: boolean;
}

export interface ConductorRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  appendSystemPrompt?: string;
  logFile: string;
  echo?: NodeJS.WritableStream;
  onEvent?: RunnerEventSink;
  signal?: AbortSignal;

  /** Auth + tuning, resolved by the caller from config. */
  api: ConductorClient;
  /** Conductor project id (required — org keys reject `repositoryUrl` for unprovisioned repos). */
  projectId?: string;
  repositoryUrl?: string;
  /** Which agent runs inside the workspace. Orthogonal to Milo's runner id. */
  agent?: ConductorAgent;
  effort?: ConductorEffort;
  env?: Record<string, string>;

  /** The branch the remote MUST push to — the whole local/remote contract. */
  branch: string;
  baseBranch: string;
  /** Worktree is detached (branch checked out elsewhere) — skip setting an upstream. */
  detached?: boolean;
  /** Stable, human-readable workspace name (also used to adopt an orphan after a crash). */
  workspaceName: string;
  sessionName?: string;

  /** An existing session to resume instead of creating a new workspace. */
  resume?: ConductorSession;
  /** Called whenever durable session state changes, so the caller can persist it. */
  onSession?: (session: ConductorSession) => void;

  pollMs?: number;
  dispatchTimeoutMs?: number;
  inactivityMs?: number;
  maxRunMs?: number;
  /** Attempts to nudge the session into pushing work it left behind. 0 disables. */
  remediationAttempts?: number;
  /** Cloud workspace disposition once the run ends (mirrors `teardownPolicy`). */
  onSuccessCleanup?: "archive" | "sleep" | "keep";
  onFailureCleanup?: "archive" | "sleep" | "keep";
  /**
   * Split the run so the caller can free its local concurrency slot while the remote works:
   *  - `dispatch` — create the workspace, send the prompt, persist the session, return immediately
   *  - `track`    — reattach to `resume` and poll it to completion, then verify
   * Omit for the all-in-one behaviour.
   */
  phase?: "dispatch" | "track";
  /** Called on each poll of a tracked session, so the caller can prove the tracker is alive. */
  onPoll?: () => void;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ConductorRunResult {
  code: number;
  output: string;
  logFile: string;
  session?: ConductorSession;
  /** Set when the run finished but its work never reached origin (unrecoverable remotely). */
  unreachableWork?: boolean;
  /** Set by `phase: "dispatch"` — the session is live and the caller should park the job. */
  dispatched?: boolean;
  /** Why the run did not finish cleanly, when it didn't. See {@link ClaudeRunResult.errorDetail}. */
  errorDetail?: string;
}

/**
 * A deterministic UUIDv5-shaped id derived from `seed`.
 *
 * Conductor stores `messageId` in a `uuid` column and rejects anything else
 * (`invalid input syntax for type uuid`), but we still want it to be an *idempotency key* — a resend
 * after a network blip must not double-prompt the agent — so it has to be derived, not random.
 */
function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  // Stamp the version (5) and variant (8/9/a/b) nibbles so it's a well-formed UUID.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

const DEFAULTS = {
  pollMs: 15_000,
  dispatchTimeoutMs: 10 * 60_000,
  inactivityMs: 25 * 60_000,
  maxRunMs: 3 * 60 * 60_000,
  remediationAttempts: 1,
};

/** How many consecutive `idle` polls with real transcript activity count as a finished fast turn. */
const FAST_TURN_IDLE_POLLS = 4;

export function runConductor(opts: ConductorRunOptions): Promise<ConductorRunResult> {
  return new ConductorRun(opts).execute();
}

class ConductorRun {
  private readonly o: ConductorRunOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: NodeJS.WritableStream;
  private output = "";
  private session: ConductorSession | undefined;
  private lastActivityAt: number;
  private startedAt: number;

  constructor(opts: ConductorRunOptions) {
    this.o = opts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(opts.logFile), { recursive: true });
    this.log = createWriteStream(opts.logFile, { flags: "a" });
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * True while re-reading already-consumed transcript on resume. The messages are replayed purely to
   * rebuild `output`; re-emitting them would repost the whole run's narration to the Linear session
   * and re-append it to the log, so every outward-facing sink is muted for the duration.
   */
  private replaying = false;

  private emit(e: RunnerEvent): void {
    if (this.replaying) return;
    try {
      this.o.onEvent?.(e);
    } catch {
      /* a sink must never break the run */
    }
  }

  private echoWrite(s: string): void {
    if (this.replaying) return;
    this.o.echo?.write(s);
  }

  private writeLog(obj: unknown): void {
    if (this.replaying) return;
    try {
      this.log.write(JSON.stringify(obj) + "\n");
    } catch {
      /* logging must never break the run */
    }
  }

  private appendText(text: string): void {
    this.output += (this.output.endsWith("\n") || this.output === "" ? "" : "\n") + text + "\n";
    this.echoWrite(text.endsWith("\n") ? text : text + "\n");
  }

  private note(text: string): void {
    this.emit({ kind: "notice", text });
    this.echoWrite(`• ${text}\n`);
  }

  private persist(): void {
    if (this.replaying) return; // a replay must not rewind the durable cursor
    if (this.session) {
      try {
        this.o.onSession?.({ ...this.session });
      } catch {
        /* persistence is best-effort */
      }
    }
  }

  private done(code: number, extra: Partial<ConductorRunResult> = {}): ConductorRunResult {
    try {
      this.log.end();
    } catch {
      /* ignore */
    }
    return { code, output: this.output, logFile: this.o.logFile, session: this.session, ...extra };
  }

  // ---------------------------------------------------------------- lifecycle

  async execute(): Promise<ConductorRunResult> {
    try {
      return await this.run();
    } catch (err) {
      const message =
        err instanceof ConductorError
          ? `${err.userMessage}${err.code ? ` (${err.code})` : ""}`
          : (err as Error).message;
      logger.error({ err: message }, "conductor run failed");
      this.writeLog({ t: "error", message });
      this.appendText(`[milo] Conductor run failed: ${message}`);
      this.note(`Conductor run failed: ${message}`);
      return this.done(1, { errorDetail: message.slice(0, 300) });
    }
  }

  private async run(): Promise<ConductorRunResult> {
    if (this.o.signal?.aborted) {
      // Cancel arrived before this call did. If a session is already live (we're resuming a parked
      // job), it must still be stopped — otherwise the cloud workspace keeps burning through the
      // task with nothing left watching it.
      const live = this.o.resume;
      if (live?.sessionId) {
        this.session = { ...live };
        await this.o.api.cancelSession(live.sessionId).catch(() => {});
        this.writeLog({ t: "cancel", sessionId: live.sessionId, before: "resume" });
        this.appendText("[milo] Cancelled the running Conductor session.");
        await this.cleanup(false);
        return this.done(1);
      }
      this.appendText("[milo] Cancelled before the Conductor session started.");
      return this.done(1);
    }

    await this.establishSession();
    const s = this.session!;

    this.writeLog({
      t: "meta",
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
      deepLink: s.deepLink,
      agent: this.o.agent,
      model: this.o.model,
      branch: this.o.branch,
      baseBranch: this.o.baseBranch,
    });

    // Dispatch-only: the session is live and persisted. The caller parks the job — freeing its
    // local concurrency slot — and a tracker resumes from here when the remote finishes.
    if (this.o.phase === "dispatch") {
      this.note("Dispatched to Conductor Cloud — Milo will pick the result up when it finishes.");
      return this.done(0, { dispatched: true });
    }

    const settled = await this.trackToSettled();
    if (settled === "cancelled") {
      await this.cleanup(false);
      return this.done(1);
    }

    // Ground truth beats the self-report: check origin for the branch regardless of what the
    // transcript claimed.
    let sync = await syncWorktreeFromRemote(this.o.cwd, this.o.branch, { detached: this.o.detached });

    if (!sync.synced) {
      sync = await this.remediateUnpushed(sync.candidates);
    }

    if (!sync.synced) {
      await this.reportUnreachable(sync.candidates);
      // Never archive — the work only exists in that workspace.
      await this.cleanup(false, /* preserve */ true);
      return this.done(1, { unreachableWork: true });
    }

    await this.cleanup(settled === "ok");
    if (settled === "ok") return this.done(0);
    return this.done(1, {
      errorDetail:
        settled === "error"
          ? "the Conductor session reported an error"
          : "the Conductor session was cancelled after a timeout",
    });
  }

  /** Resume an existing session when possible, else create a fresh workspace. */
  private async establishSession(): Promise<void> {
    const resume = this.o.resume;
    if (resume?.workspaceId && resume.sessionId) {
      const status = await this.o.api.workspaceStatus(resume.workspaceId).catch(() => undefined);
      const alive = status && status.status !== "archived" && status.status !== "deleted";
      if (alive) {
        this.session = { ...resume };
        this.note(`Reconnected to the Conductor workspace already running this job.`);
        this.writeLog({ t: "resume", workspaceId: resume.workspaceId, sessionId: resume.sessionId });
        // Replay the WHOLE transcript, not just what's past the saved cursor. `output` starts empty
        // on every invocation, so draining from the cursor rebuilds nothing — and a resume that
        // finds no new messages (its predecessor already consumed them) would then finalize on an
        // empty output, losing the agent's MILO_RESULT entirely. SBX-16 shipped PR #19 described as
        // "Implements SBX-16" that way on 2026-08-05, with a good 311-char summary sitting unread in
        // the transcript. The cursor is restored afterwards so `persist` stays correct.
        this.replaying = true;
        this.session.cursor = undefined;
        try {
          await this.drainMessages();
        } finally {
          this.replaying = false;
          this.session.cursor ??= resume.cursor; // an empty transcript leaves the saved cursor intact
        }
        return;
      }
      this.note("The previous Conductor workspace is gone — starting a fresh one.");
    }

    const created = await this.createWorkspace();
    this.session = { workspaceId: created.workspaceId, sessionId: created.sessionId, deepLink: created.deepLink };
    this.persist(); // persist BEFORE prompting, so a crash here resumes instead of duplicating
    this.note(`Conductor session started — watch it live: ${created.deepLink}`);

    const prompt = this.o.appendSystemPrompt
      ? `${this.o.appendSystemPrompt}\n\n---\n\n${this.o.prompt}`
      : this.o.prompt;
    await this.o.api.sendMessage(created.sessionId, prompt, stableUuid(`${this.o.workspaceName}:prompt`));
    this.writeLog({ t: "prompt-sent", sessionId: created.sessionId });
  }

  private async createWorkspace(): Promise<CreatedWorkspace> {
    const input = {
      ...(this.o.projectId ? { projectId: this.o.projectId } : { repositoryUrl: this.o.repositoryUrl }),
      branch: this.o.baseBranch,
      name: this.o.workspaceName,
      sessionName: this.o.sessionName ?? this.o.workspaceName,
      agent: this.o.agent ?? "claude",
      model: this.o.model,
      ...(this.o.effort ? { effort: this.o.effort } : {}),
      ...(this.o.env && Object.keys(this.o.env).length ? { env: this.o.env } : {}),
    };
    this.writeLog({ t: "create-workspace", input: { ...input, env: undefined } });
    try {
      return await this.o.api.createWorkspace(input);
    } catch (err) {
      // The model enum churns on a beta API; an unknown id shouldn't sink the job.
      if (err instanceof ConductorError && /model/i.test(err.userMessage)) {
        this.note(`Conductor rejected model "${this.o.model}" — retrying with its default.`);
        return this.o.api.createWorkspace({ ...input, model: undefined });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- polling

  /**
   * Poll until the session settles.
   *
   * Conductor's documented caveat: a queued prompt reports `idle` until its turn actually starts, so
   * `idle` is only trustworthy once `working` has been seen. That latch is persisted, because a
   * daemon restart mid-run would otherwise resume with `sawWorking: false`, observe the `idle`
   * between turns, and wrongly declare the run finished.
   */
  private async trackToSettled(): Promise<"ok" | "error" | "cancelled" | "timeout"> {
    const pollMs = this.o.pollMs ?? DEFAULTS.pollMs;
    const dispatchTimeoutMs = this.o.dispatchTimeoutMs ?? DEFAULTS.dispatchTimeoutMs;
    const inactivityMs = this.o.inactivityMs ?? DEFAULTS.inactivityMs;
    const maxRunMs = this.o.maxRunMs ?? DEFAULTS.maxRunMs;
    const s = this.session!;
    let idleStreak = 0;

    for (;;) {
      if (this.o.signal?.aborted) {
        this.note("Cancelling the Conductor session…");
        await this.o.api.cancelSession(s.sessionId).catch(() => {});
        this.writeLog({ t: "cancel", sessionId: s.sessionId });
        return "cancelled";
      }

      const status = await this.o.api.sessionStatus(s.sessionId).catch((err) => {
        // A transient status blip must not end a healthy multi-hour run.
        logger.warn({ err: (err as Error).message }, "conductor: status poll failed");
        return undefined;
      });

      const got = await this.drainMessages();
      if (got > 0) this.lastActivityAt = this.now();

      if (status) {
        this.writeLog({ t: "status", status: status.status, at: this.now() });
        if (status.status === "working" && !s.sawWorking) {
          s.sawWorking = true;
          this.persist();
        }
        if (status.status === "error") {
          const detail = status.errorMessage ?? status.lastError ?? "unknown error";
          this.appendText(`[milo] Conductor session reported an error: ${detail}`);
          this.note(`Conductor session errored: ${detail}`);
          return "error";
        }
        if (status.status === "idle") {
          if (s.sawWorking) return "ok";
          idleStreak++;
          // A very fast turn can start and finish between polls; trust transcript activity.
          if (this.output.includes("MILO_RESULT=")) return "ok";
          if (idleStreak >= FAST_TURN_IDLE_POLLS && this.output.trim() !== "") return "ok";
          if (this.now() - this.startedAt > dispatchTimeoutMs) {
            this.appendText("[milo] The Conductor session never started a turn.");
            return "timeout";
          }
        } else {
          idleStreak = 0;
        }
      }

      // Guards, mirroring the local runners' vocabulary (see guards.ts).
      if (this.now() - this.lastActivityAt > inactivityMs) {
        this.note("Conductor session went silent — cancelling.");
        await this.o.api.cancelSession(s.sessionId).catch(() => {});
        this.appendText("[milo] Conductor session was cancelled after a long silence.");
        return "timeout";
      }
      if (this.now() - this.startedAt > maxRunMs) {
        this.note("Conductor session hit the wall-clock cap — cancelling.");
        await this.o.api.cancelSession(s.sessionId).catch(() => {});
        this.appendText("[milo] Conductor session exceeded the maximum run time.");
        return "timeout";
      }

      try {
        this.o.onPoll?.();
      } catch {
        /* liveness reporting must never break the run */
      }
      await this.sleep(pollMs);
    }
  }

  /** Consume new transcript messages from the cursor, mapping them to events + output. */
  private async drainMessages(): Promise<number> {
    const s = this.session!;
    let consumed = 0;
    for (;;) {
      const page = await this.o.api
        .sessionMessages(s.sessionId, s.cursor ? { after: s.cursor } : {})
        .catch((err) => {
          logger.warn({ err: (err as Error).message }, "conductor: message poll failed");
          return undefined;
        });
      if (!page || page.data.length === 0) break;

      for (const m of page.data) {
        this.writeLog({ t: "message", message: m });
        this.handleMessage(m);
        s.cursor = m.id;
        consumed++;
      }
      this.persist();
      if (!page.hasMore) break;
    }
    return consumed;
  }

  private handleMessage(m: ConductorMessage): void {
    // Never fold our own prompt back into `output`. Beyond being noise, the prompt contains a
    // literal `MILO_RESULT={…}` EXAMPLE — if the agent never emits a real one, the fallback parser
    // would happily parse the example and report a PR that does not exist.
    if (m.type !== "agent") return;

    const content = m.content as Record<string, unknown> | undefined;
    const raw = content?.["rawPayload"];
    if (!raw) return;

    for (const item of mapStreamJsonEvent(raw)) {
      if (item.kind === "text") {
        this.appendText(item.text);
        this.emit({ kind: "narration", text: item.text });
      } else if (item.kind === "event") {
        this.emit(item.event);
        this.echoWrite(`• ${item.event.text}\n`);
      } else {
        this.output += (this.output.endsWith("\n") ? "" : "\n") + item.text + "\n";
        if (item.isError) this.emit({ kind: "notice", text: `Run reported an error: ${item.text}` });
      }
    }
  }

  // ---------------------------------------------------------------- recovery

  /**
   * The agent finished but nothing reached origin — the work is sitting in a cloud filesystem Milo
   * cannot touch. The only channel back is another message, so ask it to push, then re-check.
   * This is the remote analogue of the focused-runner remediation cycle in REMAINING-WORK B1.
   */
  private async remediateUnpushed(candidates: string[]) {
    const attempts = this.o.remediationAttempts ?? DEFAULTS.remediationAttempts;
    let sync = { synced: false, candidates } as Awaited<ReturnType<typeof syncWorktreeFromRemote>>;

    for (let i = 0; i < attempts; i++) {
      const s = this.session!;
      this.note("Your changes aren't on GitHub yet — asking the Conductor session to push them.");
      this.writeLog({ t: "remediate", attempt: i + 1 });

      await this.o.api
        .sendMessage(s.sessionId, buildPushRemediationMessage(this.o.branch), stableUuid(`${this.o.workspaceName}:fix:${i + 1}`))
        .catch(() => {});

      // A fresh turn: reset the latch so we wait for `working` again rather than trusting the
      // `idle` we are currently sitting in.
      s.sawWorking = false;
      this.persist();
      this.startedAt = this.now();
      this.lastActivityAt = this.now();

      const settled = await this.trackToSettled();
      if (settled === "cancelled") return sync;

      sync = await syncWorktreeFromRemote(this.o.cwd, this.o.branch, { detached: this.o.detached });
      if (sync.synced) {
        this.note("Recovered — the session pushed its work.");
        return sync;
      }
    }
    return sync;
  }

  /** Fail loudly, naming where the work actually is. */
  private async reportUnreachable(candidates: string[]): Promise<void> {
    const s = this.session!;
    const known = candidates.length ? candidates : await listRemoteBranches(this.o.cwd).catch(() => []);
    const near = known.filter((b) => b.includes(this.o.branch.split("/").pop() ?? "")).slice(0, 5);
    const detail = [
      `[milo] The Conductor session finished but branch "${this.o.branch}" is not on origin.`,
      near.length ? `Similar branches on origin: ${near.join(", ")}.` : "",
      `Any code written in the cloud workspace is unreachable from this machine.`,
      `The workspace has been left running so nothing is lost — open it: ${s.deepLink}`,
    ]
      .filter(Boolean)
      .join(" ");
    this.appendText(detail);
    this.note(detail);
    this.writeLog({ t: "unreachable", branch: this.o.branch, candidates: near, deepLink: s.deepLink });
  }

  /** Archive/sleep/keep the cloud workspace. Best-effort — never throws, never fails a good run. */
  private async cleanup(success: boolean, preserve = false): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (preserve) {
      this.writeLog({ t: "cleanup", action: "preserved" });
      return;
    }
    const action = success ? this.o.onSuccessCleanup : this.o.onFailureCleanup;
    try {
      if (action === "archive") await this.o.api.archiveWorkspace(s.workspaceId);
      else if (action === "sleep") await this.o.api.sleepWorkspace(s.workspaceId);
      this.writeLog({ t: "cleanup", action });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "conductor: workspace cleanup failed");
    }
  }
}

/**
 * Adapt {@link runConductor} to the pipeline's `RunnerFn` shape.
 *
 * Returns undefined when no API key is configured — the pipeline then reports "runner not
 * registered" through its existing path, exactly as it would for an unknown runner id, rather than
 * failing a job with an obscure auth error.
 */
export function makeConductorRunner(config: MiloConfig): RunnerFn | undefined {
  const apiKey = resolveConductorApiKey(config);
  if (!apiKey) return undefined;

  const api = new ConductorClient({
    apiKey,
    baseUrl: config.conductor.baseUrl,
    userAgent: config.conductor.userAgent,
  });

  return async (opts) => {
    const ctx = opts.context;
    if (!ctx) {
      return {
        code: 1,
        output: "[milo] The conductor runner requires job context (branch/baseBranch) and got none.",
        logFile: opts.logFile,
      };
    }
    const repo = resolveRepoByName(config, ctx.repoName);
    const cond = repo?.conductor;

    const res = await runConductor({
      cwd: opts.cwd,
      prompt: opts.prompt,
      model: opts.model,
      appendSystemPrompt: opts.appendSystemPrompt,
      logFile: opts.logFile,
      echo: opts.echo,
      onEvent: opts.onEvent,
      signal: opts.signal,
      api,
      projectId: cond?.projectId,
      repositoryUrl: cond?.repositoryUrl ?? (ctx.repoSlug ? `https://github.com/${ctx.repoSlug}` : undefined),
      agent: conductorAgentFor(config, repo),
      effort: cond?.effort ?? config.conductor.effort,
      env: config.conductor.env,
      branch: ctx.branch,
      baseBranch: ctx.baseBranch,
      detached: ctx.detached,
      // Stable across a restart (job ids are ULIDs), so a resumed run can recognise its workspace.
      workspaceName: `milo-${ctx.ref.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${ctx.jobId.slice(-6).toLowerCase()}`,
      sessionName: ctx.ref,
      resume: ctx.remoteSession,
      onSession: ctx.onRemoteSession,
      phase: ctx.remotePhase,
      onPoll: ctx.onRemotePoll,
      pollMs: config.conductor.pollMs,
      dispatchTimeoutMs: config.conductor.dispatchTimeoutMs,
      onSuccessCleanup: config.conductor.cleanup.onSuccess,
      onFailureCleanup: config.conductor.cleanup.onFailure,
    });
    return { code: res.code, output: res.output, logFile: res.logFile };
  };
}

/** The focused "push what you have" message — deliberately narrow, no other work. */
export function buildPushRemediationMessage(branch: string): string {
  return `Your work has not reached GitHub. Milo runs on a different machine and can only see what is pushed to \`origin\`.

Do ONLY the following — make no other code changes:

1. \`git status --short\`
2. \`git branch --show-current\` — if it is not \`${branch}\`, run \`git switch -c ${branch}\` (or \`git switch ${branch}\`)
3. \`git add -A && git commit -m "wip"\` (skip if there is nothing to commit)
4. \`git push -u origin ${branch}\`
5. \`git ls-remote --exit-code origin ${branch}\` — this MUST succeed

Reply with the output of step 5 and nothing else.`;
}
