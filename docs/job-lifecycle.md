# Job Lifecycle

A **job** is the unit of work. SQLite is the **source of truth** — jobs are durable across restarts,
and `recoverOnStartup` requeues anything stranded by a crash. The model lives in
`packages/core/src/jobs.ts`; the per-job pipeline in `packages/core/src/pipeline.ts`.

---

## State machine

```
                         ┌──────────────────────────────────────────────┐
                         ▼                                              │ (retry w/ backoff)
  queued ─► claimed ─► setting-up ─► running ─► verifying ─┬─► remediating ─► reporting ─► done
     ▲                                                     │                              └─► discovery-done
     │                                                     ├─► reporting ─────────────────────► done
     │ (reclaim)                                           │
     └──────────────────────────────────────────────      ├─► retrying ─► (back to queued)
                                                           ├─► needs-attention
                                                           └─► abandoned   (circuit breaker)
```

### States

| Group | States |
|-------|--------|
| **Waiting** | `queued`, `claimed` |
| **Active** (hold a concurrency slot + entity lock) | `setting-up`, `running`, `verifying`, `remediating`, `reporting` |
| **Retry** | `retrying` |
| **Terminal** | `done`, `discovery-done`, `failed`, `needs-attention`, `abandoned` |

| State | Meaning |
|-------|---------|
| `queued` | Eligible to be claimed (subject to `next_eligible_at` backoff). |
| `claimed` | A worker has the lease; about to start. |
| `setting-up` | Worktree creation, issue/PR fetch, runner selection. |
| `running` | The runner (Claude/Codex) is executing, with a 30s heartbeat. |
| `verifying` | Ground-truth git/`gh` check against the runner's self-report. |
| `remediating` | Code exists but no PR (create mode) or unpushed (attach mode) — Milo fixes it. |
| `reporting` | Posting the Linear comment / agent-session response or GitHub comment. |
| `done` | Implemented + PR exists/updated. Worktree torn down. |
| `discovery-done` | Genuine investigation, no code written — correctly no PR. |
| `retrying` | Transient failure; backoff scheduled, will return to `queued`. |
| `needs-attention` | Retries exhausted or unrecoverable; worktree kept if `teardownPolicy: keep-on-failure`. |
| `abandoned` | Repo circuit breaker is open; the job was not attempted. |

---

## The queue

`JobQueue` (`queue.ts`) drains work with three guarantees, all enforced atomically by `claimNext` in SQL:

1. **Bounded concurrency** — at most `config.concurrency` (default **3**) jobs active at once.
2. **Per-entity serialization** — never two active jobs for the same `entityId`.
3. **Dependency sequencing** — an entity with an unresolved `blockedBy` gate
   (see [`job_dependencies`](./database.md#job_dependencies--blockedby-gates) and the
   [`dependencies` config](./configuration.md#dependencies)) is unclaimable until the gate lifts.

`drain()` processes everything currently runnable then returns (used by `milo <ID>` inline). The daemon
uses `runForever(shouldStop, pollMs=1500)`: fill open slots, race the in-flight jobs against a poll
tick, repeat; on stop it gracefully drains what's in flight.

A job is only **eligible** to be claimed when `next_eligible_at` (the backoff gate) has passed.

---

## Retries & backoff

On a **transient/recoverable** failure the job is scheduled to retry with exponential-ish backoff:

```
attempt 0 → 30s,  attempt 1 → 2m,  attempt 2+ → 8m
```

`max_attempts` defaults to **3**. When attempts are exhausted, the job goes to **`needs-attention`**
(not `failed`) and — if the repo's `teardownPolicy` is `keep-on-failure` — the worktree is preserved
for debugging. Failures are classified (`failure_class`): `transient-infra`, `runner-crash`, `no-pr`,
`wrong-outcome`, `unexpected`, `breaker`, `logic`.

Only genuinely *flaky* failures retry. A **deterministic** worktree-setup failure (one retrying can
never fix, e.g. the branch already checked out in another worktree, or the worktree path occupied by a
non-worktree) is classified `logic` and goes **straight to `needs-attention`** — no retries, and no
circuit-breaker accounting.

---

## Leases, heartbeats & the watchdog

To make "the worker died" reliably detectable:

- When a job is claimed it gets a **lease** (`lease_expires_at = now + 60s`).
- The pipeline wraps the **entire** active lifecycle (`claimed → reporting`) in `withHeartbeat`, which
  calls `store.heartbeat(jobId)` every **30s**, renewing the lease. So a job heartbeats for its whole
  life, not just while the runner runs.
- The daemon runs `reclaimExpiredLeases(graceMs=30s)` every **30s**. Any active job whose
  `lease_expires_at + grace < now` is requeued (`state → queued`, lease cleared, `reclaimed` event
  logged).

Because a healthy job always keeps its lease fresh, an expired lease unambiguously means the worker
died — the watchdog can requeue without risking a double-run. This is the in-process recovery; launchd
`KeepAlive` + `recoverOnStartup` cover a hard daemon crash. (An out-of-process `milo reclaim` watchdog
is a planned hardening — see `docs/REMAINING-WORK.md` B4.)

---

## The per-job pipeline

### Create mode (Linear)

1. **setting-up** — fetch the Linear issue; resolve repo (team key + labels); check the circuit
   breaker; resolve runner + model; create the worktree (`git worktree add -b <branch> origin/<base>`)
   and run setup; persist `worktree_path`, `branch`, `runner`, `model`.
2. **running** — set the issue to *In Progress* (best-effort); build the prompt (repo context + issue +
   routing + global/per-repo augmentation); run the runner under a heartbeat; parse `MILO_RESULT`.
3. **verifying** — resolve **ground truth** from git/`gh`; store the declared vs verified outcome.
4. **remediating** (if code changed but no PR) — `ensurePr`: commit/push/`gh pr create`.
5. **reporting** — post the agent-session `response`/comment and a `found_pr`/`opened_pr` action; set
   the issue to *In Review*; record an idempotent side-effect; tear the worktree down.
   - No code + `discovery` outcome + exit 0 → **discovery-done** (no PR, by design).

### Attach mode (GitHub)

1. **setting-up** — parse `owner/repo#N`; fetch the PR; require it's **open** and **same-repo**; resolve
   repo; check the breaker; `attachWorktree` to the PR's head branch (`git reset --hard origin/<head>`).
   If that branch is checked out in another worktree (e.g. the developer's tree), attach **detached** at
   the PR head instead — follow-up commits are pushed by refspec (`HEAD:<branch>`), so the developer's
   checkout is never touched.
2. **running** — extract the instruction from the latest `@milo` comment; build the attach prompt; run
   the runner under a heartbeat.
3. **verifying** — ground truth.
4. **remediating** (if code changed) — `ensurePushed`: commit + push to the **existing** branch
   (no new PR).
5. **reporting** — comment on the PR; tear the worktree down.

See [reliability.md](./reliability.md) for the verification gate and circuit breaker in depth, and
[database.md](./database.md) for the columns each transition writes.
