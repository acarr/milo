import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyLinearSignature, verifyGithubSignature, isFreshTimestamp } from "@milo/core";

const body = JSON.stringify({ hello: "world", n: 42 });
const secret = "shhh-super-secret";

test("verifyLinearSignature accepts a correct HMAC and rejects tampering", () => {
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyLinearSignature(body, sig, secret), true);
  assert.equal(verifyLinearSignature(body + " ", sig, secret), false); // body changed
  assert.equal(verifyLinearSignature(body, sig, "wrong-secret"), false);
  assert.equal(verifyLinearSignature(body, undefined, secret), false);
  assert.equal(verifyLinearSignature(body, "deadbeef", secret), false);
});

test("verifyGithubSignature requires the sha256= scheme and a matching digest", () => {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyGithubSignature(body, `sha256=${digest}`, secret), true);
  assert.equal(verifyGithubSignature(body, digest, secret), false); // missing scheme
  assert.equal(verifyGithubSignature(body, `sha1=${digest}`, secret), false); // wrong scheme
  assert.equal(verifyGithubSignature(body, `sha256=${digest}`, "nope"), false);
});

test("isFreshTimestamp enforces a tolerance window", () => {
  const now = 1_000_000_000_000;
  assert.equal(isFreshTimestamp(now, 60_000, now), true);
  assert.equal(isFreshTimestamp(now - 30_000, 60_000, now), true);
  assert.equal(isFreshTimestamp(now - 120_000, 60_000, now), false);
  assert.equal(isFreshTimestamp(undefined, 60_000, now), true); // nothing to check
});
