# Webhooks (the accelerator)

Webhooks are an **opt-in latency accelerator** layered on top of polling — never the source of truth.
They drop trigger latency from one poll interval (~90s Linear / ~120s GitHub) to seconds. **Polling
always backstops**, and a webhook + a poll for the same work collapse into one job via the shared
identity key. When `webhook.enabled` is `false` (the default), the daemon binds **no** port at all.

Server: `packages/daemon/src/webhook-server.ts`. Signature verification:
`packages/core/src/webhooks.ts`. Normalizers: `packages/transports/src/webhooks.ts`.

---

## The HTTP ingress

When enabled, the daemon binds an HTTP server on `config.webhook.host:config.webhook.port`
(default **`127.0.0.1:3457`**) with two routes:

| Route | Method | Source events |
|-------|--------|---------------|
| `POST /webhooks/linear` | POST | `AgentSessionEvent` (delegation) only |
| `POST /webhooks/github` | POST | `pull_request`, `issue_comment` |

Response codes: `200` (enqueued **or** intentionally ignored), `401` (bad signature / stale timestamp),
`403` (actor not on the allowlist), `400` (parse error), `405` (wrong method), `413` (payload > 5 MB),
`404` (unknown path).

### Linear flow
1. Verify the `Linear-Signature` header — lowercase-hex `HMAC-SHA256(rawBody, trust.webhookSecrets.linear)`,
   compared constant-time. (Signed over the **raw** body bytes.)
2. Check timestamp freshness — `webhookTimestamp` within **±60s** (`isFreshTimestamp`) — replay window.
3. `normalizeLinearWebhook` → only `AgentSessionEvent` (delegation) yields an intent; label changes are
   left to polling.
4. Actor gate against `trust.linearActors` (empty = allow all).
5. Enqueue via the same path as the poller (`issue.delegate`), or ignore. Create-mode Linear jobs
   enqueue with a **dependency hold** (`dependencies.holdMs`, default 60s): the job is
   unclaimable until the ingress-triggered `syncDependencies` records its `blockedBy` edges and
   releases the hold. This is what keeps two issues delegated together (a blocker and its dependent)
   from racing into parallel runs — webhook delivery order doesn't matter; if Linear can't be
   reached, the hold simply expires into the parallel fallback.

### GitHub flow
1. Verify `X-Hub-Signature-256: sha256=<hex>` — `HMAC-SHA256(rawBody, trust.webhookSecrets.github)`,
   constant-time. (GitHub sends no timestamp, so the freshness check is a no-op.)
2. `normalizeGithubWebhook` → `pull_request` with the `milo` label (`pr.label`) or `issue_comment` with
   an `@milo` mention on a PR (`pr.mention`).
3. Actor gate against `trust.githubActors`.
4. Enqueue (attach mode) or ignore.

Every receipt is recorded in `inbound_events` with its disposition (`created` / `deduped` / `rejected` /
`dropped`) and a reason.

---

## Trust model

`config.trust` (see [configuration.md](./configuration.md#trust)):

- **`webhookSecrets.{linear,github}`** — the HMAC signing secrets. Without the matching secret a request
  is rejected `401`. These are required for webhooks to do anything.
- **`linearActors` / `githubActors`** — allowlists of who may trigger via webhooks. **Empty = allow
  all**; populate them to restrict to specific people.
- **`autoMerge`** — reserved, not implemented.

The defense is: HMAC verify (authenticity + integrity) → timestamp freshness (replay) → actor allowlist
(authorization) → normalize → enqueue.

---

## Setup (the manual activation steps)

Webhooks are built and unit-tested but **off by default**. To turn them on:

1. **Expose the port via Tailscale Funnel:**
   ```bash
   bash scripts/setup-funnel.sh
   ```
   This maps Funnel `:8443 → 127.0.0.1:3457` (reading the port from `config.json`). It touches **only**
   the `:8443` mapping — it never runs `tailscale funnel reset`, so any other tool's `:443` is untouched.
   (`bash scripts/setup-funnel.sh off` removes just that mapping.) It prints the public URLs when done.

2. **Edit `~/.milo/config.json`:**
   ```json
   {
     "webhook": { "enabled": true, "host": "127.0.0.1", "port": 3457 },
     "trust": { "webhookSecrets": { "linear": "…", "github": "…" } }
   }
   ```

3. **Register the webhooks:**
   - **Linear** → `https://<node>.<tailnet>.ts.net:8443/webhooks/linear`, subscribe to **Agent session
     events**, signing secret = `trust.webhookSecrets.linear`.
   - **GitHub** → `…/webhooks/github`, subscribe to **Pull request** + **Issue comment** events, secret
     = `trust.webhookSecrets.github`.

4. *(Optional)* tighten `trust.linearActors` / `trust.githubActors`.

5. **Restart the daemon.** Verify: a correctly signed event returns `200` and enqueues; a tampered one
   returns `401`; a non-allowlisted actor returns `403`.

> **Planned follow-up (REMAINING-WORK C4):** once webhooks are on, emit an immediate `agentThought` on
> receipt of an `AgentSessionEvent` so Linear's ~10s "stale" timer never fires (sub-10s acknowledgement).
