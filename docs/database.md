# Database Reference

Milo's state lives in a single SQLite file at **`$MILO_HOME/milo.db`**
(`packages/core/src/store.ts`, via `better-sqlite3`). It is the **source of truth** for everything —
jobs survive restarts, and the daemon + CLI + TUI all read it concurrently.

**Pragmas:** `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`
(5s lock wait so the daemon and a CLI invocation don't collide).

---

## `jobs` — the work ledger

One row per unit of work. Primary key `id`; **unique** on `identity_key`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Job id. |
| `identity_key` | TEXT UNIQUE | Hash of `source:entity_id:trigger_type:content_hash` — the dedup key. |
| `source` | TEXT | `linear` \| `github` \| `schedule` \| `cli`. |
| `entity_id` | TEXT | e.g. `ENG-123` or `owner/repo#12`. |
| `entity_ref` | TEXT | Display ref (defaults to `entity_id`). |
| `trigger_type` | TEXT | `issue.start`, `issue.label`, `issue.delegate`, `pr.label`, `pr.mention`, `scheduled`. |
| `content_hash` | TEXT | Dedup component (timestamp-bearing for re-triggerable work). |
| `state` | TEXT | Job state (see [job-lifecycle.md](./job-lifecycle.md)). |
| `mode` | TEXT | `create` \| `attach` (default `create`). |
| `runner` | TEXT | `claude` \| `codex` \| null. |
| `model` | TEXT | e.g. `opus`, `gpt-5.5`. |
| `repo` | TEXT | Repo name from config. |
| `worktree_path` | TEXT | Absolute worktree path. |
| `branch` | TEXT | Feature/head branch. |
| `base_branch` | TEXT | Target branch (default `main`). |
| `routing_instruction` | TEXT | Routing hint injected into the prompt. |
| `attempts` | INTEGER | Times run so far (default 0). |
| `max_attempts` | INTEGER | Default 3. |
| `next_eligible_at` | INTEGER | Epoch ms backoff gate; not claimable before this. |
| `lease_owner` | TEXT | Worker holding the lease. |
| `lease_expires_at` | INTEGER | Epoch ms lease expiry. |
| `last_heartbeat_at` | INTEGER | Epoch ms of last heartbeat. |
| `declared_outcome` | TEXT | Runner's self-reported outcome. |
| `declared_pr_url` | TEXT | Runner's claimed PR. |
| `declared_wrote_code` | INTEGER | Boolean (1/0) self-report. |
| `verified_outcome` | TEXT | Ground-truth outcome after verification. |
| `pr_url` | TEXT | Final PR URL (may differ from declared). |
| `failure_class` | TEXT | `transient-infra`, `runner-crash`, `no-pr`, `wrong-outcome`, `unexpected`, `breaker`, `logic`. |
| `failure_detail` | TEXT | Human-readable error. |
| `summary` | TEXT | Runner summary (posted back). |
| `created_at` / `updated_at` / `terminal_at` | INTEGER | Epoch ms timestamps. |

**Indexes:** `idx_jobs_state(state)`, `idx_jobs_entity(entity_id)`,
`idx_jobs_eligible(state, next_eligible_at)`.

---

## `job_events` — per-job event log

Append-only history. **Unique** on `(job_id, seq)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `job_id` | TEXT | |
| `seq` | INTEGER | Monotonic per-job sequence. |
| `kind` | TEXT | `state_change`, `retry`, `reclaimed`, `remediation`, … |
| `from_state` / `to_state` | TEXT | For state changes. |
| `data` | TEXT | JSON blob (attempts, delayMs, reason, prUrl, …). |
| `at` | INTEGER | Epoch ms. |

The TUI's detail pane shows the last 8 of these for the selected job.

---

## `inbound_events` — trigger observability

Every webhook/poll receipt, so a missed or rejected trigger is explainable.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `source` | TEXT | `linear` \| `github`. |
| `channel` | TEXT | `webhook` \| `poll`. |
| `raw_payload` | TEXT | Full JSON. |
| `identity_key` | TEXT | Matched job identity key, if any. |
| `job_id` | TEXT | Created job id, if any. |
| `disposition` | TEXT | `created` \| `deduped` \| `rejected` \| `dropped`. |
| `reason` | TEXT | Why not created (e.g. "no repo for team key"). |
| `received_at` | INTEGER | Epoch ms. |

> A TUI "Why didn't it start?" panel over this table is a planned addition (REMAINING-WORK C3).

---

## `repo_health` — circuit breaker state

One row per repo. See [reliability.md](./reliability.md#per-repo-circuit-breaker).

| Column | Type | Notes |
|--------|------|-------|
| `repo` | TEXT PK | `repo.name`. |
| `consecutive_infra_failures` | INTEGER | Reset to 0 on any success. |
| `breaker_state` | TEXT | `closed` \| `open` \| `half-open`. |
| `opened_at` | INTEGER | Epoch ms when opened. |
| `cooldown_until` | INTEGER | Epoch ms when half-open becomes eligible. |

---

## `side_effects` — idempotency ledger

Guards external writes so retries don't double-post.

| Column | Type | Notes |
|--------|------|-------|
| `idempotency_key` | TEXT PK | e.g. `breaker:<repo>:<openedAt>`. |
| `kind` | TEXT | `pr-create`, `comment`, `state-set`, `breaker-notice`, `report`. |
| `external_id` | TEXT | PR URL, comment id, … |
| `created_at` | INTEGER | Epoch ms. |

---

## `job_dependencies` — blockedBy gates

Linear `blockedBy` sequencing. An **unresolved** row makes its dependent unclaimable
(`claimNext` excludes it in SQL); the async reconciler (`dependencies.ts`) resolves or drops rows as
blockers finish, merge, fail, or vanish.

| Column | Type | Notes |
|--------|------|-------|
| `dependent_entity_id` | TEXT PK¹ | The blocked issue (e.g. `ENG-124`). |
| `blocker_entity_id` | TEXT PK¹ | The issue blocking it (e.g. `ENG-123`). |
| `strategy` | TEXT | `wait` (default) \| `stacked`. |
| `resolved` | INTEGER | `1` once the blocker no longer gates the dependent. |
| `blocker_branch` | TEXT | The blocker's head branch — recorded on resolve for `stacked` base-off. |
| `created_at`, `updated_at` | INTEGER | Epoch ms. |

¹ Composite primary key `(dependent_entity_id, blocker_entity_id)`.

**Index:** `idx_job_deps_dependent(dependent_entity_id, resolved)` — for the `claimNext` gate.

---

## `schedule_runs` — automation history

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `name` | TEXT | Schedule name. |
| `kind` | TEXT | `maintenance` \| `enqueue`. |
| `detail` | TEXT | Extra context. |
| `at` | INTEGER | Epoch ms. |

**Index:** `idx_schedule_runs(name, at)` — for last-run lookups (`milo schedules`).

---

## `pending_followups` — queued follow-ups

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `job_id` | TEXT | Originating job. |
| `trigger_type` / `content_hash` / `payload` | TEXT | Follow-up descriptor. |
| `created_at` / `consumed_at` | INTEGER | Epoch ms. |

---

## `schema_meta` — versioning

`key TEXT PK, value TEXT` — holds the schema version.

---

## Inspecting the DB

```bash
sqlite3 ~/.milo/milo.db '.tables'
sqlite3 ~/.milo/milo.db 'SELECT entity_id, state, runner, pr_url FROM jobs ORDER BY created_at DESC LIMIT 20;'
sqlite3 ~/.milo/milo.db 'SELECT source, disposition, reason, received_at FROM inbound_events ORDER BY received_at DESC LIMIT 20;'
sqlite3 ~/.milo/milo.db 'SELECT * FROM repo_health;'
```

Prefer `milo jobs`, `milo status`, and the TUI for day-to-day inspection; raw SQL is for debugging.
