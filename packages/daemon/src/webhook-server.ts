import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  verifyLinearSignature,
  verifyGithubSignature,
  isFreshTimestamp,
  dependencyHold,
  makeDependencySyncTrigger,
  logger,
  type JobStore,
  type LinearClient,
  type MiloConfig,
} from "@milo/core";
import { normalizeLinearWebhook, normalizeGithubWebhook, intentToNewJob, type JobIntent } from "@milo/transports";
import { postQueuedAckIfWaiting } from "./queued-ack.js";

export interface WebhookDeps {
  config: MiloConfig;
  store: JobStore;
  linear: LinearClient;
}

function readRawBody(req: IncomingMessage, maxBytes = 5_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Empty allowlist = no gate; otherwise the actor must be present. */
function actorAllowed(allow: string[], actor: string | undefined): boolean {
  if (!allow.length) return true;
  return actor ? allow.includes(actor) : false;
}

/**
 * The webhook accelerator: a tiny HTTP server on 127.0.0.1:<port> exposing /webhooks/{linear,github}.
 * Every request is signature-verified, actor-gated, normalized, and enqueued into the same durable
 * queue the pollers feed — so a webhook just lowers latency; polling remains the system of record.
 * Bound to localhost; a Tailscale Funnel (8443→port) is the only public surface (see scripts/).
 */
export function startWebhookServer(deps: WebhookDeps): () => void {
  const { config, store, linear } = deps;
  const { host, port } = config.webhook;
  const secrets = config.trust.webhookSecrets;
  // Dependency discovery for webhook-ingested work (MILO-15). The poller's syncDependencies never
  // sees a webhook job before the queue can claim it, so the ingress must trigger its own sync;
  // the enqueue-time hold below keeps the job unclaimable until that sync accounts for its blockers.
  const syncDeps = makeDependencySyncTrigger({ config, store, linear });

  const enqueueIntent = (channel: string, intent: JobIntent, rawEventId?: string): number => {
    const allow = intent.source === "linear" ? config.trust.linearActors : config.trust.githubActors;
    if (!actorAllowed(allow, intent.actor)) {
      store.recordInbound({
        source: intent.source,
        channel,
        payload: intent,
        disposition: "rejected",
        reason: `actor not allowlisted: ${intent.actor ?? "unknown"}`,
      });
      logger.warn({ source: intent.source, actor: intent.actor, entity: intent.entityId }, "webhook rejected — actor not allowlisted");
      return 403;
    }
    const { job, disposition } = store.enqueue({
      ...intentToNewJob(intent),
      holdUntil: dependencyHold(config, intent),
    });
    store.recordInbound({
      source: intent.source,
      channel,
      payload: intent,
      identityKey: job.identityKey,
      jobId: job.id,
      disposition,
      reason: rawEventId,
    });
    logger.info({ source: intent.source, entity: intent.entityRef ?? intent.entityId, disposition, jobId: job.id }, "webhook enqueued");
    // Record/reconcile blockedBy edges for the just-enqueued work, then release its hold.
    if (disposition === "created" && intent.source === "linear") syncDeps();
    // Tell a delegation it's waiting — but only if it actually will (never claims it has started).
    postQueuedAckIfWaiting(store, linear, config, intent, disposition);
    return 200;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (code: number, body = "") => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(body);
    };
    if (req.method !== "POST") return send(405, "method not allowed");
    const url = req.url ?? "";
    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch {
      return send(413, "payload too large");
    }

    try {
      if (url.startsWith("/webhooks/linear")) {
        const sig = req.headers["linear-signature"] as string | undefined;
        if (!secrets.linear || !verifyLinearSignature(raw, sig, secrets.linear)) {
          store.recordInbound({ source: "linear", channel: "webhook", payload: raw.toString("utf8").slice(0, 2000), disposition: "rejected", reason: "bad signature" });
          return send(401, "bad signature");
        }
        const payload = JSON.parse(raw.toString("utf8"));
        // `AgentSessionEvent` is a delegation / agent-session hand-off. Linear retries late deliveries
        // (its own servers, plus a momentarily busy daemon, can push delivery minutes past
        // `webhookTimestamp`), and a 401 makes Linear ERROR the session — which `pendingAgentSessions`
        // can no longer re-surface (it returns status:"pending" only), so the work is lost for good.
        // Signature verification (above) + identity-key dedupe (contentHash `session:<id>`, shared with
        // the poll backstop) already make replay a no-op, so freshness adds ~nothing here. Enqueue the
        // delegation regardless of age. NB: follow-up *revisions* ride the poller's `prompt:<id>` path
        // (LinearClient.pendingFollowupPrompts), not this normalizer, so this stays regression-free.
        const isAgentSession = payload?.type === "AgentSessionEvent";
        if (!isAgentSession && !isFreshTimestamp(payload.webhookTimestamp)) {
          // A stale non-delegation event: skip it, but ACK with 200 (not 401) so Linear stops retrying
          // and never errors a session over a delivery that was merely late. Recorded for audit.
          store.recordInbound({ source: "linear", channel: "webhook", payload, disposition: "rejected", reason: "stale timestamp" });
          return send(200, "stale-ignored");
        }
        const intent = normalizeLinearWebhook(payload, config);
        if (!intent) {
          store.recordInbound({ source: "linear", channel: "webhook", payload: { type: payload.type, action: payload.action }, disposition: "ignored" });
          return send(200, "ignored");
        }
        return send(enqueueIntent("webhook", intent), "ok");
      }

      if (url.startsWith("/webhooks/github")) {
        const sig = req.headers["x-hub-signature-256"] as string | undefined;
        if (!secrets.github || !verifyGithubSignature(raw, sig, secrets.github)) {
          store.recordInbound({ source: "github", channel: "webhook", payload: raw.toString("utf8").slice(0, 2000), disposition: "rejected", reason: "bad signature" });
          return send(401, "bad signature");
        }
        const event = (req.headers["x-github-event"] as string | undefined) ?? "";
        const payload = JSON.parse(raw.toString("utf8"));
        const intent = normalizeGithubWebhook(event, payload, config);
        if (!intent) {
          store.recordInbound({ source: "github", channel: "webhook", payload: { event, action: payload.action }, disposition: "ignored" });
          return send(200, "ignored");
        }
        const delivery = req.headers["x-github-delivery"] as string | undefined;
        return send(enqueueIntent("webhook", intent, delivery), "ok");
      }

      return send(404, "not found");
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, "webhook handler error");
      return send(400, "bad request");
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(port, host, () => {
    logger.info({ host, port }, "webhook server listening (accelerator; polling still backstops)");
  });
  server.on("error", (err) => logger.error({ err: err.message, host, port }, "webhook server error"));

  return () => server.close();
}
