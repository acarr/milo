# Configuration Reference

Milo reads a single JSON file at **`$MILO_HOME/config.json`** (default `~/.milo/config.json`). The
schema is a **backward-compatible superset of the legacy `milo.sh` format**: a v1 file parses cleanly
and is normalized to v2 in memory — Milo does **not** rewrite your file. Validation is via Zod
(`packages/core/src/config.ts`); a malformed file makes `milo doctor` and the daemon fail loudly.

All fields below show their **default**; every field except `repositories[].name` / `path` is optional.

---

## Top level

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | `2` | `2` | Schema version. v1 files are accepted and treated as v1 on read. |
| `miloHome` | string | — | Override the runtime home. The `MILO_HOME` env var takes precedence over this. |
| `worktreeBase` | string | `$MILO_HOME/worktrees` | Where git worktrees are created. Relocate to a roomier disk if needed. |
| `concurrency` | number | `3` | Max jobs running simultaneously across the whole daemon. |
| `runnerDefaults` | object | see below | Default runner + per-runner model chains. |
| `promptAugmentation` | `{ global?: string }` | `{}` | System-prompt text appended to **every** run (before any per-repo augmentation). |
| `schedules` | array | `[]` | Cron automations (see [scheduling.md](./scheduling.md)). |
| `trust` | object | see below | Webhook actor allowlists + signing secrets. |
| `webhook` | object | see below | Daemon webhook server config. |
| `progress` | object | see below | Live agent-session progress streaming (see below). |
| `dependencies` | object | see below | Linear `blockedBy` sequencing (see below). |
| `transports` | object | see below | Per-source polling + mode. |
| `repositories` | array | `[]` | Per-repo setup (the core of routing). |
| `linearToken`, `linearRefreshToken`, `linearClientId`, `linearClientSecret` | string | — | Linear OAuth credentials, written by `milo linear-auth`. (Migration to a `secrets/` dir is deferred.) |

---

## `repositories[]`

The list of repos Milo can work in. Each entry:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | **required** | Repo identifier; also the circuit-breaker key. |
| `path` | string | **required** | Absolute path to the local clone. Worktrees branch off this. |
| `baseBranch` | string | `"main"` | Branch new feature branches are cut from / PRs target. |
| `teamKeys` | string[] | `[]` | Linear team keys this repo serves (e.g. `["ENG"]`). Used to route an issue → repo. |
| `packageManager` | `"npm"`\|`"pnpm"`\|`"yarn"` | `"npm"` | Used by the generic worktree setup (`<pm> install`). |
| `setupScript` | string | — | Script run in each fresh worktree (instead of the generic copy-env + install). |
| `teardownScript` | string | — | Script run when tearing a worktree down (instead of `git worktree remove`). |
| `routingLabels` | string[] | — | When **multiple** repos share a team key, the one whose `routingLabels` match the issue's labels wins. |
| `routing` | `Record<string,string>` | — | Map of label → extra instruction injected into the prompt. |
| `defaultRouting` | string | — | Routing instruction used when no `routing` label matches. |
| `defaultRunner` | `"claude"`\|`"codex"` | — | Runner override for this repo (else the global default). |
| `promptAugmentation` | string | — | System-prompt text appended after the global one, for this repo only. |
| `teardownPolicy` | `"always"`\|`"keep-on-failure"` | `"always"` | Whether to keep the worktree when a job fails (for debugging). |
| `githubRepo` | string (`owner/name`) | — | **Opt-in** for GitHub PR triggers (label / `@milo`). If omitted, the repo is **not** polled on GitHub. Inferred from the `origin` remote where possible. |
| `progress` | `{ enabled?, verbosity?, minIntervalMs? }` | — | Per-repo override of the global `progress` block (only the set fields override). |

**Repo resolution** (`resolveRepo`): filter repos by the issue's team key; if one match, use it; if
several, prefer the one whose `routingLabels` intersect the issue labels, else the first with no
`routingLabels`.

---

## `runnerDefaults`

```json
{
  "default": "claude",
  "claude": { "modelChain": ["opus", "sonnet", "haiku"] },
  "codex":  { "modelChain": ["gpt-5.5"] }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `default` | `"claude"` | Runner used when nothing else selects one. |
| `claude.modelChain` | `["opus","sonnet","haiku"]` | Ordered model preference for Claude. |
| `codex.modelChain` | `["gpt-5.5"]` | Ordered model preference for Codex. |

> Today only the **first** model in a chain is used (`router.modelFor` returns `chain[0]`). Walking the
> chain on overload/crash is a planned follow-up (see `docs/REMAINING-WORK.md` B3).

See [runners.md](./runners.md) for the full runner-selection precedence.

---

## `transports`

Controls how each source is watched. Polling is the **system of record**; webhooks are an accelerator.

```json
{
  "linear":   { "mode": "poll", "pollSeconds": 90,  "enabled": true },
  "github":   { "mode": "poll", "pollSeconds": 120, "enabled": true },
  "slack":    { "enabled": false },
  "whatsapp": { "enabled": false }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `linear.mode` / `github.mode` | `"poll"`\|`"webhook"`\|`"webhook+poll"` | `"poll"` | Trigger mode. |
| `linear.pollSeconds` | number | `90` | Linear poll interval (floored to a 15s minimum by the poller). |
| `github.pollSeconds` | number | `120` | GitHub poll interval (15s minimum). |
| `*.enabled` | boolean | `true` | Whether that source is polled at all. |
| `slack.enabled` / `whatsapp.enabled` | boolean | `false` | **Stub-only** transports — never ship. |

---

## `webhook`

The opt-in daemon HTTP ingress (see [webhooks.md](./webhooks.md)).

```json
{ "enabled": false, "host": "127.0.0.1", "port": 3457 }
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | When false the daemon binds **no** port. |
| `host` | `"127.0.0.1"` | Bind host (localhost only by default; Funnel fronts it for the internet). |
| `port` | `3457` | Bind port. Distinct from the common `:3456` default. |

---

## `progress`

Live streaming of the agent's work into the Linear **agent-session** transcript (see
[triggers.md](./triggers.md#1-linear)). Only affects **delegated** (agent-session) jobs — label-only
jobs are never touched. Best-effort: a failed or rate-limited post never blocks the job.

```json
{ "enabled": true, "verbosity": "normal", "minIntervalMs": 8000 }
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch for progress streaming. |
| `verbosity` | `"normal"` | `quiet` (file edits + test/build commands + milestone narration only), `normal` (also other commands + meaningful narration), `verbose` (also reads/greps/etc.). |
| `minIntervalMs` | `8000` | Minimum spacing between activities. Bursts inside the window collapse into one summarized `thought`; repeated post failures back this off exponentially (up to 60s). |

A per-repo `progress` object overrides any subset of these for that repo.

---

## `dependencies`

Sequencing for Linear `blockedBy` relations: a blocked issue is held unclaimable until its
blocker no longer gates it, instead of both racing in parallel against `main`.

```json
{ "enabled": true, "defaultStrategy": "wait", "holdMs": 60000 }
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch. Disabling also clears any already-recorded gates on the next reconcile, so nothing stays stuck. |
| `defaultStrategy` | `"wait"` | `wait`: hold the dependent until the blocker's **PR merges**, then run it fresh against the updated base. `stacked`: once the blocker is **done**, base the dependent's worktree/PR off the blocker's head branch (the PRs stack). |
| `holdMs` | `60000` | The enqueue-time discovery window: a fresh Linear create job is unclaimable for up to this long, giving `syncDependencies` time to record its `blockedBy` edges (the hold releases early once they are). Closes the webhook/poll enqueue→claim race; `0` disables holds. |

A `stacked` / `wait` (or `milo:stacked` / `milo:wait` / `wait-for-merge`) **label on the dependent
issue** overrides the default for that issue. Cycles, blockers Milo isn't tracking, terminally-failed
blockers, and blocker PRs closed without merging all fall back to parallel (logged, plus one Linear
comment if sequencing had been announced). See [job-lifecycle.md](./job-lifecycle.md#the-queue) and
[database.md](./database.md#job_dependencies--blockedby-gates).

---

## `trust`

The webhook trust model (see [webhooks.md](./webhooks.md#trust-model)).

```json
{
  "linearActors": [],
  "githubActors": [],
  "autoMerge": false,
  "webhookSecrets": { "linear": "…", "github": "…" }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `linearActors` | `[]` | Allowed Linear actors for webhook triggers. **Empty = allow all.** |
| `githubActors` | `[]` | Allowed GitHub usernames for webhook triggers. **Empty = allow all.** |
| `autoMerge` | `false` | Reserved; not yet implemented. |
| `webhookSecrets.linear` | — | HMAC secret to verify `Linear-Signature`. |
| `webhookSecrets.github` | — | HMAC secret to verify `X-Hub-Signature-256`. |

---

## `schedules[]`

Cron automations run in-daemon (see [scheduling.md](./scheduling.md)).

```json
{ "name": "maintenance", "cron": "0 */6 * * *", "intent": { "kind": "maintenance" }, "enabled": true }
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | **required** | Identifier shown by `milo schedules`. |
| `cron` | string | **required** | Standard cron pattern (croner). |
| `intent` | object | **required** | `{ kind: "maintenance" }` runs housekeeping. |
| `enabled` | boolean | `true` | Whether the schedule fires. |

> A built-in **`maintenance`** schedule (`0 */6 * * *`, every 6h) is injected automatically **unless**
> your config already defines a maintenance schedule.
>
> **Scheduled prompts are defined per-repo, not here** — see
> [scheduling.md](./scheduling.md#scheduled-prompts-defined-in-the-repo) for `<repo>/.milo/schedules.json`.
> (Schedule-a-ticket — the old `kind: "enqueue"` — was removed in favor of prompt scheduling.)

---

## `promptAugmentation`

`{ "global": "…text…" }` — appended to the system prompt of every run. Per-repo augmentation
(`repositories[].promptAugmentation`) layers after the global one. (Per-surface layering — Linear vs
GitHub vs schedule — is a planned nice-to-have.)

---

## Worked example

```json
{
  "version": 2,
  "concurrency": 3,
  "worktreeBase": "/path/to/fast-disk/milo-worktrees",
  "runnerDefaults": {
    "default": "claude",
    "claude": { "modelChain": ["opus", "sonnet", "haiku"] }
  },
  "promptAugmentation": { "global": "Always run the project's verify script before committing." },
  "transports": {
    "linear": { "mode": "poll", "pollSeconds": 90, "enabled": true },
    "github": { "mode": "poll", "pollSeconds": 120, "enabled": true }
  },
  "webhook": { "enabled": false, "host": "127.0.0.1", "port": 3457 },
  "trust": {
    "linearActors": ["alice"],
    "githubActors": ["alice"],
    "webhookSecrets": { "linear": "…", "github": "…" }
  },
  "schedules": [
    { "name": "maintenance", "cron": "0 */6 * * *", "intent": { "kind": "maintenance" }, "enabled": true }
  ],
  "repositories": [
    {
      "name": "my-app",
      "path": "/Users/you/development/my-app",
      "baseBranch": "main",
      "teamKeys": ["ENG"],
      "packageManager": "pnpm",
      "githubRepo": "your-org/my-app",
      "defaultRunner": "claude",
      "teardownPolicy": "always"
    }
  ]
}
```
