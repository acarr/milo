import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude, cleanEnv } from "../src/claude.js";

// The child environment and the flags the pipeline drives from `.milo/config.json`.

test("cleanEnv strips API-billing keys but passes GH_TOKEN (and everything else) through", () => {
  const saved = { ...process.env };
  try {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-leak";
    process.env["CLAUDE_CODE_SOMETHING"] = "x";
    process.env["GH_TOKEN"] = "ghs_from_the_daemon";
    process.env["CONDUCTOR_API_KEY"] = "kept";
    const env = cleanEnv();
    assert.equal(env["ANTHROPIC_API_KEY"], undefined);
    assert.equal(env["CLAUDE_CODE_SOMETHING"], undefined);
    assert.equal(env["GH_TOKEN"], "ghs_from_the_daemon", "gh inside a run must see the daemon's token");
    assert.equal(env["CONDUCTOR_API_KEY"], "kept");
    assert.match(env["PATH"] ?? "", /\/opt\/homebrew\/bin/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("runClaude passes --max-turns when set, and omits it otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-flags-"));
  const argvFile = join(dir, "argv.json");
  const stdinFile = join(dir, "stdin.txt");
  const bin = join(dir, "claude-argv");
  const line = JSON.stringify({ type: "result", is_error: false, result: "MILO_RESULT={}" });
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(stdinFile)}, fs.readFileSync(0, "utf8"));
console.log(${JSON.stringify(line)});
`,
    { mode: 0o755 },
  );
  // A realistic prompt: it embeds the worktree path, which is exactly what made a runner
  // matchable by `pkill -f "<worktree path>"` back when the prompt was an argv element.
  const prompt = "<working_directory>/Users/x/milo-worktrees/SBX-1</working_directory>";
  const base = { cwd: dir, prompt, model: "sonnet", logFile: join(dir, "run.log"), bin, guards: { resultExitGraceMs: 250, inactivityMs: 1_500, maxRunMs: 5_000 } };

  await runClaude({ ...base, maxTurns: 40 });
  let argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "40");
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  assert.ok(argv.includes("--dangerously-skip-permissions"), "headless runs keep the permission bypass");
  assert.equal(readFileSync(stdinFile, "utf8"), prompt, "the prompt is delivered on stdin");
  assert.ok(
    !argv.some((a) => a.includes("milo-worktrees")),
    "the prompt must stay OUT of argv — `ps`/`pkill -f` can read argv, and repo tooling greps it for worktree paths",
  );

  await runClaude(base);
  argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.ok(!argv.includes("--max-turns"));
  rmSync(dir, { recursive: true, force: true });
});
