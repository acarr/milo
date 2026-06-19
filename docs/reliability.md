# Reliability

Milo exists to be a *more reliable* autonomous agent. Two failure modes must **never** regress; the
rest of this document is the machinery that protects them.

## The two sacred invariants

### 1. It must never silently fail to start
Triggers arrive via a **polling reconciler that is the system of record** — webhooks are only an
accelerator layered on top. A dropped webhook costs at most one poll interval (~90s Linear / ~120s
GitHub), never a lost ticket. See [triggers.md](./triggers.md).

### 2. It must never leave written code without a PR
A post-run **verification gate** checks real git/`gh` state — not the agent's self-report — and opens
the PR itself if the agent wrote code but didn't. Genuine discovery-only tasks are distinguished and
correctly produce no PR.

Everything below hardens these: bounded concurrency + per-entity serialization, idempotent enqueue, a
per-repo circuit breaker, and a lease watchdog.

---

## The verification gate

`packages/core/src/verify.ts`. After the runner finishes, Milo **never trusts the runner's
self-report**. It resolves the authoritative state and acts on *that*.

### `resolveGroundTruth(worktree, baseBranch, branch) → GroundTruth`

| Field | How it's computed |
|-------|-------------------|
| `commitsAhead` | `git rev-list --count origin/<base>..HEAD` (or local base if no upstream) |
| `dirty` | `git status --porcelain` non-empty |
| `codeChanged` | `commitsAhead > 0` **or** `dirty` |
| `pushed` | `git rev-list --count @{u}..HEAD == 0` (nothing unpushed) |
| `prUrl` / `prState` | `gh pr list --head <branch> --state all --json url,state` (newest) |

### `ensurePr(...)` — create mode
The guarantee that written code gets a PR:

1. Resolve ground truth.
2. PR already exists → return it (`remediated: false`).
3. No PR but code changed → `git add -A` (if dirty), `git commit`, `git push -u origin HEAD`,
   `gh pr create --base <base> --head <branch> --title … --body "<summary>\n\nCloses <ref>\n\n_PR opened by Milo's verification gate._"`,
   then return the URL (`remediated: true`).

### `ensurePushed(...)` — attach mode
The PR already exists; just make sure follow-up work lands on its branch: commit if dirty, then
`git push origin HEAD` (which updates the open PR). No PR creation.

### Discovery vs. omission
- **No code + `discovery` outcome + clean exit** → `discovery-done`, no PR. Correct and expected.
- **Code present + no PR** → remediated into a PR. The agent's omission cannot lose work.

> Today the gate is the **mechanical** backstop (`ensurePr` does the git/`gh` itself). A planned
> follow-up (REMAINING-WORK B1) adds a *focused-runner* remediation cycle first ("commit, push, open
> the PR, nothing else") so the agent can supply a better message/body before the mechanical fallback.

---

## Per-repo circuit breaker

`jobs.ts` (`recordRepoInfraFailure`, `isRepoBreakerOpen`, `repoHealth`, `recordRepoSuccess`); state in
the `repo_health` table, keyed on `repo.name`.

```
closed ──(5 consecutive infra failures)──► open ──(30m cooldown elapses)──► half-open
   ▲                                                                            │
   │ (probe succeeds)                                                           │ (probe fails)
   └──────────────────────────── (next job is the probe) ──────────────────────┘──► open
```

- Only **`transient-infra`** failures increment the counter. **Any** success calls
  `recordRepoSuccess`, resetting the counter to 0 and the state to `closed`.
- **Deterministic precondition failures never count.** A worktree-setup error that retrying can't fix
  (e.g. `'<branch>' is already used by worktree at '<path>'` — the PR branch is checked out in the
  developer's tree) is classified by `isPermanentWorktreeError` and goes straight to
  **`needs-attention`** (`failure_class: logic`) with **no retries and no breaker accounting**.
  In attach mode this case usually doesn't even fail: `attachWorktree` falls back to a **detached
  worktree** at the PR head and pushes follow-ups by refspec (`HEAD:<branch>`), so Milo can revise a
  PR even while its branch is checked out elsewhere.
- At **5** consecutive infra failures the breaker **opens**: `cooldownUntil = now + 30m`.
- `repoHealth()` lazily flips `open → half-open` once the cooldown elapses, so the **next job becomes
  the probe**. A successful probe closes it; a failed probe re-opens for another 30m.
- While open, a new job for that repo is sent to **`abandoned`** with a single idempotent notice
  ("Milo paused work on this repo"), keyed on `breaker:<repo>:<openedAt>` so it's posted only once.

This stops a broken repo (bad credentials, gone-away remote, wedged setup script) from burning every
incoming ticket.

---

## Lease watchdog & heartbeats

Covered in detail in [job-lifecycle.md](./job-lifecycle.md#leases-heartbeats--the-watchdog). The key
invariant: a job heartbeats (every **30s**) for its **entire** active lifecycle, renewing a **60s**
lease. The daemon's `reclaimExpiredLeases(grace=30s)` runs every 30s and requeues any active job whose
lease expired — which, given the lifecycle-wide heartbeat, reliably means the worker died. No restart
needed; no risk of double-running a healthy job.

---

## Idempotency

- **Enqueue** is idempotent on the identity key (`source:entityId:triggerType:contentHash`) — a webhook
  and a poll for the same work collapse into one job. See [triggers.md](./triggers.md#identity--deduplication).
- **External writes** (PR creation, comments, state changes, breaker notices, reports) are guarded by a
  `side_effects` ledger keyed on an idempotency key, so a retried job doesn't double-post.

---

## Recovery layers (defense in depth)

| Failure | Covered by |
|---------|-----------|
| Transient infra hiccup | retry with backoff (30s/2m/8m) |
| Repeatedly broken repo | circuit breaker (open 30m, half-open probe) |
| Worker died mid-job | lease watchdog (requeue after lease + 30s grace) |
| Daemon process crashed | launchd `KeepAlive` + `recoverOnStartup` requeues stranded jobs |
| Agent wrote code, no PR | verification gate opens the PR |
| Missed/dropped webhook | polling reconciler (system of record) |
| Runner finished but never exited (hung MCP children) | run guard: result-exit grace → kill process group, run still succeeds |
| Runner hung silent / running forever | run guards: inactivity (~20 min) + wall-clock cap (~3h) → kill process group, verification gate decides the outcome |

> Runners spawn `detached` so each leads its own process group — a guard kill takes out the CLI
> **and** everything it spawned (MCP servers, shells, dev servers). See `packages/runners/src/guards.ts`.
