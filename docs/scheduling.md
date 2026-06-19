# Scheduling & Maintenance

Milo runs cron automations **inside the daemon** — no external cron, no extra process. The scheduler is
a thin wrapper over [croner](https://github.com/hexagon/croner)
(`packages/core/src/scheduler.ts`); the daemon wiring is in `packages/daemon/src/scheduling.ts`.

There are two kinds of schedule:

- **`prompt`** — run a free-form prompt on a repo (the main use case). Defined **in the repo** under
  `.milo/schedules.json`, so a repo's automation is versioned and reviewed alongside its code.
- **`maintenance`** — the built-in housekeeping routine (below). Injected automatically.

---

## Scheduled prompts (defined in the repo)

Drop a `.milo/schedules.json` into any repo Milo is already configured for (i.e. it's in
`config.repositories[]`). Each entry points at a prompt `.md` that lives next to it under `.milo/`:

`<repo>/.milo/schedules.json`
```json
[
  { "name": "nightly-tidy", "cron": "0 22 * * *", "runner": "codex", "promptFile": "nightly-tidy.md", "enabled": true }
]
```

`<repo>/.milo/nightly-tidy.md`
```md
Review TODO/FIXME comments added in the last day and open a PR that resolves the safe ones.
If nothing is safe to change, just summarize what you found.
```

Fields: `name`, a standard `cron`, an optional `runner` (`claude` | `codex`; defaults to the repo's
`defaultRunner`, then the global default), an optional `model`, the required `promptFile`, and
`enabled`. The **prompt is always a separate `.md`** referenced by `promptFile` — never inline JSON.
`promptFile` resolves relative to `<repo>/.milo/` (then the repo root; an absolute path is used as-is)
and is read **fresh on each fire**, so editing the `.md` needs no reload.

When a `prompt` schedule fires, Milo enqueues a `source: "prompt"` job that:
1. creates a **fresh worktree** off the repo's base branch (a new branch each fire);
2. runs the prompt with the chosen runner;
3. goes through the normal **verification gate** — if the run changed code, Milo opens a **PR**; if it
   didn't (a report/analysis), it records a discovery result. The last-run timestamp is folded into the
   content hash, so each fire is a distinct, dedup-safe job.

Output lands in the runner log + the job's `summary`/`pr_url` (`milo logs <name>`, `milo jobs`) — there
is no ticket/PR thread to comment on. There is **no auto-close `Closes` line** (no ticket).

### Discovery & reload

The daemon discovers `.milo/schedules.json` across every configured repo and re-discovers on its
existing **poll loop** (same cadence as Linear polling), so adding/editing/removing a schedule (or its
cron/runner) is picked up **without a daemon restart**. Only repos in `config.repositories[]` are
scanned — the same opt-in posture as GitHub polling.

### Run one now

```bash
milo prompt <repo>:<name>   # e.g. milo prompt milo-sandbox:nightly-tidy
milo prompt <name>          # bare name when unambiguous across repos
```

Runs a configured prompt schedule immediately (great for testing the 10pm job at 2pm) — the daemon
processes it if running, otherwise it drains inline.

> Central `config.schedules` entries still parse (and `kind: "maintenance"` works there), but
> schedule-a-ticket (`kind: "enqueue"`) was removed in favor of prompt scheduling.

Every fire is recorded in the `schedule_runs` table (name, kind, detail, timestamp), which is what
`milo schedules` reads for "last run" across processes.

---

## The built-in maintenance schedule

If your config defines **no** maintenance schedule, the daemon injects one automatically:

```json
{ "name": "maintenance", "cron": "0 */6 * * *", "intent": { "kind": "maintenance" }, "enabled": true }
```

i.e. **every 6 hours**. Define your own maintenance schedule to override the cadence.

---

## Inspecting schedules

```bash
milo schedules          # table: name (repo:name), kind, cron, next run, last run
milo schedules --json   # machine-readable
milo prompt <name>      # run a prompt schedule now (see above)
```

The next-run time is computed from the cron pattern; the last-run time comes from `schedule_runs`. The
live `Scheduler` object only exists inside the daemon, but because state is in SQLite, the CLI/TUI can
report next/last runs even from another process. The TUI's **Scheduled** pane shows the same data and
refreshes every second.

---

## Maintenance

`packages/core/src/maintenance.ts` — `runMaintenance` runs three housekeeping tasks and returns a
report (`{ worktreesPruned, logsDeleted, freeGb, diskOk }`):

| Task | Function | Behavior |
|------|----------|----------|
| **Prune worktrees** | `pruneWorktrees(base, activePaths, maxAgeMs=6h)` | Remove worktree dirs not tied to a live job and older than ~6h, via `git worktree remove --force` (fallback `rm -rf`). |
| **Rotate logs** | `rotateLogs(logsDir, maxAgeDays=14)` | Delete `*.log` files older than 14 days. |
| **Disk guard** | `diskGuard(path, minFreeGb=5)` | `statfs` the volume; warn if free space is under 5 GB. |

This keeps the box healthy unattended — important because disk can be tight on small machines, and
worktrees are always torn down after a job regardless.

---

## Cron syntax

Croner accepts standard 5-field cron (`min hour day month weekday`). Examples:

| Pattern | Meaning |
|---------|---------|
| `0 */6 * * *` | Every 6 hours (on the hour). |
| `0 3 * * *` | Daily at 03:00. |
| `*/15 * * * *` | Every 15 minutes. |
| `0 9 * * 1-5` | 09:00 on weekdays. |

`Scheduler.isValid(pattern)` validates syntax and `Scheduler.nextRun(pattern)` computes the next fire
time; an invalid pattern is logged and skipped rather than crashing the daemon.
