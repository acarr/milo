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
| `conductor` | object | see below | Conductor Cloud remote runner (see [conductor.md](./conductor.md)). |
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
| `defaultRunner` | `"claude"`\|`"codex"`\|`"conductor"` | — | Runner override for this repo (else the global default). |
| `conductor` | `{ projectId?, repositoryUrl?, agent?, model?, effort? }` | — | Per-repo Conductor Cloud settings. `projectId` is effectively **required** for a conductor repo (org API keys reject repos not on the org machine), and `githubRepo` becomes required too. |
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
  "claude":    { "modelChain": ["opus", "sonnet", "haiku"] },
  "codex":     { "modelChain": ["gpt-5.5"] },
  "conductor": { "modelChain": ["opus-5-1m"] }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `default` | `"claude"` | Runner used when nothing else selects one (`claude` \| `codex` \| `conductor`). |
| `claude.modelChain` | `["opus","sonnet","haiku"]` | Ordered model preference for Claude. |
| `codex.modelChain` | `["gpt-5.5"]` | Ordered model preference for Codex. |
| `conductor.modelChain` | `["opus-5-1m"]` | Ordered model preference for Conductor Cloud. Model ids are **agent-specific** (`opus-*` for its claude agent, `gpt-*` for codex). |

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

## `conductor`

The remote runner. Full guide: **[conductor.md](./conductor.md)**.

```json
{
  "baseUrl": "https://api.conductor.build/v0",
  "userAgent": "milo (+https://github.com/acarr/milo)",
  "agent": "claude",
  "concurrency": 10,
  "pollMs": 15000,
  "dispatchTimeoutMs": 600000,
  "cleanup": { "onSuccess": "archive", "onFailure": "sleep" },
  "env": {}
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `apiKey` | — | Plaintext fallback. Prefer `CONDUCTOR_API_KEY` or `$MILO_HOME/secrets/conductor.json`. |
| `concurrency` | `10` | Max remote sessions tracked at once — **separate from the top-level `concurrency`**, so parked remote jobs never consume a local slot. |
| `baseUrl` | `https://api.conductor.build/v0` | API base. `GET /me` hangs off the origin, without `/v0`. |
| `userAgent` | `milo (+…)` | **Required, not cosmetic** — Conductor's proxy 403s some default client signatures (e.g. Node's `undici`), which looks exactly like a bad key. |
| `agent` | `"claude"` | Which agent runs *inside* the cloud workspace (`claude`/`codex`/`cursor`). Orthogonal to the Milo runner id. |
| `effort` | — | Conductor reasoning effort (`none`…`ultra`). |
| `pollMs` | `15000` | Session poll interval. Conductor has **no webhooks**. |
| `dispatchTimeoutMs` | `600000` | Give up if the session never starts a turn. |
| `cleanup.onSuccess` / `.onFailure` | `archive` / `sleep` | Workspace disposition. Forced to preserve when work is unreachable. |
| `env` | `{}` | Env vars forwarded to the workspace. **Ships to a third party — keep secrets out.** |

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
(`repositories[].promptAugmentation`) layers after the global one. For anything more than a few
sentences, prefer a **workflow file** in the repo (below) — it replaces the phase body instead of
appending to the system prompt.

---

## Per-repo config: `<repo>/.milo/config.json`

The repository's own half of the contract. It lives **in the repo** (next to `.milo/schedules.json`),
is validated with Zod (`packages/core/src/repo-config.ts`), and is **re-read at the start of every
job**, so edits land without a daemon restart. Everything is optional: a repo with no file behaves
exactly as before (built-in prompt text, no verify gate, no labels), so other repos are untouched.

```json
{
  "version": 1,
  "workflows": {
    "linearIssue": "workflows/linear-issue.md",
    "attach": "workflows/attach.md",
    "schedule": null
  },
  "labels": ["agent-authored"],
  "classLabelFromTicket": true,
  "verifyCommand": "pnpm typecheck",
  "verifyByPath": [
    { "paths": ["packages/ios/**"], "command": "make test-ios-unit" },
    { "paths": ["packages/android/**"], "command": "make test-android-unit" }
  ],
  "verifyTimeoutMs": 1200000,
  "model": { "default": "opus", "byLabel": { "class:chore": "sonnet" } },
  "maxTurns": null
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | `1` | `1` | Schema version. |
| `workflows.linearIssue` | path \| null | — | Phase body for a Linear-issue (create-mode) run. |
| `workflows.attach` | path \| null | — | Phase body for attach mode: an `@milo` PR follow-up, a Linear revision, **and the gate's verify-failure retry**. |
| `workflows.schedule` | path \| null | — | Phase body for a scheduled-prompt run. |
| `labels` | string[] | `[]` | Labels every PR Milo opens in this repo carries — passed as `gh pr create --label a,b` by the gate, and stated in the model's PR instructions. |
| `classLabelFromTicket` | boolean | `false` | Also copy every Linear label matching `^class:` (e.g. `class:chore`) onto the PR. |
| `verifyCommand` | string \| null | — | Shell command the **verification gate** runs in the worktree before a job may be `done`. |
| `verifyByPath[]` | `{ paths: glob[], command }` | `[]` | Extra verify commands, each run only when `git diff --name-only origin/<base>...HEAD` (plus uncommitted files) touches one of its globs (`**`, `*`, `?`). |
| `verifyTimeoutMs` | number | `1200000` (20 min) | Wall-clock cap **per command**; a timeout is a failure. |
| `model.default` | string \| null | — | Model for every run in this repo (overrides the global chain; a `[agent=…]` tag / `runner:` label still picks the *runner*). |
| `model.byLabel` | `Record<label, model>` | `{}` | The **first issue label** (in the issue's order, case-insensitive) with an entry wins over `model.default`. |
| `maxTurns` | number \| null | — | Passed to Claude Code as `--max-turns`. Unlimited when unset. |

Resolution order for `--model`: `[agent=…]` tag / `runner:` label choose the **runner** → `model.byLabel[<first matching label>]` → `model.default` → `runnerDefaults.<runner>.modelChain[0]`. The value must be valid for the repo's runner (Claude model names for `claude`, GPT names for `codex`); a Conductor run ignores the repo override.

### Workflow files

A workflow `.md` is the **phase body** of the prompt. Milo always produces the header — `<context>`,
`<linear_issue>` (or `<pull_request>` / `<task>`), `<routing>` / `<requested_change>`, the PR
context blocks, and `<previous_attempt>` on a retry — and always produces the footer (`## Final output
(REQUIRED)` + the `MILO_RESULT` contract). The workflow file **replaces everything between them**,
including the built-in "Critical Rules", so the file should carry its own rules (run autonomously,
never leave code without a PR, `outcome=discovery` for no-code tasks). Paths resolve relative to
`<repo>/.milo/`, then `<repo>/`; absolute paths are used as-is. A missing/empty file is logged and that
prompt falls back to the built-in text (only `milo prompt --issue` treats it as an error).

Placeholders substituted in the body — anything else in `{{…}}` is left as written:

| Placeholder | Value |
|-------------|-------|
| `{{ISSUE_ID}}` | Linear identifier (`WAZ-1234`). Linear prompts only. |
| `{{BASE_BRANCH}}` / `{{BRANCH}}` | The worktree's base and feature branch. |
| `{{PR_NUMBER}}` / `{{PR_URL}}` | The existing PR (attach prompts only). |
| `{{REPO}}` | The repo's config `name`. |
| `{{WORKING_DIRECTORY}}` | The worktree path. |
| `{{LABELS}}` | Comma-joined PR labels (`agent-authored,class:chore`), for the model's `gh pr create --label`. |

`MILO_RESULT` may additionally carry `"criteria":{"passed":n,"total":m}` when the workflow has the
agent track acceptance criteria; Milo records it on the job, in the Linear report, and in the PR body.

### The verification gate

When `verifyCommand` / a matching `verifyByPath` entry is configured, the gate runs the command(s) in
the worktree (async, under the job's heartbeat, `/bin/sh -c`, with `CI=1` and the runners' PATH
hygiene) **after the run and before the PR is opened**. A failure gives the agent **one attach-mode
retry** whose prompt carries the failing output in `<previous_attempt>`; then the gate re-runs. If it
still fails, the work is preserved behind a **draft `[incomplete]` PR** (the failure in its warning)
and the job lands in `needs-attention` with `failure_class = verify-failed`. Results are recorded on the
job (`verify_status`, `verify_detail`) and in the Linear report. Remote (Conductor) runs skip the gate
— their local worktree has no toolchain. See [job-lifecycle.md](./job-lifecycle.md#the-verify-step).

Dry-run the whole assembly for a ticket without running anything:
`milo prompt --issue WAZ-1234 [--repo wazzon] [--attempt-of <jobId>]` ([cli.md](./cli.md#milo-prompt)).

### `GH_TOKEN` for the daemon

`gh` (inside the run and in the gate) authenticates from the daemon's environment. Milo passes the
daemon's env through to its children (only API-billing keys are stripped), so exporting `GH_TOKEN` for
the daemon is enough to make PRs come from a specific GitHub identity. `scripts/install-launchd.sh`
sources `$MILO_HOME/env` (KEY=value lines) at daemon start for exactly this.

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
