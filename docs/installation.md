# Installation & Setup

Milo runs **locally on purpose** — it needs real simulators, emulators, Postgres/Redis, and ports
on the box. Everything below assumes macOS.

---

## 1. Prerequisites

| Tool | Required? | Why | Check |
|------|:---------:|-----|-------|
| **Node** — an LTS line (22 or 24) | ✅ | Runtime (dev runs from source via `tsx`). Stick to LTS; an `.nvmrc` pins 24 (`nvm use`) | `node -v` |
| **pnpm** 9.x | ✅ | Workspace package manager | `pnpm -v` |
| **Claude Code** (`claude`) | ✅ | Default runner — uses your Claude **subscription** | `claude --version` |
| **Codex** (`codex`) | optional | Alternate runner — uses your ChatGPT **subscription** | `codex --version` |
| **GitHub CLI** (`gh`), authenticated | ✅ | Opens/updates PRs, reads PR state | `gh auth status` |
| **Docker** | optional | For repos whose setup needs it | `docker info` |
| **git** | ✅ | Worktrees | `git --version` |
| **Tailscale** | optional | Only for the webhook accelerator (Funnel) | — |

> Milo never uses API billing. The runners are invoked through your interactive subscriptions; the
> launchd bootstrap (below) actively strips `ANTHROPIC_API_KEY` / OpenAI keys from the environment.

> **Why an LTS Node?** Milo's SQLite store (`better-sqlite3`) is a native module. On an LTS line it
> installs a **prebuilt binary** — no compiler needed. On a brand-new "Current" Node release (23, 25, …)
> no prebuilt binary exists yet, so `pnpm install` falls back to compiling from source via `node-gyp`,
> which needs a C/C++ toolchain. If you ever land on that path and the install fails on `better-sqlite3`,
> install the toolchain (`xcode-select --install` on macOS) — but the simpler fix is to `nvm use` an
> LTS line so the prebuilt binary is fetched instead.

Run `milo doctor` at any point to verify all of the above (see [operations.md](./operations.md#milo-doctor)).

---

## 2. Install dependencies

```bash
cd ~/development/milo
pnpm install
pnpm typecheck     # tsc -p tsconfig.json --noEmit
pnpm test          # node --test via tsx
```

There is **no build step for development** — the CLI and daemon run directly from TypeScript via `tsx`.

---

## 3. Put `milo` on your PATH

The `milo` command is provided by `bin/milo.mjs`, which shells out to `tsx` against
`packages/cli/src/index.ts`. Symlink it onto your PATH:

```bash
ln -sf ~/development/milo/bin/milo.mjs ~/.local/bin/milo
which milo        # → ~/.local/bin/milo
```

> The old bash `milo.sh` / `teardown.sh` and the `~/.zshrc` alias are **retired** — the `~/.local/bin/milo`
> symlink supersedes them.

---

## 4. Create the runtime home

Milo keeps all runtime state under **`$MILO_HOME`** (default `~/.milo`):

```
~/.milo/
  config.json     # configuration (see configuration.md)
  milo.db         # SQLite job ledger
  logs/           # per-run runner logs + daemon.log
  daemon.pid      # daemon liveness record
  daemon.lock     # daemon singleton lock (held while a daemon runs)
  worktrees/      # default worktree base (relocatable via config.worktreeBase)
```

**The easy path** — run the guided wizard, which does steps 4–5 (and optionally 6–7) for you:

```bash
milo init
```

It checks the environment (doctor), asks where Milo should live (defaults: `~/.milo` +
`$MILO_HOME/worktrees`), connects Linear, offers the optional opt-ins (Codex default runner, launchd,
webhooks, auto-merge — all skip-by-default), then adds your first repo via the same flow as
`milo add-repo`. It never overwrites an existing config — re-running it only fills gaps.

**The manual path** — create a minimal `~/.milo/config.json` yourself:

```json
{
  "version": 2,
  "concurrency": 3,
  "repositories": [
    {
      "name": "my-app",
      "path": "/Users/you/development/my-app",
      "baseBranch": "main",
      "teamKeys": ["ENG"],
      "packageManager": "pnpm",
      "githubRepo": "your-org/my-app"
    }
  ]
}
```

See [configuration.md](./configuration.md) for every field.

---

## 5. Register the Linear agent

Milo participates in Linear as a registered **app user** (not a normal member). Register/refresh it:

```bash
milo linear-auth
```

This runs an OAuth flow (`actor=app`, scopes `read`, `write`, `app:assignable`, `app:mentionable`,
redirect `http://localhost:8989/callback`) and writes `linearClientId`, `linearClientSecret`,
`linearToken`, and `linearRefreshToken` into `config.json`. Tokens auto-refresh on 401.

> **Linear app users cannot be a normal assignee.** The reliable hand-offs are the **`milo` label**
> and **agent-session delegation** — see [triggers.md](./triggers.md).

---

## 6. (Optional) Run always-on via launchd

By default you start the worker by hand with `milo daemon`. To make it survive logout/reboot/crash:

```bash
bash scripts/install-launchd.sh
```

This writes:

- **`~/start-milo.sh`** — a bootstrap that clears auth env vars (forces subscription use), sources
  Homebrew + NVM, and execs the daemon (`tsx packages/daemon/src/index.ts`).
- **`~/Library/LaunchAgents/com.milo.daemon.plist`** — label `com.milo.daemon`, `RunAtLoad=true`,
  `KeepAlive=true`, stdout/stderr → `$MILO_HOME/logs/daemon.log`.

Load it: `launchctl load ~/Library/LaunchAgents/com.milo.daemon.plist`.

---

## 7. (Optional) Enable the webhook accelerator

Webhooks are an **opt-in latency accelerator** on top of polling — see [webhooks.md](./webhooks.md)
for the full setup. In short:

```bash
bash scripts/setup-funnel.sh          # maps Tailscale Funnel :8443 → 127.0.0.1:3457
```

Then set `webhook.enabled: true` + `trust.webhookSecrets.{linear,github}` in `config.json`, register
the webhooks in Linear/GitHub, and restart the daemon.

---

## Coexisting with other tools

Milo is designed to run alongside other agents on the same machine without collision:

| | Milo | Another agent |
|---|---|---|
| Home | `~/.milo` | (its own) |
| launchd label | `com.milo.daemon` | (its own) |
| Webhook port | `127.0.0.1:3457` (opt-in) | (its own, e.g. `:3456`) |
| Tailscale Funnel | `:8443` | (its own, e.g. `:443`) |

`scripts/setup-funnel.sh` touches **only** the `:8443` mapping and never runs `tailscale funnel reset`
(which would wipe any other tool's Funnel mappings, e.g. another agent on `:443`).

---

## A sandbox for testing

For live end-to-end tests, point Milo at a low-stakes repo and a sandbox Linear team:

- A throwaway repo (e.g. `your-org/sandbox-repo`) wired into `config.repositories[]` with a `githubRepo`.
- A sandbox Linear team — use its team key (e.g. `ENG`) in that repo's `teamKeys`.

Test loop: create a ticket → `milo ENG-123` → watch via `milo jobs` or the TUI → merge the PR and
confirm Linear auto-closes via `Closes ENG-123`.
