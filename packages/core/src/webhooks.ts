import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time compare of two hex digests (length-safe). */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a Linear webhook: `Linear-Signature` is the lowercase hex HMAC-SHA256 of the raw request
 * body, keyed by the webhook signing secret. Pass the EXACT bytes Linear sent (not re-serialized).
 */
export function verifyLinearSignature(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(digest, signature.trim());
}

/**
 * Verify a GitHub webhook: `X-Hub-Signature-256` is `sha256=<hex>` of the raw body keyed by the
 * webhook secret. Compares constant-time.
 */
export function verifyGithubSignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const [scheme, sig] = header.split("=");
  if (scheme !== "sha256" || !sig) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(digest, sig.trim());
}

/**
 * Reject webhooks whose timestamp is too old/skewed (replay protection). Linear includes
 * `webhookTimestamp` (epoch ms) in the payload; GitHub has no equivalent so callers skip this.
 */
export function isFreshTimestamp(timestampMs: number | undefined, toleranceMs = 60_000, now = Date.now()): boolean {
  if (timestampMs === undefined) return true; // nothing to check
  return Math.abs(now - timestampMs) <= toleranceMs;
}
