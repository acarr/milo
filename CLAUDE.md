# Milo — agent/contributor guide

Milo is a **locally-running autonomous coding agent**: assign it a Linear ticket (`milo` label or
agent delegation), `@milo` a GitHub PR, run `milo <ID>`, or schedule it — and it does the work on the
local machine — worktree → implement → verify → PR → update Linear/GitHub — using the Claude or Codex
**subscription** (never API billing). It's a reliability-focused local agent that **coexists** with
other tools on the box.

This is the contributor/agent guide (architecture, conventions, gotchas). User-facing docs live in
`README.md` and the reference set under `docs/` (index at `docs/README.md` — installation,
configuration, cli, architecture, triggers, job-lifecycle, runners, reliability, scheduling, webhooks,
database, operations).

## Capabilities

- **Four trigger surfaces** — a `milo` label or agent-session delegation in Linear, a `milo` label /
  `@milo` comment on a GitHub PR (attach mode), the `milo <ID>` CLI, and cron schedules (including
  in-repo `.milo/schedules.json` prompt schedules).
- **Three runners** — ClaudeRunner and CodexRunner run locally; **ConductorRunner** hands the work to a
  Conductor Cloud workspace. Selection is unchanged: `[agent=<id>]` in the issue > a `runner:<id>` label
  > the repo default > the global default.
- **Reliability core** — durable SQLite queue, bounded concurrency + per-entity serialization,
  retry/backoff, crash recovery, a per-repo circuit breaker, and a lease watchdog that requeues jobs
  whose worker died.
- **Verification gate** — never trusts the agent's self-report; resolves real git/`gh` state and opens
  the PR itself if code was written but no PR exists, writing a description from the commits + diffstat
  rather than relying on the agent's summary. Discovery-only work correctly produces no PR. A run that
  didn't finish still gets its work preserved, but as a **draft** PR + `needs-attention`, never `done`.
  With a repo `verifyCommand` it also **runs verification** before `done`: one attach-mode retry with
  the failure in the prompt, then the same draft-`[incomplete]` path (`failure_class: verify-failed`).
- **Repo-owned prompts** — `<repo>/.milo/config.json` (`core/repo-config.ts`, Zod, re-read per job)
  supplies workflow bodies (`.milo/workflows/*.md` with `{{ISSUE_ID}}`-style placeholders), PR labels
  (+ `class:*` from the ticket), `verifyCommand`/`verifyByPath`, `model.byLabel`, `maxTurns`. Prompts are
  header (code) + body (workflow or built-in) + footer (`MILO_RESULT`, code). Retries inject
  `<previous_attempt>` (stored `failure_detail` + `output_tail`); attach prompts get `<pr_diff>`,
  `<review_threads>`, `<failing_checks>` fetched by the pipeline. `milo prompt --issue <ID>` = dry run.
- **Linear agent chat** — drives the agent-session transcript (thought → action → response) with live,
  throttled progress streaming; **revise mode** re-runs a delegated ticket against its existing branch
  instead of opening a second PR.
- **Dependency sequencing** — reads Linear `blockedBy` relations and won't run a blocked issue in
  parallel with its blocker (`wait` holds until the blocker's PR merges; `stacked` bases the dependent's
  worktree off the blocker's branch so the PRs stack).
- **Always-on daemon + Ink TUI**, an **in-daemon scheduler + maintenance** (worktree prune, log
  rotation, disk guard), and an opt-in **HMAC webhook accelerator** layered on top of polling (polling
  stays the system of record).
- **Operate from one place** — a shared CLI view-model client (`packages/cli/src/viewmodel.ts`) backs
  both the plain commands and a k9s-style **multi-view TUI** (tabbed jobs / schedules / system / repos /
  settings; Tab or 1-5 to switch). Drill into a job to watch its **live transcript** — the normalized
  runner event stream, teed to a redacted per-job `<jobId>.events.jsonl` (`core/transcript.ts`) and
  surfaced via the transcript view + `milo watch`. **Re-run / retry / cancel** jobs (cancel threads an
  `AbortSignal` through the runners to `killTree` the process group, then skips the verification gate).
  Repos and settings are **editable in-TUI** (merge-preserving writers). New DB columns `events_log` /
  `runner_log` / `cancel_requested` and terminal state `cancelled` (idempotent migration; schema → 4).

## Architecture

pnpm + TypeScript (ESM) monorepo. Run from source via `tsx` — **no build step needed** for dev.

```
packages/core        Job model + store (jobs.ts), queue (queue.ts), verification gate (verify.ts),
                     pipeline (pipeline.ts: Linear-create + GitHub-attach paths), Linear client
                     (linear.ts, incl. agent-session activities), GitHub client (github.ts), router
                     (router.ts: runner/repo resolution), scheduler (scheduler.ts), maintenance
                     (maintenance.ts), worktree mgr (worktree.ts: create + attach), prompt (prompt.ts),
                     config (config.ts), paths, daemon-state, logger, SQLite (store.ts)
packages/runners     ClaudeRunner (claude.ts), CodexRunner (codex.ts), ConductorRunner (conductor.ts +
                     conductor-api.ts + conductor-git.ts), shared Claude stream-json mapping
                     (stream-json.ts), result parser (result.ts)
packages/daemon      long-lived worker (index.ts → startDaemon): drains the queue + startPolling
                     (poller.ts) + startScheduling (scheduling.ts)
packages/cli         command dispatch (index.ts), run/jobs/status/logs/poll/schedules (run.ts),
                     Ink TUI (ui.tsx), linear-auth (OAuth actor=app), doctor
packages/transports  JobIntent + intentToNewJob (index.ts); pollers: linear.ts (label + delegation),
                     github.ts (label / @milo-mention PRs → attach)
```

Key design points:
- **Job lifecycle** (jobs.ts): `queued → claimed → setting-up → running → (remote-waiting) → verifying → (remediating) →
  reporting → done | discovery-done | retrying | failed | needs-attention | abandoned`. SQLite is the
  source of truth (durable across restarts; `recoverOnStartup` requeues stranded jobs).
- **Queue** (queue.ts): `claimNext` enforces both the concurrency cap and per-entity exclusion; `drain()`
  (CLI standalone) and `runForever()` (daemon) share it.
- **Verification gate** (verify.ts): never trust the agent's self-report — resolve real git/`gh` state;
  if code was written but no PR exists, Milo opens it. No code + genuine discovery → no PR.
  `buildPrBody` writes the description from the branch's commits + diffstat, treating the agent's
  `MILO_RESULT` summary as a bonus — so a missing summary costs detail, not the whole description.
- **A run that didn't finish is not a shipped run**: the runners report `errorDetail` (a terminal
  `is_error` event, or a guard kill before any result) and `runIncomplete` in pipeline.ts wins over
  the exit code — `claude -p` can die mid-response and still exit 0. All four finalize paths (Linear
  create / Linear revise / GitHub attach / scheduled prompt) then preserve the work but land the job
  in `needs-attention` with `verified_outcome=incomplete`, never `done`. In create mode the PR is
  opened as a **draft** titled `[incomplete] …`; in attach mode (someone else's PR) the warning goes
  in the comment instead.
- **Runner injection**: `core` stays runner-agnostic — `makeProcessJob({ runner })` takes the runner as a
  function, so `core` never imports `@milo/runners` (no cycle). CLI/daemon inject `runClaude`/`runCodex`.
- **Daemon + CLI share the SQLite DB** across processes (WAL + `busy_timeout=5000`). The TUI/CLI read it
  directly; `milo <ID>` defers to the daemon when it's running (enqueue-only).

## Runtime layout

`MILO_HOME` (env `MILO_HOME` > `~/.milo`) holds `config.json`, `milo.db`, `logs/`, `daemon.pid`, and
`daemon.lock` (the daemon singleton lock).
Worktrees live under `config.worktreeBase` (default `$MILO_HOME/worktrees`), relocatable separately.
Linear OAuth tokens currently live in `config.json` (moving to a `secrets/` file is deferred).
`config.concurrency` (default 3) caps simultaneous jobs.

## Setup

- **Linear agent**: Milo registers as a Linear app user via OAuth (`actor=app`, scopes
  read/write/app:assignable/app:mentionable; loopback redirect). Run `milo linear-auth` (or `milo init`)
  to (re)register; the client id/secret + token live in `config.json`. *Note: a Linear app user can't be
  a normal issue `assignee` — the reliable hand-offs are the **`milo` label** and **agent-session
  delegation**.*
- **Repos**: `milo add-repo` (or `milo init`) wires a git repo into `config.json` and maps its Linear
  team key(s). A repo opts into GitHub PR polling by setting `githubRepo: "owner/name"`.
- **Testing**: keep a throwaway sandbox repo + matching Linear team to exercise the full
  create → verify → PR loop before pointing Milo at real work.
- **Public repos & trust**: GitHub `@milo` triggering is gated by `trust.githubActors` (empty = no
  gate). On a **public** repo, leave `githubRepo` unset *or* set an explicit `trust.githubActors`
  allowlist — otherwise anyone could `@milo` a PR and trigger a local run (which would execute the PR's
  setup scripts). Polling is opt-in per repo precisely so the attach surface stays intentional.

## Commands

```bash
milo <ID> [<ID>...]   # enqueue issues (daemon runs them, else inline). e.g. milo ENG-123
milo poll             # one-shot Linear+GitHub poll → enqueue any new work
milo schedules [--json] # list scheduled automations (next/last run)
milo prompt <repo>:<name> # run an in-repo scheduled prompt now (from <repo>/.milo/schedules.json)
milo jobs [--json]    # list jobs (filters: --state <s> --repo <r> --search <q>)
milo job <jobId>      # full detail for one job (events, deps, PR, failure)
milo watch <ID|jobId> # stream a job's live transcript (replay + tail); --json = raw JSONL
milo rerun <ID|jobId> # re-run a job from scratch; retry = re-queue a failed one in place
milo cancel <ID|jobId> # cancel a queued/in-flight job (kills the runner)
milo status [--json]  # daemon liveness + queue counts
milo logs <ID>        # latest RAW runner log for an issue (watch = normalized transcript)
milo daemon           # always-on worker: queue + pollers + scheduler (or launchd: scripts/install-launchd.sh)
milo restart [--force] # restart the daemon (picks up new code; launchd-aware). milo stop = stop it

milo                  # interactive Ink TUI (bare); milo ui is the same. Tab/1-5 switch views;
                      #   ⏎ detail, t transcript, r/R/x rerun/retry/cancel, p poll, / search, f filter
milo doctor [--json]  # environment checks (also the TUI System view: key 3 → d)
milo init             # guided onboarding: env check → paths → Linear → opt-ins → first repo → doctor
milo linear-auth      # (re)register the Linear agent
milo add-repo [path]  # wire a git repo into config.json (infers details, maps Linear teams via TUI)
milo repos [--json]   # list configured repos (TUI Repos view: key 4); milo remove-repo <name>
```
`milo` goes on PATH via a symlink `~/.local/bin/milo` → `bin/milo.mjs` (run through `tsx`).

## Dev workflow

```bash
pnpm install
pnpm typecheck        # tsc -p tsconfig.json --noEmit (root tsconfig has the @milo/* path map)
pnpm test             # node --test via tsx; queue + TUI + core/runner tests
```
- **Testing the TUI headlessly**: `ink-testing-library` (`packages/cli/test/ui.test.tsx`) renders `App`
  with an in-memory store (temp `MILO_HOME`) and asserts on `lastFrame()` — no TTY needed.
- **Live end-to-end**: create an issue in a sandbox Linear team, run `milo <ID>`, watch via `milo jobs`
  / the TUI; merge the PR and confirm Linear auto-closes (the GitHub↔Linear integration closes on a
  `Closes <ID>` line in the PR body).

## Gotchas / learnings

- **JSX runtime**: `tsx`/esbuild uses the **classic** transform at runtime (`React.createElement`), even
  though `tsc` honored `jsx: react-jsx`. So `tsconfig` is `jsx: "react"` and `.tsx` files **must
  `import React from "react"`**. (A non-TTY smoke test won't catch this — the TUI's JSX only runs under a TTY.)
- **pnpm strict deps**: a package's tests can only import its own deps. The CLI test uses `core`'s
  `openDatabase` (not raw `better-sqlite3`).
- **Daemon vs CLI**: only one processes the queue. CLI skips `recoverOnStartup` and inline-drain when the
  daemon is up (don't clobber the daemon's in-flight jobs).
- **Coexist with other tools**: Milo uses its own home (`~/.milo`), launchd label (`com.milo.daemon`),
  and port (webhook server **opt-in** on `127.0.0.1:3457`; Funnel :8443). `scripts/setup-funnel.sh`
  touches ONLY the :8443 mapping — never `tailscale funnel reset` (it would wipe any other tool's
  Funnel mappings, e.g. one on :443).
- **Webhooks are an accelerator, not the source of truth**: `webhook.enabled` defaults false (daemon
  binds no port). When on, a signed+allowlisted event enqueues via the same identity key as the poller,
  so a webhook + a poll for the same work collapse to one job. Sigs verify over the **raw** body bytes.
- **Lease/heartbeat invariant**: a job heartbeats (30s) for its WHOLE active lifecycle (pipeline wraps
  `processJob` in `withHeartbeat`), not just during the runner. So an expired lease reliably means the
  worker died — the watchdog can requeue it without risking a double-run of a healthy job.
- **Circuit breaker** keys on `repo.name` in `repo_health`. Only `transient-infra` failures count;
  any success calls `recordRepoSuccess` to reset. `repoHealth()` lazily flips `open→half-open` once
  the cooldown elapses, so the next job is the probe.
- Disk can be tight on small machines — worktrees always tear down.
- **A parked remote job holds the entity lock but NOT a local slot.** `SLOT_STATES` vs
  `ENTITY_LOCK_STATES` in `jobs.ts` is the split; `remote-waiting` is in the latter only. A conductor
  run dispatches, parks, and RETURNS from `processJob` (the queue cap is in-process `inFlight`, so
  returning is what frees the slot); the daemon's remote tracker resumes it under its own
  `conductor.concurrency`. Consequences that bite if forgotten: `willQueue` must exclude parked jobs,
  the lease watchdog must ignore them (liveness is `remote_polled_at` + `reclaimStalledRemote`),
  `recoverOnStartup` must leave them parked, a cancel-requested parked job must stay claimable, and a
  failed tracker tick must use `retryRemoteTracking` (keeps the session) rather than `scheduleRetry`
  (clears it → duplicate workspace).
- **Conductor is remote — the contract is a BRANCH, not a PR.** A Conductor session runs in a cloud
  workspace Milo cannot read (no diff/git/file endpoints in the API). So the prompt dictates the branch
  and **forbids `gh pr create`**; after the session ends the runner fetches + hard-resets the local
  worktree onto `origin/<branch>`, and the ordinary gate opens the PR. `verify.ts` is untouched. Don't
  "fix" this by asking the agent for the PR URL — that reintroduces duplicate-PR and auth hazards.
  Conductor prefixes its own workspace branch (`conductor/<name>`), so the branch must be dictated,
  never inferred. Remote jobs create the worktree with `skipSetup` (it's only the git/gh cwd).
- **Conductor `idle` lies until you've seen `working`.** A queued prompt reports `idle` until its turn
  starts, so the "have I seen working?" latch is correctness state and is persisted on the job
  (`remote_saw_working`) — otherwise a daemon restart mid-run reads the between-turns `idle` as done.
  `recoverOnStartup` re-dispatches remote jobs too, which must mean **reattach**, not "second workspace":
  hence the `remote_*` columns, persisted *before* the prompt is sent.
- **Org Conductor API keys need `projectId`.** `repositoryUrl` is rejected unless the repo has been
  added to the org's Cloud computer in Conductor's settings. Also: send a real `User-Agent` — their
  proxy 403s default client signatures, which looks exactly like a bad API key.
- **A Conductor resume must replay the WHOLE transcript**, not just what's past the saved cursor:
  `output` starts empty on every invocation, so draining from the cursor rebuilds nothing, and a
  second resume (the first already consumed the messages) would finalize on an empty output and lose
  the agent's `MILO_RESULT` entirely. The replay is silent — `replaying` mutes emit/echo/log/persist
  so it doesn't repost the run's narration to Linear or rewind the durable cursor.
- **`MILO_RESULT` parsing is forgiving on purpose** (result.ts): a clean run's final line can arrive
  truncated one character short (missing `}`), so the parser repairs a cut-off tail and then scrapes
  fields by regex before giving up. Losing the summary silently is worse than a slightly wrong one —
  it used to degrade a 450-char summary to `""` with nothing logged. Failures set `parseNote`, which
  the pipeline logs.
- **The verify step must stay async.** `runVerifyCommand` uses `spawn` (detached, own process group),
  never `spawnSync`: a 20-minute `spawnSync` would block the event loop, stop the 30s heartbeat, and the
  lease watchdog would requeue a healthy job mid-verify. Keep it that way for anything long-running.
- **A workflow file replaces the whole body, rules included.** Only the header blocks and the
  `## Final output` footer are code-owned; if a repo's workflow forgets "run autonomously / never leave
  code without a PR", the agent won't be told. The gate still enforces the PR invariant mechanically.
- **Codex git sandbox**: under `-s workspace-write`, Codex commits via an alternate
  `GIT_OBJECT_DIRECTORY` (it can't touch the real `.git`), so the working tree is left dirty with no
  branch commit. That's fine — **the verification gate** sees the dirty tree and commits/pushes/opens the
  PR itself. Don't "fix" Codex's git; the gate is the backstop.
- **GitHub polling is opt-in**: only repos with `githubRepo: "owner/name"` in config are polled (keeps
  Milo off other tools' shared clones, and keeps the attach surface intentional). `@milo`-mention
  re-triggers via a content hash carrying the comment timestamp; a `milo` label triggers once. Only PR
  **comments** count as mentions — `@milo` text in a PR *body* never triggers.
- **Dependency gate**: `claimNext` adds `entity_id NOT IN (SELECT dependent_entity_id FROM
  job_dependencies WHERE resolved=0)` — pure SQL, so the async half (Linear/GitHub calls) lives in
  `dependencies.ts` and runs from the poller (`syncDependencies` after each Linear ingest) + a
  fire-and-forget queue `onTick` reconciler. The CLI inline path awaits a real reconcile each
  `drain()` iteration (so a *stacked* dependent runs in the same invocation once its blocker finishes);
  a *wait* dependent stays queued across the merge and is picked up by a later poll/daemon. Discovery
  only records an edge when the blocker has its own job (else parallel fallback) and skips edges that
  would form a cycle. Stacked base-off rides the existing `createWorktree(..., baseOverride)`.
- **Scheduler**: in-daemon croner (`startScheduling`). A built-in 6h `maintenance` schedule is injected
  unless config defines one. `milo schedules` reads cron next-runs + `schedule_runs` last-runs across
  processes (the live `Scheduler` lives only in the daemon). **In-repo prompt schedules** come from each
  repo's `.milo/schedules.json` via `discoverRepoSchedules`; `effectiveSchedules` = maintenance +
  `config.schedules` + discovered. `startScheduling` returns `{stop, reload}`; the poller calls `reload`
  on its loop (`onPollSchedules`) so edits land without a restart (signature-gated re-arm via
  `Scheduler.reload`). Prompt-schedule names are namespaced `<repo>:<name>` (unique croner name);
  the job's `entityId` is `prompt-<slug>` (stable → per-entity serialization) while the worktree/branch
  key adds the job-id suffix (fresh PR each fire).

## Conventions

- Match the existing code's style; keep `core` free of runner/transport imports (inject instead).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Open a PR for non-trivial changes rather than committing straight to the default branch.
