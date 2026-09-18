import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRepoConfig,
  readRepoConfig,
  renderWorkflow,
  prLabelsFor,
  modelOverrideFor,
  verifyCommandsFor,
  globToRegExp,
  RepoMiloConfigSchema,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from "@milo/core";

/** A temp repo with an optional `.milo/config.json` + workflow files. */
function makeRepo(configJson: string | null, files: Record<string, string> = {}): string {
  const repoDir = mkdtempSync(join(tmpdir(), "milo-repo-config-"));
  mkdirSync(join(repoDir, ".milo", "workflows"), { recursive: true });
  if (configJson !== null) writeFileSync(join(repoDir, ".milo", "config.json"), configJson);
  for (const [name, body] of Object.entries(files)) {
    const p = join(repoDir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return repoDir;
}

const WAZZON_CONFIG = {
  version: 1,
  workflows: { linearIssue: "workflows/linear-issue.md", attach: "workflows/attach.md", schedule: null },
  labels: ["agent-authored"],
  classLabelFromTicket: true,
  verifyCommand: "pnpm typecheck",
  verifyByPath: [
    { paths: ["packages/ios/**"], command: "make test-ios-unit" },
    { paths: ["packages/android/**"], command: "make test-android-unit" },
  ],
  model: { default: "opus", byLabel: { "class:chore": "sonnet" } },
  maxTurns: null,
};

test("a repo with no .milo/config.json gets the defaults — today's behaviour", () => {
  const repo = makeRepo(null);
  const r = getRepoConfig(repo);
  assert.equal(r.path, undefined);
  assert.deepEqual(r.workflows, {});
  assert.deepEqual(r.config.labels, []);
  assert.equal(r.config.classLabelFromTicket, false);
  assert.equal(r.config.verifyCommand, undefined);
  assert.deepEqual(r.config.verifyByPath, []);
  assert.equal(r.config.verifyTimeoutMs, DEFAULT_VERIFY_TIMEOUT_MS);
  assert.equal(r.config.maxTurns, undefined);
  assert.deepEqual(r.config.model, { byLabel: {} });
  assert.deepEqual(readRepoConfig(repo), r);
});

test("the contract config parses, and workflow files resolve relative to <repo>/.milo/", () => {
  const repo = makeRepo(JSON.stringify(WAZZON_CONFIG), {
    ".milo/workflows/linear-issue.md": "## Phase 1\nDo the thing for {{ISSUE_ID}}.\n",
    ".milo/workflows/attach.md": "Revise PR #{{PR_NUMBER}}.",
  });
  const r = getRepoConfig(repo);
  assert.equal(r.path, join(repo, ".milo", "config.json"));
  assert.equal(r.workflows.linearIssue, "## Phase 1\nDo the thing for {{ISSUE_ID}}.");
  assert.equal(r.workflows.attach, "Revise PR #{{PR_NUMBER}}.");
  assert.equal(r.workflows.schedule, undefined, "null means built-in");
  assert.equal(r.config.verifyCommand, "pnpm typecheck");
  assert.equal(r.config.verifyByPath.length, 2);
  assert.equal(r.config.model.default, "opus");
  assert.equal(r.config.model.byLabel["class:chore"], "sonnet");
  assert.equal(r.config.maxTurns, null);
});

test("a relative workflow path also resolves from the repo root, and an absolute one as-is", () => {
  const abs = join(mkdtempSync(join(tmpdir(), "milo-abs-wf-")), "wf.md");
  writeFileSync(abs, "absolute body");
  const repo = makeRepo(JSON.stringify({ workflows: { linearIssue: "docs/milo.md", attach: abs } }), {
    "docs/milo.md": "root-relative body",
  });
  const r = readRepoConfig(repo);
  assert.equal(r.workflows.linearIssue, "root-relative body");
  assert.equal(r.workflows.attach, "absolute body");
});

test("getRepoConfig never throws: malformed JSON → defaults; a missing workflow → built-in for that key only", () => {
  const bad = makeRepo("{ nope");
  assert.deepEqual(getRepoConfig(bad).config, RepoMiloConfigSchema.parse({}));

  const badSchema = makeRepo(JSON.stringify({ labels: "not-an-array" }));
  assert.deepEqual(getRepoConfig(badSchema).config.labels, []);

  const missingWf = makeRepo(JSON.stringify({ workflows: { linearIssue: "workflows/absent.md", attach: "workflows/attach.md" }, labels: ["x"] }), {
    ".milo/workflows/attach.md": "attach body",
  });
  const r = getRepoConfig(missingWf);
  assert.equal(r.workflows.linearIssue, undefined);
  assert.equal(r.workflows.attach, "attach body");
  assert.deepEqual(r.config.labels, ["x"], "the rest of the config still applies");
});

test("readRepoConfig is strict: it throws on malformed config and on a missing workflow file", () => {
  assert.throws(() => readRepoConfig(makeRepo("{ nope")), /JSON/);
  assert.throws(() => readRepoConfig(makeRepo(JSON.stringify({ workflows: { linearIssue: "workflows/absent.md" } }))), /not found/);
  assert.throws(() => readRepoConfig(makeRepo(JSON.stringify({ workflows: { linearIssue: "workflows/empty.md" } }), { ".milo/workflows/empty.md": "  \n" })), /empty/);
});

test("renderWorkflow substitutes known placeholders and leaves unknown ones alone", () => {
  const out = renderWorkflow("{{ISSUE_ID}} on {{BRANCH}} from {{BASE_BRANCH}} in {{REPO}} at {{WORKING_DIRECTORY}}; PR {{PR_NUMBER}}; {{UNKNOWN}} {{ISSUE_ID}}", {
    ISSUE_ID: "WAZ-1",
    BRANCH: "feature/waz-1-x",
    BASE_BRANCH: "main",
    REPO: "wazzon",
    WORKING_DIRECTORY: "/wt/WAZ-1",
    PR_NUMBER: 42,
  });
  assert.equal(out, "WAZ-1 on feature/waz-1-x from main in wazzon at /wt/WAZ-1; PR 42; {{UNKNOWN}} WAZ-1");
  // An undefined var is treated as unknown (left in place), not rendered as "undefined".
  assert.equal(renderWorkflow("PR {{PR_NUMBER}}", { PR_NUMBER: undefined }), "PR {{PR_NUMBER}}");
});

test("prLabelsFor merges config labels with the ticket's class:* labels, de-duplicated", () => {
  const cfg = RepoMiloConfigSchema.parse({ labels: ["agent-authored"], classLabelFromTicket: true });
  assert.deepEqual(prLabelsFor(cfg, ["milo", "class:chore", "Class:Chore", "runner:claude", "class:ux"]), ["agent-authored", "class:chore", "class:ux"]);
  // Off by default: class labels stay on the ticket.
  const off = RepoMiloConfigSchema.parse({ labels: ["agent-authored"] });
  assert.deepEqual(prLabelsFor(off, ["class:chore"]), ["agent-authored"]);
  // Nothing configured → no labels (so `gh pr create` gets no --label).
  assert.deepEqual(prLabelsFor(RepoMiloConfigSchema.parse({}), ["class:chore"]), []);
});

test("modelOverrideFor: first matching label wins, then model.default, else undefined", () => {
  const cfg = RepoMiloConfigSchema.parse({ model: { default: "opus", byLabel: { "class:chore": "sonnet", "class:docs": "haiku" } } });
  assert.equal(modelOverrideFor(cfg, ["milo", "class:docs", "class:chore"]), "haiku", "issue label order decides");
  assert.equal(modelOverrideFor(cfg, ["CLASS:CHORE"]), "sonnet", "case-insensitive");
  assert.equal(modelOverrideFor(cfg, ["class:feature"]), "opus");
  assert.equal(modelOverrideFor(RepoMiloConfigSchema.parse({}), ["class:chore"]), undefined);
  assert.equal(modelOverrideFor(RepoMiloConfigSchema.parse({ model: { byLabel: { "class:chore": "sonnet" } } }), []), undefined);
});

test("globToRegExp: ** spans directories, * and ? stay inside one segment", () => {
  assert.ok(globToRegExp("packages/ios/**").test("packages/ios/Wazzon/Views/Feed.swift"));
  assert.ok(globToRegExp("packages/ios/**").test("packages/ios/project.yml"));
  assert.ok(!globToRegExp("packages/ios/**").test("packages/iosx/a.swift"));
  assert.ok(globToRegExp("**/*.swift").test("a/b/c.swift"));
  assert.ok(globToRegExp("**/*.swift").test("c.swift"), "**/ matches zero directories");
  assert.ok(!globToRegExp("packages/*/src").test("packages/a/b/src"));
  assert.ok(globToRegExp("packages/*/src").test("packages/a/src"));
  assert.ok(globToRegExp("file?.ts").test("file1.ts"));
  assert.ok(!globToRegExp("file?.ts").test("file/1.ts"));
});

test("verifyCommandsFor: verifyCommand always, byPath entries only when the diff touches them", () => {
  const cfg = RepoMiloConfigSchema.parse(WAZZON_CONFIG);
  const api = verifyCommandsFor(cfg, ["packages/api/src/routes/feed.ts", "docs/x.md"]);
  assert.deepEqual(api.map((p) => p.command), ["pnpm typecheck"]);

  const ios = verifyCommandsFor(cfg, ["packages/ios/Wazzon/Views/Feed.swift", "packages/api/src/a.ts"]);
  assert.deepEqual(ios.map((p) => p.command), ["pnpm typecheck", "make test-ios-unit"]);

  const both = verifyCommandsFor(cfg, ["packages/ios/a.swift", "packages/android/app/b.kt"]);
  assert.deepEqual(both.map((p) => p.command), ["pnpm typecheck", "make test-ios-unit", "make test-android-unit"]);

  // Nothing configured → empty plan (the gate skips verification).
  assert.deepEqual(verifyCommandsFor(RepoMiloConfigSchema.parse({}), ["anything"]), []);
  // Duplicate commands collapse.
  const dup = RepoMiloConfigSchema.parse({ verifyCommand: "pnpm test", verifyByPath: [{ paths: ["**"], command: "pnpm test" }] });
  assert.equal(verifyCommandsFor(dup, ["a"]).length, 1);
});
