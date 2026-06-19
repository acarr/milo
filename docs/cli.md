# CLI & TUI Reference

`milo` is the single entry point. On PATH via `~/.local/bin/milo` → `bin/milo.mjs`, which runs
`packages/cli/src/index.ts` through `tsx`. Command dispatch lives in `packages/cli/src/index.ts`;
implementations in `run.ts`, `ui.tsx`, `doctor.ts`, and `linear-auth.ts`.

```
milo <ID> [<ID>...]       enqueue Linear issues (daemon runs them, else runs inline)
milo                      interactive Ink TUI (same as `milo ui`)
milo ui                   interactive Ink TUI
milo init                 guided setup: environment check, paths, Linear, first repo
milo poll                 poll Linear + GitHub once and enqueue any new work
milo schedules [--json]   list scheduled automations (next/last run)
milo jobs [--json]        list jobs and their state
milo status [--json]      daemon liveness + queue counts
milo logs <ID>            print the latest runner log for an issue
milo daemon               run the always-on worker (queue + pollers + scheduler + webhooks)
milo restart [--force]    restart the daemon (picks up new code; --force skips graceful drain)
milo stop [--force]       stop the daemon (graceful drain; --force SIGKILLs)
milo doctor [--json]      check the environment is ready
milo linear-auth          (re)register Milo as a Linear agent (OAuth actor=app)
milo --help | -h | help   show usage
```

`--json` is accepted by `jobs`, `status`, `schedules`, `poll`, and `doctor` for machine-readable output.

---

## `milo init [--sandbox]`

Guided onboarding from a fresh install to a green `milo doctor`, with the fewest possible decisions:
infer or default everything; ask only what can't be inferred.

1. **Quiet tool check** — claude/codex/gh/docker only (path checks wait for the final doctor). A
   missing `claude` CLI blocks (with the install link); an unauthenticated `gh` offers to run
   `gh auth login` inline. Nothing else is printed unless there's a problem.
2. **The wizard (Ink)** — six steps:
   - **Welcome** — what Milo is, and Start.
   - **Paths** — where Milo lives (`.milo` [`~/.milo`]) and where it checks out code (`worktrees`
     [`<home>/worktrees`]). Tab completes filesystem paths.
   - **Connect Linear** — instructions to create the Linear OAuth app (callback
     `http://localhost:8989/callback`), paste the client id/secret, then **Authenticate** runs the
     browser approval right in the wizard. Leaving the fields empty and pressing Next skips it
     (`milo linear-auth` works later).
   - **Webhook acceleration** — explanation + enable toggle (default off).
   - **Options** — Codex as default runner (only when `codex` is detected) and auto-merge
     (default off).
   - **Shell setup** — symlink `~/.local/bin/milo` (when `milo` isn't on PATH) and persist a
     non-default `MILO_HOME` to the shell profile. Both default to yes; both idempotent.
3. **Write config** — merge-preserving: an existing config's repos/credentials/settings are never
   overwritten; only gaps are filled. Validated against the schema before the file is touched.
4. **Daemon install** — the launchd always-on daemon is installed unconditionally (it's what makes
   Milo autonomous). Degrades to a notice on failure or off macOS.
5. **Phase B** — add the first repo via the same module as [`milo add-repo`](#milo-add-repo-path),
   looping on "Add another repo?".
6. **Final verify** — re-runs the full doctor and prints the green summary.

A bare `milo` with no config auto-suggests (and in a TTY, starts) `milo init`.

**`--sandbox`** makes the full flow safe to run end-to-end on a machine that already has Milo:
config/db still write to `MILO_HOME` (point it at a temp dir), but the system-level writes — the
daemon install and the shell-profile/symlink changes — are skipped and printed as `(sandbox) would …`.

```bash
MILO_HOME=$(mktemp -d) milo init --sandbox   # disposable, completable, fresh-install run
```

---

## `milo <ID> [<ID>...]`

Enqueue one or more Linear issues. IDs must match `^[A-Z][A-Z0-9]*-\d+$` (e.g. `SBX-5`, `WAZ-12`).

- **Daemon running** → the issue is enqueued and the daemon picks it up; the command returns
  immediately (enqueue-only). It does **not** drain inline, so it never clobbers the daemon's
  in-flight jobs.
- **Daemon not running** → the CLI drains the job(s) **inline**, in-process, honoring
  `config.concurrency`, and prints progress.

Each ID becomes a `cli`-source job with `triggerType: issue.start`.

---

## `milo poll`

Runs **one** Linear + GitHub poll cycle and enqueues any new work, then exits. The same code the
daemon runs on a loop. Useful to force an immediate sweep without webhooks. `--json` prints the
per-source intent/enqueue counts.

---

## `milo schedules [--json]`

Lists configured automations — your `schedules[]` plus the built-in maintenance schedule — with each
one's **next run** (computed from the cron pattern) and **last run** (read from the `schedule_runs`
table, so it works across processes even though the live `Scheduler` only exists inside the daemon).

---

## `milo jobs [--json]`

Lists up to the 100 most recent jobs from the SQLite store: entity, state, runner, age, and PR URL or
failure detail. Reads the DB directly — works whether or not the daemon is running.

---

## `milo status [--json]`

Daemon liveness (from `daemon.pid`, verified with a `kill -0` signal) plus queue counts by state.

---

## `milo logs <ID>`

Prints the most recent runner log for an issue from `$MILO_HOME/logs/`. Each run writes a timestamped
log file; this tails the latest match for the given issue ID.

---

## `milo daemon`

Starts the always-on worker (normally launched by launchd). It:

- acquires the daemon singleton lock (an exclusive OS-level lock on `daemon.lock`) and writes `daemon.pid`,
- recovers stranded jobs on startup (`recoverOnStartup`),
- drains the queue with bounded concurrency,
- runs the Linear + GitHub pollers,
- runs the in-daemon scheduler,
- runs the lease watchdog (every 30s),
- optionally binds the webhook server (if `webhook.enabled`),
- shuts down gracefully on SIGTERM/SIGINT (drains in-flight jobs, releases the lock, clears the PID).

Refuses to start if a daemon is already running: `milo daemon is already running (pid N)`. The guard is
race-free — the lock is held by the OS, so it cannot be won twice and is released automatically if the
daemon dies (even on SIGKILL). See [operations.md](./operations.md) and [job-lifecycle.md](./job-lifecycle.md).

---

## `milo restart [--force]`

Restarts the daemon — the standard way to pick up new code (the daemon runs from source via tsx).

- **launchd-managed** (label `com.milo.daemon` loaded): `launchctl kickstart -k gui/<uid>/com.milo.daemon`.
- **manually run**: SIGTERM the pid in `daemon.pid`, wait for the graceful drain, then re-spawn
  `milo daemon` detached (logs to `$MILO_HOME/logs/daemon.log`).
- **not running**: just starts one (with a note).

Always confirms liveness before returning: a fresh pid recorded in `daemon.pid` and alive, reported as
`daemon running (pid N)`. `--force` skips the graceful drain (SIGKILL) — stranded jobs are requeued by
startup recovery / the lease watchdog.

---

## `milo stop [--force]`

Stops the daemon.

- **launchd-managed**: `launchctl bootout` (a plain SIGTERM would be resurrected by `KeepAlive`).
- **manually run**: SIGTERM and wait for the drain; `--force` SIGKILLs, after which the singleton lock
  auto-releases and stranded work is requeued on the next start.

---

## `milo doctor [--json]`

Validates the environment. Checks (required ✗ blocks; optional ! warns):

1. **config** (required) — load + validate `config.json`; report repos and default runner.
2. **claude** (required) — `which claude` then `claude --version`.
3. **codex** (optional) — `which codex` then `codex --version`.
4. **gh** (required) — `which gh` then `gh auth status`.
5. **docker** (optional) — `which docker` then `docker info`.
6. **disk** (optional) — free space on the `$MILO_HOME` volume; warns under ~5 GiB.
7. **store** (required) — open `milo.db`, check schema version.
8. **worktreeBase** (required) — ensure the worktree base directory is writable.

Prints a colored table (`✓` / `!` / `✗`) or `--json`.

---

## `milo linear-auth`

(Re)registers Milo as a Linear app user via OAuth (`actor=app`; scopes `read`, `write`,
`app:assignable`, `app:mentionable`; redirect `http://localhost:8989/callback`). Opens a browser,
completes the callback, and writes the client id/secret + tokens into `config.json`. Tokens refresh
automatically on a 401.

---

## The TUI (`milo` / `milo ui`)

A Claude-Code-style terminal UI built with **Ink** (`packages/cli/src/ui.tsx`). Bare `milo` (no args)
and `milo ui` both launch it. It reads the SQLite store directly and **refreshes every 1s**.

### Panels

- **Header** — daemon status (`● running` green with pid / `○ stopped` yellow) and a count of jobs by state.
- **Jobs list** — one row per job: entity, colored state, runner, age (`s`/`m`/`h`), and PR URL or
  failure detail. The selected row is highlighted.
- **Detail pane** — for the selected job: entity, state, summary, and the last 8 job events
  (`state_change`, `reclaimed`, `remediation`, …).
- **Scheduled pane** — when schedules exist: name, kind, cron, next run, last run.

### Keybindings

| Key | Action |
|-----|--------|
| `↑` | Select previous job |
| `↓` | Select next job |
| `q` | Quit |

Refresh is automatic (1s tick); there is no manual refresh key.

### Non-TTY fallback

When stdout is not a TTY (CI, piping), the TUI prints a one-shot static dump of the jobs list instead
of trying to render interactively. (Headless render is exercised in tests via `ink-testing-library`.)

> **Implementation note:** `tsx`/esbuild uses the **classic** JSX transform at runtime, so every `.tsx`
> file must `import React from "react"`. This only surfaces under a TTY — a non-TTY smoke test won't
> catch a missing import.
