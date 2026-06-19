# Operations & Troubleshooting

How to run Milo day-to-day, keep the daemon healthy, find logs, and diagnose problems.

---

## Running the daemon

```bash
milo daemon        # foreground, by hand
milo restart       # restart it (picks up new code) — works for launchd and manual daemons
milo stop          # stop it (graceful drain; --force to SIGKILL)
```

Or always-on via launchd (recommended — see [installation.md](./installation.md#6-optional-run-always-on-via-launchd)):

```bash
bash scripts/install-launchd.sh
launchctl load   ~/Library/LaunchAgents/com.milo.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.milo.daemon.plist   # stop
launchctl list | grep milo                                       # is it loaded?
```

The plist has `RunAtLoad=true` + `KeepAlive=true`, so the daemon starts at login and restarts on crash.
The bootstrap (`~/start-milo.sh`) strips auth env vars (forces subscription use) before exec'ing the
daemon.

`milo restart` does the right thing for either mode: `launchctl kickstart -k` when the label is loaded,
otherwise SIGTERM-the-pid → wait for the drain → re-spawn detached. Because the daemon runs from source
via tsx, **restart after pulling new code**.

### Dogfooding

GitHub `@milo` attach is **disabled on the public `acarr/milo` repo** — it has no `githubRepo` in
config, so it isn't GitHub-polled (a public repo would otherwise let anyone trigger a local run). Drive
milo's own work through Linear `MILO` tickets or `milo <ID>`. For a **private** repo with a `githubRepo`
set, commenting `@milo <feedback>` on an open PR (or adding the `milo` label) makes Milo revise that PR.
If the PR's branch is checked out in your dev tree, Milo attaches a detached worktree at the PR head and
pushes by refspec, so your checkout is never touched.

Only **one** process drains the queue. `milo <ID>` defers to a running daemon (enqueue-only); if no
daemon is up it drains inline.

---

## Checking status

```bash
milo status            # daemon liveness (pid) + queue counts by state
milo status --json
milo jobs              # recent jobs: entity, state, runner, age, PR/failure
milo                   # the TUI — live view, refreshes every 1s
```

`milo status` reads `daemon.pid` and verifies the pid with a `kill -0` signal, so a stale PID file is
reported as not-running.

Only one daemon can run at a time: `startDaemon` acquires an exclusive OS-level lock on
`$MILO_HOME/daemon.lock` before doing anything else, and a second `milo daemon` exits with
`milo daemon is already running (pid N)`. The lock dies with its process, so a crashed daemon never
blocks the next start.

---

## Logs

```
$MILO_HOME/logs/
  daemon.log           # daemon stdout/stderr (when launched by launchd)
  <issue>-<ts>.log     # one per runner invocation
```

```bash
milo logs SBX-5                       # latest runner log for an issue
tail -f ~/.milo/logs/daemon.log       # follow the daemon
```

Log level: `MILO_LOG_LEVEL=debug milo daemon` (Pino; default `info`).

Maintenance rotates `*.log` older than **14 days** (see [scheduling.md](./scheduling.md#maintenance)).

---

## `milo doctor`

Run this first whenever something's off:

```bash
milo doctor
```

It validates config, `claude`, `codex` (optional), `gh` auth, `docker` (optional), free disk, the
SQLite store, and that the worktree base is writable. See [cli.md](./cli.md#milo-doctor) for the full
list. `--json` for scripting.

---

## Common situations

### A job is stuck in an active state
The lease watchdog requeues any active job whose worker died (lease + 30s grace) — wait ~90s. If the
runner is *hung* (alive but silent) it won't be killed yet (known gap, REMAINING-WORK B2); inspect with
`milo logs <ID>` and, if needed, stop the daemon, which triggers `recoverOnStartup` on next start.

### A repo's jobs are all going to `abandoned`
The circuit breaker is **open** for that repo after 5 consecutive infra failures. Check why
(credentials, remote, setup script):
```bash
sqlite3 ~/.milo/milo.db 'SELECT * FROM repo_health;'
```
It auto-probes after the 30m cooldown; the next job is the half-open probe. Fix the underlying cause
and the first success closes it. See [reliability.md](./reliability.md#per-repo-circuit-breaker).

### A trigger didn't fire
Polling is the backstop, so worst case is one poll interval. If it never fired, check
`inbound_events` for the disposition + reason:
```bash
sqlite3 ~/.milo/milo.db 'SELECT source, disposition, reason, received_at FROM inbound_events ORDER BY received_at DESC LIMIT 20;'
```
Common reasons: no repo configured for the issue's team key; GitHub repo not opted in
(`githubRepo` missing); actor not on the webhook allowlist. Force a sweep with `milo poll`.

### Linear shows the agent session as "stale"
Under polling (~90s) Milo acks later than Linear's ~10s stale timer, then revives the session with its
`thought`/`response`. Enabling webhooks (sub-10s ack) removes the flash — see
[webhooks.md](./webhooks.md).

### Disk filling up
Worktrees always tear down after a job; maintenance prunes stragglers >6h old and warns under 5 GB
free. Relocate `worktreeBase` to a roomier volume if needed
([configuration.md](./configuration.md#top-level)).

### Codex left the tree dirty with no commit
Expected — Codex's sandbox can't touch the real `.git`. The verification gate commits/pushes/opens the
PR itself. Don't intervene. See [runners.md](./runners.md#the-codex-git-sandbox-gotcha).

---

## Webhook accelerator

On/off and verification live in [webhooks.md](./webhooks.md). Quick recall:

```bash
bash scripts/setup-funnel.sh        # map Funnel :8443 → 127.0.0.1:3457
bash scripts/setup-funnel.sh off    # remove just that mapping (any other tool's :443 untouched)
```

Then `webhook.enabled: true` + `trust.webhookSecrets` in config, register in Linear/GitHub, restart.

---

## Coexisting with other tools

Milo uses a separate home (`~/.milo`), launchd label (`com.milo.daemon`), webhook port (`:3457`), and
Funnel port (`:8443`). Never run `tailscale funnel reset` — it would wipe any other tool's Funnel
mappings (e.g. another agent on `:443`). The Funnel script only ever touches `:8443`.

---

## Updating Milo

```bash
cd ~/development/milo
git pull
pnpm install          # if deps changed
pnpm typecheck && pnpm test
launchctl unload ~/Library/LaunchAgents/com.milo.daemon.plist
launchctl load   ~/Library/LaunchAgents/com.milo.daemon.plist
```

No build step — the daemon runs from source via `tsx`.
