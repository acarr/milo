# Milo Documentation

Reference docs for Milo, the locally-running autonomous coding agent. Start with the
[root README](../README.md) for the overview and quickstart; the pages below are the deep reference.

## Getting started
- **[Installation & Setup](./installation.md)** — prerequisites, PATH, runtime home, Linear auth,
  launchd, Funnel, the sandbox.
- **[Configuration Reference](./configuration.md)** — every `config.json` field and its default.
- **[CLI & TUI Reference](./cli.md)** — every command, flag, and the interactive TUI.

## How it works
- **[Architecture](./architecture.md)** — the monorepo, package boundaries, dependency direction.
- **[Triggers](./triggers.md)** — how work reaches Milo (Linear, GitHub, CLI, schedule) and dedup.
- **[Job Lifecycle](./job-lifecycle.md)** — the state machine, queue, retries, leases.
- **[Runners](./runners.md)** — Claude & Codex, model selection, the `MILO_RESULT` protocol, the prompt.
- **[Reliability](./reliability.md)** — the two sacred invariants, verification gate, circuit breaker,
  watchdog, idempotency.
- **[Scheduling & Maintenance](./scheduling.md)** — the in-daemon cron scheduler and housekeeping.
- **[Webhooks](./webhooks.md)** — the opt-in latency accelerator + trust model.

## Reference
- **[Database Reference](./database.md)** — the full SQLite schema.
- **[Operations & Troubleshooting](./operations.md)** — running the daemon, logs, common situations.
- **[Remaining Work](./REMAINING-WORK.md)** — the optional/planned backlog.

## For contributors
See **[../CLAUDE.md](../CLAUDE.md)** — the living status, gotchas, and conventions for working on Milo
itself.
