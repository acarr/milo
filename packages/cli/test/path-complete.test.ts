import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { completePath } from "../src/init/path-complete.js";

function fixture(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "milo-complete-"));
  mkdirSync(join(dir, "alpha"));
  mkdirSync(join(dir, "alphabet"));
  mkdirSync(join(dir, "beta"));
  mkdirSync(join(dir, ".hidden"));
  writeFileSync(join(dir, "alphafile"), ""); // files never complete (paths here are directories)
  return dir;
}

test("completePath completes an ambiguous prefix to the longest common prefix and lists candidates", () => {
  const dir = fixture();
  const r = completePath(join(dir, "al"));
  assert.equal(r.completed, join(dir, "alpha"), "advanced to the common prefix");
  assert.deepEqual(r.candidates, ["alpha", "alphabet"]);
});

test("completePath completes a unique prefix fully, with a trailing slash", () => {
  const dir = fixture();
  const r = completePath(join(dir, "b"));
  assert.equal(r.completed, join(dir, "beta") + "/");
  assert.deepEqual(r.candidates, []);
});

test("completePath on a trailing slash lists the directory's children without changing the input", () => {
  const dir = fixture();
  const r = completePath(dir + "/");
  assert.equal(r.completed, dir + "/", "input unchanged — nothing to advance");
  assert.deepEqual(r.candidates, ["alpha", "alphabet", "beta"], "hidden dirs excluded");
});

test("completePath only offers hidden directories when the prefix asks for them", () => {
  const dir = fixture();
  const r = completePath(join(dir, ".h"));
  assert.equal(r.completed, join(dir, ".hidden") + "/");
});

test("completePath is a no-op for a missing directory or empty input", () => {
  const dir = fixture();
  const missing = join(dir, "nope", "deeper");
  assert.deepEqual(completePath(missing), { completed: missing, candidates: [] });
  assert.deepEqual(completePath(""), { completed: "", candidates: [] });
  assert.deepEqual(completePath("   "), { completed: "   ", candidates: [] });
});

test("completePath expands ~ to the home directory", () => {
  const r = completePath("~/");
  assert.ok(r.completed.startsWith(os.homedir()), "tilde expanded");
  assert.ok(!r.completed.includes("~"), "no literal tilde left");
});
