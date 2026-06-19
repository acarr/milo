# Milo — Remaining Work

_Last updated: 2026-05-31. Phases 0–6 + the two headline reliability follow-ups (circuit breaker,
lease watchdog) are shipped and on `main`. Everything below is **optional** — Milo is fully usable
today via the `milo` label, `@milo` PR mentions, the CLI, and schedules._

Priority legend: **P1** = do soon / clear value · **P2** = worth doing · **P3** = nice-to-have.
Effort is rough developer-time on top of the current codebase.

---

## A. Operational activation (no code — only you can do these)

### A1. Enable the webhook accelerator · **P2** · ~15 min
The HTTP ingress, signature verification, and trust gate are built and unit-tested, but **off by
default** (`webhook.enabled: false`, so the daemon binds no port). To turn it on:

1. `bash scripts/setup-funnel.sh` — maps Tailscale Funnel `:8443 → 127.0.0.1:3457` (touches only the
   `:8443` mapping; never resets any other tool's `:443`).
2. In `~/.milo/config.json` set `webhook.enabled: true` and `trust.webhookSecrets.{linear,github}`.
3. Register the webhooks:
   - Linear → `https://<node>.<tailnet>.ts.net:8443/webhooks/linear` (subscribe to Agent session
     events), signing secret = `trust.webhookSecrets.linear`.
   - GitHub → `…/webhooks/github` (PR + issue_comment events), secret = `trust.webhookSecrets.github`.
4. Optionally tighten `trust.linearActors` / `trust.githubActors` (empty = allow all).
5. Restart the daemon; confirm a signed event returns 200 and a tampered one returns 401.

**Why:** drops trigger latency from one poll interval (~90s Linear / ~120s GitHub) to seconds. Polling
still backstops, so this is purely an accelerator.

### A2. Install the launchd agent (if not already) · **P2** · ~5 min
`bash scripts/install-launchd.sh` writes `~/start-milo.sh` + `com.milo.daemon.plist` (RunAtLoad +
KeepAlive) so the daemon survives logout/reboot/crash. Today the daemon is started by hand
(`milo daemon`). **Why:** "never silently fails to start" wants the daemon itself to be always-on.

### A3. Clean up the SBX test artifacts · **P3** · ~5 min
Sandbox PRs **#5–#7** and tickets **SBX-5/6/7** (In Review) are leftover live-test artifacts. Merging
each PR auto-closes its Linear ticket via `Closes SBX-N`. Or close them if you don't want the changes.

---

## B. Reliability hardening (code)

### B1. Focused-runner remediation cycle · **P1** · ~0.5 day
The plan called for a **two-cycle** remediation when code was written but no PR exists: (1) a focused
runner invocation — "commit, push, open the PR, nothing else"; (2) Milo runs `gh pr create` itself.
Today only cycle 2 ships (`ensurePr` in `verify.ts` does the git/`gh` directly). Cycle 1 lets the agent
fix its own omission (better commit message / PR body) before the mechanical fallback.

- **Where:** `core/pipeline.ts` (the `gt.codeChanged && !gt.prUrl` branch) + a focused prompt in
  `core/prompt.ts`; reuse the existing runner registry.
- **Risk:** low — cycle 2 remains the guaranteed backstop, so a failed cycle 1 changes nothing.

### ~~B2. Runaway-runner wall-clock kill~~ · ✅ **DONE (MILO-16)**
Shipped as **run guards** (`runners/guards.ts`): every runner spawns `detached` (its own process
group) and is watched by three guards that kill the whole tree — **result-exit grace** (the CLI
emitted its final result but didn't exit within ~30s → kill, run still counts as success),
**inactivity** (~20 min with no output → kill), and **wall clock** (~3h cap → kill). No abort handle
or pipeline change was needed — the guards live inside `runClaude`/`runCodex`, and the verification
gate already derives the real outcome from git/GitHub state after any kill. Hit live 2026-06-02:
two finished `claude -p` runs hung 4.5h because their MCP-server children kept them alive.

### B3. Multi-model fallback chain actually exercised · **P2** · ~0.5 day
`runnerDefaults.{claude,codex}.modelChain` is defined (e.g. `opus → sonnet → haiku`) but only the
**first** model is ever used (`router.modelFor` returns `chain[0]`). On a runner crash / model-overload
error, fall back to the next model in the chain before consuming a generic retry.

- **Where:** `core/pipeline.ts` failure classification + a model index on the job (new column or
  reuse `attempts`); `router.ts`.
- **Risk:** low.

### B4. Out-of-process watchdog · **P3** · ~0.5 day
Today the lease watchdog runs *inside* the daemon, so it can't help if the whole daemon event loop
hangs (launchd KeepAlive + `recoverOnStartup` cover a hard crash). The plan wanted a separate launchd
timer (`com.milo.daemon-watchdog.plist`, ~60s) calling a `milo reclaim` command against the shared DB.

- **Where:** new `milo reclaim` CLI command wrapping `store.reclaimExpiredLeases()`; a second plist in
  `scripts/install-launchd.sh`.
- **Risk:** low (the reclaim logic is already tested).

---

## C. Feature / coverage gaps (code)

### C1. Cross-repo (fork) attach mode · **P2** · ~0.5 day
Attach mode only handles **same-repo** PR branches (it fetches `origin/<head>`). Fork PRs are currently
sent to `needs-attention`. Support them via `gh pr checkout <n>` (which adds the fork remote) inside the
worktree, and push back to the contributor's branch where permitted.

- **Where:** `core/worktree.ts` (`attachWorktree`) + `core/github.ts`; the pipeline already flags
  `isCrossRepository`.
- **Risk:** medium — fork push permissions vary; may need to fall back to a comment-only review.

### C2. Secrets migration (`config.json` → `~/.milo/secrets/`) · **P2** · ~0.5 day
Linear OAuth tokens still live in `config.json`. The plan wanted them in `~/.milo/secrets/*.json`
(0600) so dashboards/exports/git never see them, with transparent 401 refresh (already implemented in
`linear.ts`). Webhook secrets (added in Phase 6) should move there too.

- **Where:** `core/config.ts` load/migrate + `core/linear.ts` token persistence + a `secretsDir()`
  reader (the path helper already exists).
- **Risk:** low-medium — must keep backward-compat with the existing in-config tokens.

### C3. TUI "Why didn't it start?" + Health panels · **P2** · ~0.5 day
The data is already captured — `inbound_events` (created/deduped/ignored/rejected + reason) and
`repo_health` (circuit-breaker state) — but the TUI only shows jobs + schedules. Add the two panels the
plan envisioned so a missed/blocked trigger is explainable at a glance.

- **Where:** `cli/src/ui.tsx` + small `JobStore` read helpers (`listInbound`, `listRepoHealth`).
- **Risk:** low.

### C4. Sub-10s agent-session acknowledgement · **P2** · depends on A1
Linear marks a delegated agent session `stale` if the agent doesn't respond within ~10s. Under polling
(~90s) Milo always acks late (it still posts the full thought→response, which revives the session, but
the UI flashes "stale" first). Once webhooks are on (A1), ack instantly on the `AgentSessionEvent`
before the worktree is even set up.

- **Where:** `daemon/webhook-server.ts` → emit an immediate `agentThought` on receipt.
- **Risk:** low.

---

## D. Nice-to-haves · **P3**

- **HTTP `/api` + SSE (Fastify).** Only needed if a non-CLI surface (web dashboard, remote control)
  is ever wanted. The TUI/CLI read SQLite directly today, so this is unbuilt by design.
- **Per-surface prompt augmentation.** `promptAugmentation` is global + per-repo; the plan also
  imagined per-surface (Linear vs GitHub vs schedule) layering.
- **`milo cancel <id>` / `milo retry <id>`.** Manual job controls (the plan listed them; not yet built).
- **Slack / WhatsApp transports.** Explicitly **stub-only / never ship** per the plan.

---

## Suggested order

1. **A2** (always-on daemon) and **A3** (clean up test PRs) — quick, operational.
2. **B1** (focused remediation) and **B2** (runaway kill) — close the two real reliability gaps.
3. **A1 + C4** (webhooks + instant ack) — biggest UX win for the Linear agent chat.
4. **C2** (secrets) and **C3** (TUI panels) — hygiene + observability.
5. Everything else as needed.

Each item is independently shippable. Keep the two invariants sacred: **never silently fail to start**
and **never leave written code without a PR** — both are covered today and any change here must keep
the verification gate and poll-backstop intact.
