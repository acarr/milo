import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

process.env["MILO_HOME"] ??= mkdtempSync(join(os.tmpdir(), "milo-ensure-pr-"));
const { ensurePr } = await import("@milo/core");

/**
 * End-to-end over the seam that produced PR #707: a real git worktree with a real origin, and a
 * fake `gh` that records the argv `ensurePr` builds. Proves the two things the live failure got
 * wrong — that an unfinished run is drafted and captioned, and that a PR Milo opens describes the
 * work even when the agent left no summary.
 */

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
};

let realPath: string | undefined;
let ghDir: string;

before(() => {
  // A `gh` that dumps its argv as JSON and prints a PR URL, shadowing the real one for this process.
  ghDir = mkdtempSync(join(os.tmpdir(), "milo-fake-gh-"));
  writeFileSync(
    join(ghDir, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv[0] === "pr" && argv[1] === "list") { console.log("[]"); process.exit(0); }
fs.writeFileSync(process.env.MILO_TEST_GH_ARGV, JSON.stringify(argv));
console.log("https://github.com/acme/repo/pull/7");
`,
    { mode: 0o755 },
  );
  realPath = process.env["PATH"];
  process.env["PATH"] = ghDir + delimiter + realPath;
});

after(() => {
  if (realPath !== undefined) process.env["PATH"] = realPath;
});

/** A worktree on `feature/x` with one commit, pushed-able to a bare origin. */
function worktree(opts: { dirty?: boolean } = {}) {
  const root = mkdtempSync(join(os.tmpdir(), "milo-ensure-"));
  const origin = join(root, "origin.git");
  const wt = join(root, "wt");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, wt]);
  git(wt, "config", "user.email", "t@t.test");
  git(wt, "config", "user.name", "T");
  writeFileSync(join(wt, "README.md"), "base\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "base");
  git(wt, "push", "-q", "-u", "origin", "main");
  git(wt, "switch", "-qc", "feature/x");
  writeFileSync(join(wt, "src.ts"), "export const a = 1;\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feat(api): add the moderation screen");
  if (opts.dirty) writeFileSync(join(wt, "extra.ts"), "export const b = 2;\n");
  return wt;
}

/** Run ensurePr and return the argv the fake `gh` was invoked with. */
function capture(input: Parameters<typeof ensurePr>[0]) {
  const argvFile = join(mkdtempSync(join(os.tmpdir(), "milo-argv-")), "argv.json");
  process.env["MILO_TEST_GH_ARGV"] = argvFile;
  const res = ensurePr(input);
  assert.ok(existsSync(argvFile), "gh pr create should have been invoked");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  return { res, argv, body: argv[argv.indexOf("--body") + 1]!, title: argv[argv.indexOf("--title") + 1]! };
}

test("a finished run opens a ready PR whose body describes the commits", () => {
  const wt = worktree();
  const { res, argv, body, title } = capture({
    worktreePath: wt,
    baseBranch: "main",
    branch: "feature/x",
    ref: "TST-9",
    title: "Add the moderation screen",
    summary: "Added the screen and tested it.",
    closes: "TST-9",
  });

  assert.equal(res.prUrl, "https://github.com/acme/repo/pull/7");
  assert.equal(res.remediated, true);
  assert.ok(!argv.includes("--draft"), "a finished run is ready for review");
  assert.equal(title, "Add the moderation screen");
  assert.match(body, /Added the screen and tested it\./);
  assert.match(body, /- feat\(api\): add the moderation screen/);
  assert.match(body, /Closes TST-9/);
});

test("an unfinished run is drafted, titled `[incomplete]`, and says why", () => {
  const wt = worktree({ dirty: true });
  const { argv, body, title } = capture({
    worktreePath: wt,
    baseBranch: "main",
    branch: "feature/x",
    ref: "WAZ-1150",
    title: "Moderation: image screening for avatars and uploaded media",
    summary: "", // exactly the live case — the run died before emitting MILO_RESULT
    closes: "WAZ-1150",
    incomplete: { reason: "API Error: Connection closed mid-response." },
  });

  assert.ok(argv.includes("--draft"), "an unfinished run must not arrive ready for review");
  assert.match(title, /^\[incomplete\] /);
  assert.match(body, /\[!WARNING\]/);
  assert.match(body, /API Error: Connection closed mid-response\./);
  // The regression this whole change exists for: the body used to be exactly "Implements WAZ-1150".
  assert.ok(!/^Implements WAZ-1150\s*$/m.test(body), "the body must not be a bare `Implements <REF>`");
  assert.match(body, /- feat\(api\): add the moderation screen/, "committed work is still described");
  assert.match(body, /## Files changed/);
});

test("the dirty tree of an unfinished run is committed as partial", () => {
  const wt = worktree({ dirty: true });
  capture({
    worktreePath: wt,
    baseBranch: "main",
    branch: "feature/x",
    ref: "TST-11",
    title: "Half a thing",
    summary: "",
    incomplete: { reason: "the runner exited 1" },
  });
  assert.match(git(wt, "log", "-1", "--format=%s"), /partial — run did not finish/);
  assert.equal(git(wt, "status", "--porcelain"), "", "nothing left uncommitted");
});

test("an existing PR is reused, never duplicated", () => {
  const wt = worktree();
  // `gh pr list` returning a PR means the agent already opened one.
  writeFileSync(
    join(ghDir, "gh"),
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "pr" && argv[1] === "list") {
  console.log(JSON.stringify([{ url: "https://github.com/acme/repo/pull/3", state: "OPEN" }]));
  process.exit(0);
}
require("fs").writeFileSync(process.env.MILO_TEST_GH_ARGV, JSON.stringify(argv));
console.log("https://github.com/acme/repo/pull/999");
`,
    { mode: 0o755 },
  );
  const argvFile = join(mkdtempSync(join(os.tmpdir(), "milo-argv-")), "argv.json");
  process.env["MILO_TEST_GH_ARGV"] = argvFile;

  const res = ensurePr({
    worktreePath: wt,
    baseBranch: "main",
    branch: "feature/x",
    ref: "TST-12",
    title: "t",
    summary: "s",
    incomplete: { reason: "died" },
  });

  assert.equal(res.prUrl, "https://github.com/acme/repo/pull/3");
  assert.equal(res.remediated, false);
  assert.ok(!existsSync(argvFile), "must not run `gh pr create` when a PR already exists");
});
