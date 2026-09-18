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
  const bin = join(dir, "claude-argv");
  const line = JSON.stringify({ type: "result", is_error: false, result: "MILO_RESULT={}" });
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log(${JSON.stringify(line)});
`,
    { mode: 0o755 },
  );
  const base = { cwd: dir, prompt: "p", model: "sonnet", logFile: join(dir, "run.log"), bin, guards: { resultExitGraceMs: 250, inactivityMs: 1_500, maxRunMs: 5_000 } };

  await runClaude({ ...base, maxTurns: 40 });
  let argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "40");
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  assert.ok(argv.includes("--dangerously-skip-permissions"), "headless runs keep the permission bypass");
  assert.equal(argv[argv.length - 1], "p", "the prompt stays the final positional arg");

  await runClaude(base);
  argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  assert.ok(!argv.includes("--max-turns"));
  rmSync(dir, { recursive: true, force: true });
});
