# Milo — agent/contributor guide

Milo is a **locally-running autonomous coding agent**: assign it a Linear ticket (`milo` label or
agent delegation), `@milo` a GitHub PR, run `milo <ID>`, or schedule it — and it does the work on this
machine — worktree → implement → verify → PR → update Linear/GitHub — using the Claude or Codex
**subscription** (never API billing). It's a reliability-focused local agent that **coexists** with
other tools on the box.

Docs: original design/phase plan `~/.claude/plans/put-together-a-pretty-nifty-steele.md` (annotated
with what shipped); user-facing `README.md`; the full reference set in `docs/` (index at
`docs/README.md` — installation, configuration, cli, architecture, triggers, job-lifecycle, runners,
reliability, scheduling, webhooks, database, operations); remaining optional work `docs/REMAINING-WORK.md`.

## Status (keep this current)

- ✅ **Phase 0** — monorepo scaffold + `milo doctor`
- ✅ **Phase 1** — CLI parity: `milo <ID>` runs an issue end-to-end
- ✅ **Phase 2** — reliability core: durable SQLite queue, **bounded concurrency + per-entity
  serialization**, retry/backoff, crash recovery, **verification gate** (opens the PR itself if the
  agent wrote code but didn't)
- ✅ **Phase 3** — always-on **daemon** (`milo daemon`, launchd) + Claude-Code-style **Ink TUI**
- ✅ **Phase 4** — poll-first triggers (`milo poll` + daemon loops): **Linear** `milo`-label and
  **agent-session delegation** → create jobs; **GitHub** `milo`-label / `@milo`-mention PRs → **attach
  mode**. **CodexRunner** (ChatGPT sub) behind the runner registry; selection `[agent=codex]` >
  `runner:<id>` label > repo > default. Milo now drives the **Linear agent chat** (thought/action/
  response). Verified live on SBX (PRs #5–#7). *Note: app users can't be a normal Linear assignee —
  the `milo` label is the reliable hand-off.*
- ✅ **Phase 5** — in-daemon **scheduler** (croner) from `config.schedules` + built-in **maintenance**
  (worktree prune, log rotation, disk guard). `milo schedules [--json]` + TUI Scheduled panel. Live
  per-minute fire confirmed.
- ✅ **Scheduled prompts (in-repo)** — replace schedule-a-ticket (`kind:"enqueue"` removed) with
  `kind:"prompt"`: a repo's `.milo/schedules.json` defines `{name, cron, runner?, model?, promptFile}`,
  the prompt **always a separate `.md`** under `.milo/` (read fresh each fire). The daemon
  **discovers** these across configured repos and **reloads on the existing poll loop** (no new timer).
  A fire enqueues a `source:"prompt"` job → `processPromptJob` (skips Linear; repo-by-name; fresh
  worktree/branch each run; runner from the schedule) → normal **verification gate** (code → PR with no
  `Closes` line; no code → logged report). `milo prompt <repo>:<name>` runs one on demand. New
  `custom_prompt` column (idempotent migration; schema_version→2). Core: `repo-schedules.ts`,
  `buildFreeformPrompt`, `resolveRepoByName`, `ensurePr({closes?})`.
- ✅ **Phase 6** — webhook accelerator + trust: opt-in daemon HTTP ingress on `127.0.0.1:3457`
  (`/webhooks/{linear,github}`), HMAC verify (Linear-Signature / X-Hub-Signature-256) + replay window,
  **actor allowlist** → normalize → enqueue (same path as polling, which still backstops). Funnel
  :8443→:3457 via `scripts/setup-funnel.sh`. Verified locally (signed→200/enqueued, tampered→401,
  non-allowlisted→403). *Remaining manual step:* run the Funnel script, set `webhook.enabled` +
  `trust.webhookSecrets`, register the webhooks in Linear/GitHub.
- ✅ **Follow-up (done)** — per-repo **circuit breaker** (5 consecutive infra failures → open 30m →
  half-open probe → closed; new jobs `abandoned` with one notice); **lease watchdog** (heartbeat across
  the whole job lifecycle + `reclaimExpiredLeases` on a 30s daemon timer → requeues jobs whose
  processing died without a terminal state, no restart needed).
- ✅ **Follow-up (done)** — **dependency sequencing** (MILO-4): Milo reads Linear `blockedBy` relations
  and won't run a blocked issue in parallel with its blocker. `claimNext` gates on a `job_dependencies`
  table; an async reconciler (`dependencies.ts`) flips edges `resolved`. Two strategies (config
  `dependencies.defaultStrategy`, or a `stacked`/`wait` label): **wait** (default) holds the dependent
  until the blocker's PR merges; **stacked** bases the dependent's worktree off the blocker's head
  branch so the PRs stack. Cycles / untracked / failed blockers fall back to parallel (logged + one
  Linear comment). A single idempotent comment (via `side_effects`) records each sequencing decision.
- ✅ **Follow-up (done)** — **Linear revise mode** (MILO-7), **delegate-first**: after Milo ships a PR
  for a delegated ticket, **replying in its agent-session chat** re-runs against the **existing branch**
  and pushes follow-up commits — never a second PR. The signal is a new user **`Prompt` activity** that
  is the session's latest activity *and* follows a prior agent `Response` (so it's a reply after Milo
  finished, not the opening delegation); `pollLinear` emits an attach intent keyed on the prompt
  activity id (`prompt:<id>`), and the revision instruction is the prompt body. The non-delegate
  equivalents (a `milo`-label issue + `@milo` comment) also work. The pipeline decides create-vs-revise
  authoritatively via `store.lastImplementedForEntity` (prior PR → `processLinearAttachJob` →
  `attachWorktree` + `ensurePushed`), mirroring the GitHub attach flow. No `githubRepo` needed (pushing
  the branch updates the PR). Linear agent content union also has an **`Elicitation`** activity — the
  native "agent asks a question" mechanism, which MILO-8 will use. *Unverified live (0 sessions existed
  to introspect); needs a sandbox delegation→reply test.*
- ✅ **MILO-5** — **live agent-session progress streaming**: runners emit a normalized, runner-agnostic
  event stream (Claude `stream-json`, Codex `--json`); `core`'s `ProgressStreamer` (progress.ts)
  signal-filters, throttles/coalesces (≤1 activity / `progress.minIntervalMs`, bursts → one summary),
  redacts secrets, and backs off on rate limits. Best-effort + gated to agent-session jobs (no comment
  spam for label-only). Global + per-repo `progress` config (`enabled`/`verbosity`/`minIntervalMs`).
- ✅ **MILO-13** — **daemon singleton guard**: `startDaemon` acquires an exclusive OS-level lock
  (`BEGIN EXCLUSIVE` on `$MILO_HOME/daemon.lock`) before touching the DB/ports/polling; a second
  `milo daemon` exits with "already running (pid N)". Race-free (kernel lock, can't be won twice) and
  self-cleaning (the lock dies with its process — SIGKILL leaves no stale lock). Legacy backstop also
  honors a live `daemon.pid` from a pre-lock daemon. Pid file writes are atomic; release only clears a
  pid record it still owns.
- ✅ **MILO-11** — **`milo restart` / `milo stop`**: launchd-aware daemon control (`launchctl
  kickstart -k`/`bootout` when the label is loaded; SIGTERM → drain → detached re-spawn when manual;
  plain start when nothing is running). Confirms liveness (fresh pid) before returning; `--force`
  SIGKILLs. The detached re-spawn runs the daemon as a single process (no wrapper chain to orphan).
- ✅ **MILO-14** — **attach-collision fix**: when a PR branch is checked out in another worktree (the
  dev tree), `attachWorktree` now falls back to a **detached worktree at the PR head** and
  `ensurePushed` pushes by refspec (`HEAD:<branch>`) — Milo can revise a PR without touching the
  developer's checkout. Deterministic worktree failures (`isPermanentWorktreeError`) are classified
  `logic` → straight to `needs-attention`, never `transient-infra` retries, never breaker accounting.
- ✅ **MILO-9** — **dogfooding enabled**: the `milo` repo entry in `~/.milo/config.json` has
  `githubRepo: "acarr/milo"`, so `@milo` PR comments / `milo` labels on milo PRs trigger
  attach mode (verified live — see the ticket).
- ✅ **MILO-2** — **`milo init` onboarding wizard** (revamped after first-use feedback): quiet
  tool-only pre-check (claude blocks, gh offers login; no doctor wall-of-checks — path checks wait
  for the final doctor) → Ink wizard (`packages/cli/src/init/`): ASCII-cat welcome → paths
  (user-facing labels `.milo`/`worktrees`, **Tab path-completion** via `path-complete.ts`) →
  Connect Linear (numbered OAuth-app instructions + **in-wizard Authenticate** button driving
  `runLinearOAuth`, abortable; empty fields + Next = skip) → webhook step (explain + toggle) →
  options (runner/auto-merge) → shell setup (symlink `~/.local/bin/milo` + `MILO_HOME` export,
  default yes; `shell-setup.ts`, idempotent) → merge-preserving config writer (validates before
  writing, friendly errors, persists in-wizard tokens) → **daemon always installed** (launchd,
  graceful degrade) → Phase B repo loop → final doctor. Bare `milo` with no config auto-starts it.
  *Self-test pattern:* headless via `ink-testing-library` (stub `authenticate`/`completePathFn`
  props); live via tmux (`tmux new-session -d "MILO_HOME=$(mktemp -d) bin/milo.mjs init --sandbox"`
  + `send-keys`/`capture-pane` **one key at a time**). **`--sandbox`** skips the launchd install +
  shell-profile/symlink writes (prints `(sandbox) would …`), so the full flow incl. Finish is safe
  on a dev machine.
- ✅ **MILO-15** — **webhook dependency-gate fix** (PR #13): webhook-enqueued Linear jobs now get an
  enqueue-time **dependency hold** (`dependencies.holdMs`, default 60s) and the webhook ingress fires
  its own coalescing `syncDependencies` — closing the race where `blockedBy` issues delegated together
  ran in parallel off `main` (the WAZ-578/579 incident: duplicated work + conflicting migrations).
  Discovery clears holds once blockers are accounted for; untracked-blocker holds survive until the
  sibling webhook lands (delivery order doesn't matter); Linear outages expire into parallel.
- ✅ **MILO-16** — **runner run guards** (PR #14): runners spawn `detached` (own process group) and are
  watched by three guards in `runners/guards.ts` — **result-exit grace** (~30s; the live 2026-06-02
  failure: `claude -p` finished but MCP-server children kept it alive 4.5h), **inactivity** (~20 min),
  **wall-clock cap** (~3h). A guard kill takes out the whole tree; a post-result kill still counts as
  success (the verification gate re-derives ground truth regardless). Closes REMAINING-WORK B2.
- ⏳ **Follow-up (remaining)** — clarifying-questions/await-input loop in Linear (MILO-8); focused-runner
  remediation cycle before the direct-PR fallback; cross-repo (fork) attach support (MILO-10);
  sub-10s agent-session ack via webhooks; merge the SBX test PRs #5–#7; stream progress to GitHub PR
  comments (attach mode); async teardown/setup scripts (MILO-17); disk pre-flight gate (MILO-18);
  reporting resilience (MILO-19); duplicate-delegation supersede (MILO-20); fix the hanging
  `init-config.test.ts` (blocks `pnpm test`)

## Architecture

pnpm + TypeScript (ESM) monorepo. Run from source via `tsx` — **no build step needed** for dev.

```
packages/core        Job model + store (jobs.ts), queue (queue.ts), verification gate (verify.ts),
                     pipeline (pipeline.ts: Linear-create + GitHub-attach paths), Linear client
                     (linear.ts, incl. agent-session activities), GitHub client (github.ts), router
                     (router.ts: runner/repo resolution), scheduler (scheduler.ts), maintenance
                     (maintenance.ts), worktree mgr (worktree.ts: create + attach), prompt (prompt.ts),
                     config (config.ts), paths, daemon-state, logger, SQLite (store.ts)
packages/runners     ClaudeRunner (claude.ts), CodexRunner (codex.ts), result parser (result.ts)
packages/daemon      long-lived worker (index.ts → startDaemon): drains the queue + startPolling
                     (poller.ts) + startScheduling (scheduling.ts)
packages/cli         command dispatch (index.ts), run/jobs/status/logs/poll/schedules (run.ts),
                     Ink TUI (ui.tsx), linear-auth (OAuth actor=app), doctor
packages/transports  JobIntent + intentToNewJob (index.ts); pollers: linear.ts (label + delegation),
                     github.ts (label / @milo-mention PRs → attach)
```

Key design points:
- **Job lifecycle** (jobs.ts): `queued → claimed → setting-up → running → verifying → (remediating) →
  reporting → done | discovery-done | retrying | failed | needs-attention | abandoned`. SQLite is the
  source of truth (durable across restarts; `recoverOnStartup` requeues stranded jobs).
- **Queue** (queue.ts): `claimNext` enforces both the concurrency cap and per-entity exclusion; `drain()`
  (CLI standalone) and `runForever()` (daemon) share it.
- **Verification gate** (verify.ts): never trust the agent's self-report — resolve real git/`gh` state;
  if code was written but no PR exists, Milo opens it. No code + genuine discovery → no PR.
- **Runner injection**: `core` stays runner-agnostic — `makeProcessJob({ runner })` takes the runner as a
  function, so `core` never imports `@milo/runners` (no cycle). CLI/daemon inject `runClaude`.
- **Daemon + CLI share the SQLite DB** across processes (WAL + `busy_timeout=5000`). The TUI/CLI read it
  directly; `milo <ID>` defers to the daemon when it's running (enqueue-only).

## Runtime layout

`MILO_HOME` (env `MILO_HOME` > `~/.milo`) holds `config.json`, `milo.db`, `logs/`, `daemon.pid`, and
`daemon.lock` (the daemon singleton lock).
Worktrees live under `config.worktreeBase` (default `$MILO_HOME/worktrees`), relocatable separately.
`config.json` is the **legacy milo.sh format, extended** (v1 parses; new fields optional). Linear OAuth
tokens currently live in `config.json` (moving to a `secrets/` file is deferred). `config.concurrency`
(default 3) caps simultaneous jobs.

## The setup that exists

- **Linear agent**: Milo is a registered app user ("Milo", `@oauthapp.linear.app`) in your Linear
  workspace. Re-auth with `milo linear-auth` (OAuth `actor=app`, scopes read/write/app:assignable/
  app:mentionable; redirect `localhost:8989`). Client id/secret + token in `config.json`.
- **Sandbox**: repo `your-org/milo-sandbox` at `~/development/milo-sandbox` (a Hono task API),
  Linear team **Milo Sandbox**, key **SBX**. Use it for live tests (create a ticket, `milo SBX-N`).
- **Dogfooding (MILO-9)**: the `milo` repo itself is wired for GitHub attach mode
  (`githubRepo: "acarr/milo"` in config) — a `@milo <feedback>` comment or a `milo` label on
  an open `acarr/milo` PR makes Milo revise that PR. `trust.githubActors` is empty (no gate).

## Commands

```bash
milo <ID> [<ID>...]   # enqueue issues (daemon runs them, else inline). e.g. milo SBX-5
milo poll             # one-shot Linear+GitHub poll → enqueue any new work
milo schedules [--json] # list scheduled automations (next/last run)
milo prompt <name>    # run a scheduled prompt now (from <repo>/.milo/schedules.json). e.g. milo prompt milo:nightly-tidy
milo jobs [--json]    # list jobs from the store
milo status [--json]  # daemon liveness + queue counts
milo logs <ID>        # latest runner log for an issue
milo daemon           # always-on worker: queue + pollers + scheduler (or launchd: scripts/install-launchd.sh)
milo restart [--force] # restart the daemon (picks up new code; launchd-aware). milo stop = stop it

milo                  # interactive Ink TUI (bare); milo ui is the same
milo doctor [--json]  # environment checks
milo init             # guided onboarding: env check → paths → Linear → opt-ins → first repo → doctor
milo linear-auth      # (re)register the Linear agent
milo add-repo [path]  # wire a git repo into config.json (infers details, maps Linear teams via TUI)
```
`milo` is on PATH via `~/.local/bin/milo` → `bin/milo.mjs` (tsx). The old `~/.zshrc` alias was repointed;
the bash `milo.sh`/`teardown.sh` are retired.

## Dev workflow

```bash
pnpm install
pnpm typecheck        # tsc -p tsconfig.json --noEmit (root tsconfig has the @milo/* path map)
pnpm test             # node --test via tsx; queue + TUI tests
```
- **Testing the TUI headlessly**: `ink-testing-library` (`packages/cli/test/ui.test.tsx`) renders `App`
  with an in-memory store (temp `MILO_HOME`) and asserts on `lastFrame()` — no TTY needed.
- Live end-to-end: create an SBX ticket, run `milo SBX-N`, watch via `milo jobs` / the TUI; merge the PR
  and confirm Linear auto-closes (the GitHub↔Linear integration closes on `Closes SBX-N`).

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
- **Linear app users can't be a normal `assignee`** — `issueUpdate(assigneeId: <app>)` returns
  `success:true` but the assignee stays null. Triggers are the **`milo` label** and **agent-session
  delegation** (`agentSessionCreateOnIssue`). Posting any `agentActivity` (e.g. a `thought`) **revives a
  `stale` session to `active`**; a `response` activity completes it.
- **Codex git sandbox**: under `-s workspace-write`, Codex commits via an alternate
  `GIT_OBJECT_DIRECTORY` (it can't touch the real `.git`), so the working tree is left dirty with no
  branch commit. That's fine — **the verification gate** sees the dirty tree and commits/pushes/opens the
  PR itself. Don't "fix" Codex's git; the gate is the backstop (proven on SBX-7 → PR #7).
- **GitHub polling is opt-in**: only repos with `githubRepo: "owner/name"` in config are polled (keeps
  Milo off other tools' shared clones). `@milo`-mention re-triggers via a content hash carrying the comment
  timestamp; a `milo` label triggers once. The `milo` and `milo-sandbox` repos are both wired. Only PR
  **comments** count as mentions — `@milo` text in a PR *body* never triggers.
- **Dependency gate** (MILO-4): `claimNext` adds `entity_id NOT IN (SELECT dependent_entity_id FROM
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
- Bootstrap phases were committed straight to `main`; once stable, prefer Milo dogfooding its own PRs.
