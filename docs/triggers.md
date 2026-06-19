# Triggers — How Work Reaches Milo

Milo accepts work from four sources. All of them funnel into **one durable SQLite queue** through a
common `JobIntent` shape (`packages/transports/src/index.ts`). **Polling is the system of record**;
webhooks are an opt-in accelerator that uses the exact same enqueue path, so a webhook and a poll for
the same work **collapse to a single job** via a shared identity key.

```
Linear (label / delegation) ┐
GitHub (label / @milo)       ├─► JobIntent ─► intentToNewJob ─► enqueue (dedup by identity key) ─► queue
CLI (milo <ID>)              │
Schedule (cron)             ┘
```

---

## Identity & deduplication

Every intent carries:

| Field | Meaning |
|-------|---------|
| `source` | `linear` \| `github` \| `schedule` \| `cli` |
| `entityId` | Stable per-source id — e.g. `SBX-5`, `owner/name#12` |
| `triggerType` | `issue.start`, `issue.label`, `issue.delegate`, `pr.label`, `pr.mention`, `scheduled` |
| `contentHash` | Dedup key (defaults to `entityId`); carries a timestamp for re-triggerable work |
| `mode` | `create` (new branch + PR) \| `attach` (existing PR branch) |
| `repo` | Best-guess repo name |
| `actor`, `rawEventId` | Optional provenance |

The **identity key** is a hash of `source : entityId : triggerType : contentHash`. Enqueue is
idempotent on it: if a non-terminal job already exists for that key, the new intent is **deduped**; if
the existing job is terminal, it is **requeued**. Every inbound event (created / deduped / rejected /
dropped, with a reason) is recorded in the `inbound_events` table for observability.

---

## 1. Linear

Milo is a registered Linear **app user**. Because app users **cannot be a normal assignee**
(`issueUpdate(assigneeId:…)` reports success but the assignee stays null), the two reliable hand-offs are:

### a) The `milo` label
Add the **`milo`** label to an issue. The Linear poller (`pollLinear`) picks up issues that:
- carry the `milo` label,
- are in a live (non-completed/canceled) state,
- were updated within the last ~14 days,
- and are **not** also labeled `milo:ignore`.

→ `triggerType: issue.label`, `contentHash: <issue.identifier>` (fires once per labeled issue).

### b) Agent-session delegation
Delegate the issue to the **Milo agent** in Linear (the agent "chat"). The poller finds pending agent
sessions assigned to Milo.

→ `triggerType: issue.delegate`, `contentHash: session:<sessionId>` (a new delegation re-triggers).

**While it works**, Milo drives the Linear **agent session** transcript: a `thought` activity (which
also **revives a `stale` session to `active`**), an `action` activity (`opened_pr` / `found_pr` with
the URL), and a terminal `response` (success) or `error` (blocker) activity. If there's no agent
session, it falls back to a normal issue **comment**. On success it moves the ticket to **In Review**.

**Live progress streaming (MILO-5).** Between setup and the PR, Milo streams the agent's real
activity into the session — meaningful file edits, commands, test runs, and milestone narration —
so the transcript reads like watching it work instead of going silent for minutes. The runner emits
a normalized, runner-agnostic event stream (Claude `stream-json`, Codex `--json`); `core`'s
`ProgressStreamer` applies a **signal filter** (suppress reads/greps/chatter), **throttle +
coalesce** (≤1 activity per `progress.minIntervalMs`, bursts collapse into one summary), secret
redaction, and adaptive back-off on rate limits. It's **best-effort** (a failed post never blocks
the job) and gated to **agent-session jobs only** — label-only jobs keep their minimal behavior
(no comment spam). Tune via the global `progress` config block (`enabled`, `verbosity`
quiet/normal/verbose, `minIntervalMs`) with optional per-repo override.

Both Linear triggers run in **create mode**: fresh worktree → branch → implement → PR.

---

## 2. GitHub

GitHub triggers are **opt-in per repo** — only repos with a `githubRepo: "owner/name"` field in config
are polled (this keeps Milo off other tools' shared clones). The GitHub poller (`pollGithub`) watches **open
PRs** in those repos for:

> GitHub `@milo`/label triggers require a `githubRepo` in config (opt-in polling). The **public
> `acarr/milo` repo has this disabled** — drive its own work via Linear `MILO` tickets / `milo <ID>`.
> The triggers below apply to repos that opt in (e.g. a private sandbox).

### a) The `milo` label on a PR
→ `triggerType: pr.label`, `contentHash: <slug>#<number>:label` (fires once).

### b) An `@milo` mention in a PR comment
→ `triggerType: pr.mention`, `contentHash: <slug>#<number>:<comment timestamp>` (a **new** mention
re-triggers, because the timestamp changes the content hash).

Both GitHub triggers run in **attach mode**: Milo checks out the PR's existing head branch, applies the
requested follow-up, and **pushes to the same branch** (updating the PR) — it does not open a new PR.
The instruction is extracted from the latest `@milo` comment (with `@milo` stripped), or a sensible
default ("address the latest review feedback").

> Cross-repository (fork) PRs are currently routed to `needs-attention` — same-repo branches only.
> Fork attach support is a planned follow-up.

Webhook actor gating (`trust.githubActors`) applies when webhooks are on; empty = allow all.

---

## 3. CLI

```bash
milo SBX-5 WAZ-12
```

Enqueues issues directly as `cli`-source jobs (`triggerType: issue.start`). If the daemon is up they're
handed to it; otherwise the CLI drains them inline. See [cli.md](./cli.md).

---

## 4. Schedule

Cron entries in `config.schedules` (plus the built-in 6h maintenance job) fire inside the daemon. A
`{ kind: "maintenance" }` intent runs housekeeping; any other intent is enqueued as a job. Scheduled
enqueues fold the **last-run timestamp** into the content hash so each fire is a distinct job. See
[scheduling.md](./scheduling.md).

---

## Why polling is the backstop

The first sacred invariant is **"never silently fail to start."** Polling is a reconciler over the
true state in Linear/GitHub, so a dropped or missed webhook costs at most one poll interval (~90s
Linear / ~120s GitHub) — never a lost ticket. Webhooks only lower latency; they are never the sole path.
See [reliability.md](./reliability.md).
