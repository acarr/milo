# Architecture

Milo is a **pnpm + TypeScript (ESM) monorepo**. In development everything runs from source via `tsx` —
**no build step**. There is an esbuild bundle path (`scripts/build.ts`) for distribution, but day-to-day
dev and the launchd daemon both run TypeScript directly.

```
packages/core        domain logic, runtime-agnostic (no runner/transport imports)
packages/runners     ClaudeRunner + CodexRunner + result parser
packages/transports  JobIntent shape + Linear/GitHub pollers + webhook normalizers
packages/daemon      the long-lived worker (queue + pollers + scheduler + watchdog + webhook server)
packages/cli         command dispatch, run/jobs/status/logs/poll/schedules, Ink TUI, doctor, linear-auth
```

Path aliases (`@milo/core`, `@milo/runners`, `@milo/transports`, `@milo/daemon`) are wired in
`tsconfig.base.json`; `.npmrc` sets `link-workspace-packages=true`.

---

## Dependency direction

```
            ┌─────────────┐
            │     cli     │
            └──────┬──────┘
                   │ injects runners
            ┌──────▼──────┐        ┌──────────────┐
            │   daemon    │───────►│  transports  │
            └──────┬──────┘        └──────┬───────┘
                   │ injects runners      │
            ┌──────▼──────┐               │
            │   runners   │               │
            └──────┬──────┘               │
                   │                      │
            ┌──────▼──────────────────────▼──┐
            │             core               │
            │  (imports nothing above it)    │
            └────────────────────────────────┘
```

**`core` never imports `@milo/runners` or `@milo/transports`.** The pipeline takes the runner as an
injected function — `makeProcessJob({ runner })` — so there's no cycle. The CLI and daemon are the only
places that wire `runClaude` / `runCodex` into the pipeline. This keeps `core` testable in isolation
and runner-agnostic.

---

## `packages/core`

| File | Responsibility |
|------|----------------|
| `config.ts` | Zod config schema + `loadConfig` + `resolveRepo`. |
| `store.ts` | SQLite layer (`better-sqlite3`, WAL, `busy_timeout=5000`); creates all tables. |
| `jobs.ts` | Job model, `JobStore`, state machine, `claimNext`, retry/backoff, leases, circuit breaker, `reclaimExpiredLeases`. |
| `queue.ts` | `JobQueue`: bounded concurrency + per-entity serialization; `drain()` (CLI) and `runForever()` (daemon). |
| `pipeline.ts` | `makeProcessJob`: the full per-job pipeline (Linear-create + GitHub-attach paths), state transitions, heartbeat, remediation. |
| `verify.ts` | The verification gate: `resolveGroundTruth`, `ensurePr`, `ensurePushed`. |
| `linear.ts` | Linear GraphQL client incl. agent-session activities; OAuth refresh. |
| `github.ts` | GitHub client over the `gh` CLI (PR view/list, comments, comment post). |
| `router.ts` | Runner / repo / model resolution. |
| `prompt.ts` | `buildPrompt` (create) + `buildAttachPrompt` (attach). |
| `worktree.ts` | `createWorktree`, `attachWorktree`, `teardownWorktree`; branch naming. |
| `scheduler.ts` | `Scheduler` (croner wrapper) + the default maintenance schedule. |
| `maintenance.ts` | `pruneWorktrees`, `rotateLogs`, `diskGuard`, `runMaintenance`. |
| `webhooks.ts` | HMAC signature verification (Linear/GitHub) + timestamp freshness. |
| `paths.ts` | `miloHome`, `configPath`, `dbPath`, `logsDir`, `secretsDir`, `worktreeBase`. |
| `daemon-state.ts` | `daemon.pid` read/write + liveness check; `acquireDaemonLock` singleton guard (exclusive OS lock on `daemon.lock`). |
| `logger.ts` | Pino JSON logger (ISO timestamps; `MILO_LOG_LEVEL`). |

## `packages/runners`

`claude.ts` (`runClaude`), `codex.ts` (`runCodex`), `result.ts` (`parseRunnerResult`). See
[runners.md](./runners.md).

## `packages/transports`

`index.ts` (`JobIntent`, `intentToNewJob`), `linear.ts` (`pollLinear`), `github.ts` (`pollGithub`),
`webhooks.ts` (`normalizeLinearWebhook`, `normalizeGithubWebhook`). See [triggers.md](./triggers.md).

## `packages/daemon`

`index.ts` (`startDaemon`), `poller.ts` (`startPolling` / `pollOnce`), `scheduling.ts`
(`startScheduling`, `effectiveSchedules`), `webhook-server.ts` (`startWebhookServer`). See
[operations.md](./operations.md) and [webhooks.md](./webhooks.md).

## `packages/cli`

`index.ts` (dispatch), `run.ts` (commands), `ui.tsx` (Ink TUI), `doctor.ts`, `linear-auth.ts`. See
[cli.md](./cli.md).

---

## Shared SQLite across processes

The daemon and the CLI/TUI all open the same `milo.db`. Concurrency is safe because the store uses
**WAL** mode and a **5s `busy_timeout`**. The TUI and most CLI commands read the DB directly; only **one**
process drains the queue — `milo <ID>` defers to the daemon when it's running (enqueue-only) and skips
`recoverOnStartup` so it never reclaims the daemon's in-flight jobs.

See [database.md](./database.md) for the full schema and [job-lifecycle.md](./job-lifecycle.md) for the
runtime flow.

---

## Runtime layout

```
$MILO_HOME (default ~/.milo)
  config.json     # configuration
  milo.db         # SQLite ledger (jobs, events, inbound_events, repo_health, schedule_runs, …)
  logs/           # per-run runner logs + daemon.log
  daemon.pid      # { pid, startedAt } — human/CLI-readable record
  daemon.lock     # singleton guard: exclusive OS lock held by the running daemon
  worktrees/      # default worktree base (relocatable via config.worktreeBase)
```
