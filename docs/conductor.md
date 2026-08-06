# Conductor Cloud — the remote runner

`conductor` is Milo's third runner. Instead of spawning an agent on this machine, it creates a
**Conductor Cloud** workspace, sends the ticket as a chat message, tracks the session to completion,
and then verifies the result exactly the way it verifies a local run.

The point is that the work happens somewhere else: no local worktree setup, no `pnpm install`, no CPU,
no disk. Milo keeps the parts it is good at — owning the ticket lifecycle, guaranteeing a PR exists,
and reporting back to Linear.

---

## Selecting it

Conductor slots into the **existing** runner precedence (`packages/core/src/router.ts`), so there is no
new trigger surface:

1. `[agent=conductor]` in the issue title/description
2. a `runner:conductor` label
3. `repositories[].defaultRunner: "conductor"`
4. `runnerDefaults.default: "conductor"`

`RunnerId` says **where** the work runs. Conductor's own `agent` setting says **what** runs there
(`claude` / `codex` / `cursor`). So `runner:conductor` + `conductor.agent: "codex"` means "Codex, in
the cloud" — a combination Milo cannot express locally.

---

## The branch contract

This is the one idea the whole design rests on.

A Conductor session works in a cloud filesystem Milo cannot read. There is no diff endpoint, no git
endpoint, and no file-read endpoint in the Conductor API. So Milo does **not** ask the agent for a PR
and scrape the URL out of the transcript — that would make the PR the cross-boundary contract, with
duplicate-PR hazards and a dependency on `gh` being authenticated inside the workspace.

Instead:

> **Conductor pushes a branch. Milo opens the PR.**

The prompt (`buildConductorPrompt`) tells the agent to switch to a branch Milo names, implement, verify,
commit, `git push -u origin <branch>` — and explicitly **forbids** `gh pr create`. When the session
ends, `runConductor` fast-forwards the local worktree onto that branch:

```
git fetch origin +refs/heads/<B>:refs/remotes/origin/<B>
git reset --hard refs/remotes/origin/<B>
git branch --set-upstream-to=origin/<B> <B>
```

After which `resolveGroundTruth` sees `commitsAhead > 0`, `dirty: false`, `pushed: true`, `prUrl: null`
and the ordinary verification gate opens the PR with `Closes <ID>`. **`verify.ts` is not modified at
all.** If the agent opens a PR anyway, `gh pr list --head <branch>` finds it and `ensurePr` returns it
untouched.

The branch must be *dictated*, not inferred: Conductor derives the workspace's own branch from the
workspace name and prefixes it (observed: workspace `milo-push-probe` → branch
`conductor/milo-push-probe`), so predicting it is not viable.

### The worktree still exists — without setup

A conductor job still creates a local worktree, but with `skipSetup: true`. It is purely the working
directory for `git`/`gh` during verification. Running the repo's `setupScript` there would cost minutes
for nothing, and would hard-fail any repo whose setup needs docker.

---

## Setup

1. **Get an API key** at <https://app.conductor.build/users/api-keys> (requires the Pro plan).
2. **Store it.** Precedence: `CONDUCTOR_API_KEY` env → `$MILO_HOME/secrets/conductor.json` →
   `config.conductor.apiKey`.
3. **Add the repo to your Conductor machine.** Organization API keys launch workspaces on the org's
   machine, and it must include the repository — otherwise workspace creation fails with
   `INVALID_REQUEST: The organization's machine "…" does not include the repository …`. Do this in
   Conductor's organization settings.
4. **Record the project id.** `GET /v0/projects` lists them with their `gitRemote`; put the matching id
   in `repositories[].conductor.projectId`. Without it Milo falls back to `repositoryUrl`, which an
   organization key rejects for any repo not on the machine.
5. `milo doctor` — the `conductor` check verifies the key against `GET /me` and warns about any repo
   that selects the conductor runner without a `projectId`.

`repositories[].githubRepo` becomes **required** for a conductor repo: the remote contract is defined
entirely in terms of a GitHub branch. Milo fails the job fast (`needs-attention`, `failure_class:
logic`) rather than spending a cloud workspace on a run it could not verify.

---

## Config

```jsonc
{
  "conductor": {
    "apiKey": "…",                                  // prefer env or secrets/
    "baseUrl": "https://api.conductor.build/v0",
    "userAgent": "milo (+https://github.com/acarr/milo)",
    "agent": "claude",                              // what runs INSIDE the workspace
    "effort": "high",
    "pollMs": 15000,                                // no webhooks exist; polling only
    "dispatchTimeoutMs": 600000,
    "cleanup": { "onSuccess": "archive", "onFailure": "sleep" },
    "env": {}                                       // forwarded to the workspace — keep secrets OUT
  },
  "runnerDefaults": { "conductor": { "modelChain": ["opus-5-1m"] } },
  "repositories": [
    {
      "name": "milo-sandbox",
      "githubRepo": "octave-partners/milo-sandbox",
      "conductor": { "projectId": "…", "agent": "claude", "model": "opus-5-1m" }
    }
  ]
}
```

Conductor's model ids are agent-specific — `opus-5-1m`, `sonnet`, `haiku`… for its claude agent;
`gpt-5.5`, `gpt-5.6-sol`… for codex. An unknown model id is retried once with Conductor's default
rather than failing the job, because the enum churns on a beta API.

---

## Tracking a session

Conductor has **no webhooks**, so Milo polls (`pollMs`, default 15s).

The termination rule is subtler than it looks. Conductor reports a session as `idle` while a prompt is
still *queued*, so `idle` only means "finished" once `working` has been observed at least once. Milo
latches that (`sawWorking`) and **persists it** — a daemon restart mid-run would otherwise resume with
the latch cleared, see the `idle` between turns, and declare the run complete. There is also a
fast-turn escape hatch for a turn that starts and finishes between two polls.

Guards mirror the local runners' vocabulary: **inactivity** (25 min of transcript silence) and
**wall-clock** (3h) both cancel the session; **dispatch timeout** (10 min) gives up on a session that
never starts a turn.

### Transcripts work unchanged

Conductor runs Claude Code inside the workspace and relays its `stream-json` verbatim as
`content.rawPayload`. Milo therefore shares one mapping between the local and remote runners
(`packages/runners/src/stream-json.ts`), and `<jobId>.events.jsonl`, `milo watch`, the TUI transcript
view, and Linear progress streaming all work for remote runs with no changes.

> One real hazard, guarded in code: our own prompt is echoed back as a `userMessage`, and it contains a
> literal `MILO_RESULT={…}` **example**. If that reached `output` and the agent never emitted a real
> result line, the fallback parser would report a PR that does not exist. `userMessage`-typed messages
> are never folded into `output`, and the example pins `"prUrl": null`.

---

## Resume, retry, cancel

`recoverOnStartup` requeues in-flight jobs when the daemon starts. For a remote job that must mean
"reattach", not "launch a second cloud workspace" — so the workspace/session ids, transcript cursor and
`sawWorking` latch are persisted on the job (schema v5, `remote_*` columns). On re-dispatch the runner
checks the workspace is still alive and resumes from its cursor. Session state is persisted **before**
the prompt is sent, closing the crash window between "workspace exists" and "Milo knows about it".

- **retry** (auto or `milo retry`) clears the session so the next attempt starts fresh — resuming a
  session that already failed would just re-observe the failure. The workspace id is kept so a warm
  clone can be reused.
- **rerun** mints a new job id and therefore a brand-new workspace. Correct: a rerun should be clean.
- **cancel** (`milo cancel`) calls `POST /v0/sessions/{id}/cancel` instead of killing a local process
  group. Cancellation completes asynchronously on Conductor's side.

---

## Concurrency — parking

A Conductor job must not hold one of the (default 3) local slots for the hour its cloud session runs;
that would let a few remote runs starve all local work. So a remote run is **split in two**:

```
claimed → setting-up → running        ← dispatch: create workspace, send prompt, persist session
        → remote-waiting              ← PARKED. local slot released. tracker owns it now.
        → verifying → reporting → done ← resume: poll to completion, then the ordinary gate
```

`processJob` returns as soon as the session is live, and because the queue's cap is in-process
`inFlight` accounting (`queue.ts`), returning is what frees the slot. The daemon's **remote tracker**
(`packages/daemon/src/remote-tracker.ts`) then drives parked jobs under its own
`conductor.concurrency` cap (default 10) — waiting on HTTP costs a timer and nothing else.

Two state sets make this safe (`jobs.ts`):

| Set | Contains | Used for |
|-----|----------|----------|
| `SLOT_STATES` | claimed, setting-up, running, verifying, remediating, reporting | consumes a **local slot**; what the lease watchdog polices |
| `ENTITY_LOCK_STATES` | `SLOT_STATES` + `remote-waiting` | owns the **ticket** — a second delegation can't start a rival cloud workspace |

Consequences that are easy to get wrong, and are covered by tests:

- **`willQueue` must not count parked jobs**, or every local delegation would be told it was "queued"
  while a Conductor run happened to be waiting.
- **The lease watchdog must ignore parked jobs** — they legitimately have no local worker for hours.
  Liveness is `remote_polled_at` instead, and `reclaimStalledRemote` frees a job whose tracker died.
- **`recoverOnStartup` must leave them parked** — the remote work is still running; requeuing would
  dispatch a duplicate.
- **A cancel-requested parked job stays claimable**, because the tracker is the only thing that can
  reach the cloud session to cancel it.
- **A failed tracker tick must not requeue the job.** A transient blip (e.g. Linear returning a proxy
  error page mid-report) goes through `retryRemoteTracking`, which keeps the job parked *with its
  session*. Requeuing would clear the session and dispatch a second workspace, orphaning the one
  actually doing the work. Attempts are still counted, so a genuinely broken resume escalates.

## When the work never reaches GitHub

The one case Milo cannot mechanically fix: the agent commits in the cloud workspace but never pushes.
Milo has no filesystem access, so there is nothing local to recover.

Defences, in order:

1. **Prompt hardening** — pushing is a Critical Rule, plus a `git ls-remote --exit-code` self-check, and
   an instruction to push after the *first* commit rather than saving it for the end.
2. **Ground truth, not self-report** — the runner checks `origin` for the branch regardless of what
   `MILO_RESULT` claimed.
3. **One focused remediation message** to the same session: "run these four git commands, nothing else."
4. **Loud failure** — the job fails with the branch name, similar branches found on `origin`, and the
   workspace deep link; and cleanup is forced to **preserve** the workspace (never archive), so the work
   still exists and a human can push it.

This is the one place the guarantee is weaker than a local run, and it is worth stating precisely:

> **Any code that reached GitHub always gets a PR** — guaranteed, same strength as a local run.
> **Code that never reached GitHub** gets a bounded self-remediation attempt, then a `needs-attention`
> job, a Linear error carrying the live workspace link, and an explicitly preserved workspace. Weaker,
> and unavoidable: the Conductor API exposes no way to read that filesystem.

---

## Known limits

- **Create mode only.** Revise (`processLinearAttachJob`), GitHub attach, and scheduled prompts still
  run locally. Remote revise is architecturally *cheaper* (the workspace still has the branch and the
  context — it's one more message) and is the obvious next step.
- **Branch mismatch is unrecoverable.** If the agent pushes to a different branch, Milo says so and
  names the candidates, but cannot auto-heal — renaming a remote branch would orphan any PR pointing at
  the old one. `git push origin <theirs>:<B>` + `milo retry` fixes it.
- **A Conductor outage trips the per-repo circuit breaker**, because `transient-infra` is keyed on the
  repo. Right instinct, wrong attribution; a service-keyed breaker is the fix.
- **The API is beta.** Response shapes may move; the client tolerates unknown fields and degrades
  rather than failing a job over a cosmetic one.
