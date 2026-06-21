<p align="center">
  <img src="assets/milo.png" alt="Milo" width="160" height="160">
</p>

<h1 align="center">Milo</h1>

<p align="center">
  <em>A locally-running autonomous coding agent that reliably ships real PRs.</em>
</p>

---

Hand Milo a Linear ticket, an `@milo` mention on a GitHub PR, a CLI command, or a schedule, and it works
the task end-to-end **on your machine** — worktree → implement → verify → PR → update Linear/GitHub —
using your **Claude or Codex subscription**.

## Why Milo exists

Running local agents that respond to events and schedules was flaky. If they sucessfully started they may not finish. And if they finish, they may not create a PR requiring a manual nudge for the agent to continue. Milo tries to minmize these issues.

- **Real work needs a real machine.** Native iOS/Android builds need actual simulators and emulators;
  backend changes need Postgres, Redis, Docker, and open ports; integration tests need the whole stack
  wired together. A cloud sandbox cannot always cover all of these scenarios and can be expensive. Milo runs locally, where your toolchain already works.
- **Reliability over cleverness.** An agent that occasionally drops a ticket or forgets to open a PR isn't usable unattended. Milo is built around two hard guarantees,
  a durable SQLite queue, retries with backoff, a per-repo circuit breaker, and a lease watchdog that
  requeues work whose worker died. Nothing silently vanishes.
- **Your subscription, not API billing.** Milo uses your existing Claude or Codex subscription (as long as that is still an option).
- **Meets work where it already lives.** A `milo` label or agent delegation in Linear, an `@milo` on a
  GitHub PR, the `milo <ID>` CLI, or a cron schedule, all using the same pipeline.

## The two guarantees

1. **Never silently fail to start.** Polling is the system of record; webhooks only accelerate it. A
   dropped webhook costs one poll interval, never a lost ticket.
2. **Never leave written code without a PR.** A verification gate checks real git/`gh` state — not the
   agent's self-report — and opens the PR itself if the agent wrote code but didn't. Discovery-only
   tasks correctly produce no PR.

See **[docs/reliability.md](./docs/reliability.md)**.

---

## What it does

```
Linear (label / delegation)  ┐
GitHub (label / @milo)       ├─► one durable SQLite queue ─► worktree ─► runner (Claude/Codex)
CLI (milo ENG-123)           │                                            ─► verify ─► PR ─► report back
Schedule (cron)              ┘
```

- **Assign work four ways** — a `milo` label or agent delegation in Linear, a `milo` label / `@milo`
  comment on a GitHub PR, the `milo <ID>` CLI, or a cron schedule.
- **Isolated execution** — each job runs in its own git worktree, with per-repo setup and teardown.
- **Two runners** — Claude Code (default) or Codex, selected per-issue/label/repo, on your subscription.
- **Verification gate** — Milo checks real git/`gh` state, not the agent's word, and opens the PR itself
  if code was written but no PR exists.
- **Linear agent chat** — drives the agent-session transcript (thought → action → response) and moves
  the ticket to *In Review*, streaming live progress as it works.
- **Reliability core** — durable queue, bounded concurrency, per-entity serialization, retries with
  backoff, a per-repo circuit breaker, and a lease watchdog that requeues jobs whose worker died.
- **Always-on daemon + Ink TUI** — a launchd-managed worker and a Claude-Code-style terminal UI.
- **In-daemon scheduler + maintenance** — croner schedules plus built-in worktree prune / log rotation /
  disk guard.
- **Webhook accelerator (opt-in)** — HMAC-verified Linear/GitHub webhooks with an actor allowlist, on
  top of polling.

## Feature matrix

| Area | What ships | Docs |
|------|------------|------|
| Triggers | Linear label + delegation; GitHub label + `@milo`; CLI; schedule | [triggers](./docs/triggers.md) |
| Execution | Per-job git worktree, setup/teardown, create + attach modes | [job lifecycle](./docs/job-lifecycle.md) |
| Runners | ClaudeRunner + CodexRunner, model chains, `MILO_RESULT` protocol | [runners](./docs/runners.md) |
| Integrity | Verification gate (auto-PR), ground-truth checks | [reliability](./docs/reliability.md) |
| Resilience | Durable SQLite queue, retries/backoff, circuit breaker, lease watchdog | [reliability](./docs/reliability.md) |
| Surfaces | CLI commands + live Ink TUI | [cli](./docs/cli.md) |
| Automation | In-daemon croner scheduler + maintenance | [scheduling](./docs/scheduling.md) |
| Latency | Opt-in HMAC webhook accelerator + trust model | [webhooks](./docs/webhooks.md) |
| State | SQLite ledger (jobs, events, inbound, repo health, schedules) | [database](./docs/database.md) |

---

## Quickstart

```bash
# 1. clone + install
git clone https://github.com/your-org/milo && cd milo
pnpm install && pnpm typecheck && pnpm test

# 2. put `milo` on PATH
ln -sf "$(pwd)/bin/milo.mjs" ~/.local/bin/milo

# 3. guided setup: environment check → Linear → first repo (writes ~/.milo/config.json)
milo init

# 4. run something
milo ENG-123      # enqueue a Linear issue (daemon runs it, else inline)
milo              # live TUI
```

Prefer doing it by hand? `milo init` is just glue — you can still write `~/.milo/config.json` yourself
per [docs/configuration.md](./docs/configuration.md), run `milo linear-auth`, and `milo add-repo`. A
bare `milo` with no config offers to run init for you.

Full instructions — prerequisites, launchd, the webhook accelerator, the sandbox — are in
**[docs/installation.md](./docs/installation.md)**.

## Commands

```bash
milo <ID> [<ID>...]      # enqueue Linear issues (e.g. milo ENG-123)
milo                     # interactive Ink TUI (same as `milo ui`)
milo init                # guided setup: env check, paths, Linear, first repo
milo poll                # one-shot Linear+GitHub poll → enqueue new work
milo schedules [--json]  # list scheduled automations (next/last run)
milo jobs [--json]       # list jobs and their state
milo status [--json]     # daemon liveness + queue counts
milo logs <ID>           # latest runner log for an issue
milo daemon              # always-on worker (queue + pollers + scheduler + webhooks)
milo restart [--force]   # restart the daemon (launchd-aware); `milo stop` stops it
milo doctor [--json]     # environment checks
milo linear-auth         # (re)register the Linear agent
```

Every command and flag, plus the TUI panels and keybindings, are documented in
**[docs/cli.md](./docs/cli.md)**.

---

## Architecture at a glance

A pnpm + TypeScript (ESM) monorepo that runs from source via `tsx` — **no build step** for dev.

```
packages/core         job model + SQLite store, queue, verification gate, pipeline (Linear-create +
                      GitHub-attach), Linear & GitHub clients, router, scheduler, maintenance,
                      worktree mgr, prompt, config, webhook verify, paths, logger
packages/runners      ClaudeRunner + CodexRunner + run guards + MILO_RESULT parser
packages/transports   JobIntent + pollers (Linear label/delegation, GitHub label/@milo) + webhook normalizers
packages/daemon       long-lived worker: queue drain + pollers + scheduler + lease watchdog + webhook server
packages/cli          command dispatch, run/jobs/status/logs/poll/schedules, Ink TUI, linear-auth, doctor
```

`core` never imports runners/transports — they're injected — so there's no cycle. Runtime state lives
under `$MILO_HOME` (default `~/.milo`): `config.json`, `milo.db`, `logs/`, `daemon.pid`; worktrees under
a separately configurable `worktreeBase`. Details in **[docs/architecture.md](./docs/architecture.md)**.

## Develop

```bash
pnpm install
pnpm typecheck   # tsc -p tsconfig.json --noEmit
pnpm test        # node --test via tsx (queue, TUI, router, scheduler, maintenance, webhooks, breaker, watchdog, guards)
./bin/milo.mjs doctor
```

Run always-on with `bash scripts/install-launchd.sh`; expose the webhook accelerator with
`bash scripts/setup-funnel.sh`. Contributor guide, status, and gotchas: **[CLAUDE.md](./CLAUDE.md)**.

## Documentation

Full reference docs are in **[`docs/`](./docs/README.md)** — installation, configuration, CLI/TUI,
architecture, triggers, job lifecycle, runners, reliability, scheduling, webhooks, the database schema,
and operations.
