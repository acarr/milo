import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPrompt,
  buildAttachPrompt,
  buildLinearAttachPrompt,
  buildFreeformPrompt,
  buildConductorPrompt,
  RepoConfigSchema,
  type LinearIssue,
  type PullRequest,
  type PrContext,
} from "@milo/core";

/**
 * Golden snapshots of the assembled prompts. The prompt IS the product — a stray edit to the
 * built-in text, a placeholder that stops substituting, or a header block that goes missing when
 * a workflow file is present, are all regressions a human would only notice from a bad run.
 *
 * Regenerate deliberately with `UPDATE_SNAPSHOTS=1 pnpm test` and review the diff.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(here, "fixtures", "prompts");

function snapshot(name: string, actual: string): void {
  mkdirSync(SNAP_DIR, { recursive: true });
  const file = join(SNAP_DIR, `${name}.txt`);
  if (process.env["UPDATE_SNAPSHOTS"] || !existsSync(file)) {
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, "utf8"), `prompt snapshot "${name}" changed — review, then UPDATE_SNAPSHOTS=1 to accept`);
}

const repo = RepoConfigSchema.parse({ name: "wazzon", path: "/repos/wazzon", baseBranch: "main", teamKeys: ["WAZ"], packageManager: "pnpm" });
const worktree = { path: "/wt/WAZ-1234", branch: "feature/waz-1234-add-thing", baseBranch: "main" };

const issue: LinearIssue = {
  id: "uuid-1234",
  identifier: "WAZ-1234",
  title: "Add the thing",
  description: "As a user I want the thing.\n\n## Acceptance criteria\n- it exists\n- it works",
  priorityLabel: "High",
  url: "https://linear.app/wazzon/issue/WAZ-1234",
  state: { id: "s", name: "Todo", type: "unstarted" },
  labels: ["milo", "class:chore"],
  comments: [
    { author: "Alex", createdAt: "2026-09-01T10:00:00Z", body: "Please keep it small." },
    { author: "Ripley", createdAt: "2026-09-02T10:00:00Z", body: "@milo go" },
  ],
};

const richIssue: LinearIssue = {
  ...issue,
  attachments: [
    { title: "Figma", url: "https://figma.com/file/abc" },
    { title: "", url: "https://example.com/screenshot.png" },
  ],
  parent: { identifier: "WAZ-1200", title: "Things epic" },
  children: [
    { identifier: "WAZ-1235", title: "Sub thing A", state: "Done" },
    { identifier: "WAZ-1236", title: "Sub thing B" },
  ],
};

const WORKFLOW = `You are working on {{ISSUE_ID}} in {{REPO}} ({{WORKING_DIRECTORY}}), branch {{BRANCH}} off {{BASE_BRANCH}}.

### Phase 1: Acceptance criteria
Extract them into a numbered checklist.

### Phase 7: PR
Open the PR with \`gh pr create --label {{LABELS}}\` and \`Closes {{ISSUE_ID}}\`. Leave {{NOT_A_MILO_VAR}} alone.`;

test("linear create prompt — built-in body (no workflow file)", () => {
  const p = buildPrompt({ repo, worktree, issue, routingInstruction: "No specific routing." });
  snapshot("linear-builtin", p);
  // Structure a human relies on, independent of the snapshot.
  assert.match(p, /^<context>\n  <repository>wazzon<\/repository>/);
  assert.match(p, /<linear_issue>[\s\S]*<identifier>WAZ-1234<\/identifier>/);
  assert.match(p, /<routing>\nNo specific routing\.\n<\/routing>/);
  assert.match(p, /CLAUDE\.md[\s\S]*AGENTS\.md/, "AGENTS.md is mentioned alongside CLAUDE.md");
  assert.match(p, /### Phase 1: Understand and Plan/);
  assert.match(p, /### Phase 6: Create Pull Request/);
  assert.match(p, /## Critical Rules/);
  assert.match(p, /## Final output \(REQUIRED\)[\s\S]*MILO_RESULT=\{"outcome":"implemented"/);
  assert.match(p, /"criteria":\{"passed":<n>,"total":<m>\}/, "the optional criteria field is documented in the footer");
  assert.ok(!p.includes("<previous_attempt>"), "a first attempt carries no previous_attempt block");
  assert.ok(!p.includes("--label"), "no labels configured → no label instruction");
  assert.ok(!p.includes("<attachments>") && !p.includes("<parent>") && !p.includes("<sub_issues>"), "empty extras are omitted");
});

test("linear create prompt — repo workflow replaces the body, header + footer stay, placeholders substitute", () => {
  const p = buildPrompt({
    repo,
    worktree,
    issue,
    routingInstruction: "iOS only.",
    workflow: WORKFLOW,
    labels: ["agent-authored", "class:chore"],
  });
  snapshot("linear-workflow", p);
  // Header (code-owned) is intact.
  assert.match(p, /^<context>/);
  assert.match(p, /<linear_issue>[\s\S]*<\/linear_issue>/);
  assert.match(p, /<routing>\niOS only\.\n<\/routing>/);
  // Body is the workflow with placeholders filled.
  assert.match(p, /You are working on WAZ-1234 in wazzon \(\/wt\/WAZ-1234\), branch feature\/waz-1234-add-thing off main\./);
  assert.match(p, /gh pr create --label agent-authored,class:chore/);
  assert.match(p, /Closes WAZ-1234/);
  assert.match(p, /Leave \{\{NOT_A_MILO_VAR\}\} alone/, "unknown placeholders are left as-is");
  // Built-in body is gone…
  assert.ok(!p.includes("### Phase 1: Understand and Plan"));
  assert.ok(!p.includes("## Critical Rules"));
  // …but the footer contract is not negotiable.
  assert.match(p, /## Final output \(REQUIRED\)[\s\S]*MILO_RESULT=/);
  assert.ok(p.indexOf("<routing>") < p.indexOf("### Phase 1: Acceptance criteria"), "body comes after the header");
  assert.ok(p.indexOf("### Phase 7: PR") < p.indexOf("## Final output"), "footer comes after the body");
});

test("linear create prompt — labels reach the built-in PR step; previous_attempt renders on a retry", () => {
  const p = buildPrompt({
    repo,
    worktree,
    issue,
    routingInstruction: "No specific routing.",
    labels: ["agent-authored", "class:chore"],
    previousAttempt: {
      attempt: 1,
      errorDetail: "API Error: Connection closed mid-response.",
      outputTail: "…\nRunning pnpm typecheck\nerror TS2322: Type 'string' is not assignable to type 'number'.\n",
    },
  });
  snapshot("linear-retry", p);
  assert.match(p, /Add the labels `--label agent-authored,class:chore`\./);
  const block = p.slice(p.indexOf("<previous_attempt>"), p.indexOf("</previous_attempt>"));
  assert.match(block, /<attempt>1<\/attempt>/);
  assert.match(block, /This is attempt 2 of this job/);
  assert.match(block, /<error>\nAPI Error: Connection closed mid-response\.\n  <\/error>/);
  assert.match(block, /<output_tail>\n[\s\S]*error TS2322[\s\S]*<\/output_tail>/);
  assert.ok(p.indexOf("</routing>") < p.indexOf("<previous_attempt>"), "previous_attempt sits after routing");
  assert.ok(p.indexOf("</previous_attempt>") < p.indexOf("## Your Workflow"), "…and before the body");
});

test("linear_issue block renders attachments, parent, and sub-issues when present", () => {
  const p = buildPrompt({ repo, worktree, issue: richIssue, routingInstruction: "No specific routing." });
  snapshot("linear-rich-issue", p);
  assert.match(p, /<parent>WAZ-1200 — Things epic<\/parent>/);
  assert.match(p, /<attachments>\n- Figma: https:\/\/figma\.com\/file\/abc\n- https:\/\/example\.com\/screenshot\.png: https:\/\/example\.com\/screenshot\.png\n  <\/attachments>/);
  assert.match(p, /<sub_issues>\n- WAZ-1235 — Sub thing A \(Done\)\n- WAZ-1236 — Sub thing B\n  <\/sub_issues>/);
  // Ordering inside the block: parent before description, attachments + sub-issues before comments.
  assert.ok(p.indexOf("<parent>") < p.indexOf("<description>"));
  assert.ok(p.indexOf("</description>") < p.indexOf("<attachments>"));
  assert.ok(p.indexOf("</sub_issues>") < p.indexOf("<comments>"));
});

const pr: PullRequest = {
  number: 77,
  title: "feat: the thing",
  body: "## Summary\nAdds the thing.",
  headRefName: "feature/thing",
  baseRefName: "main",
  state: "OPEN",
  url: "https://github.com/octave-partners/wazzon/pull/77",
  isCrossRepository: false,
  author: "milo-wazzon[bot]",
  assignees: [],
  labels: ["agent-authored"],
  updatedAt: "2026-09-10T00:00:00Z",
};

const prContext: PrContext = {
  diffStat: " packages/api/src/a.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)",
  diffHead: "diff --git a/packages/api/src/a.ts b/packages/api/src/a.ts\n--- a/packages/api/src/a.ts\n+++ b/packages/api/src/a.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;",
  diffTruncated: true,
  reviewThreads: [
    { path: "packages/api/src/a.ts", line: 2, author: "alex", body: "Why 2? This should stay 1 — see the test." },
    { path: "packages/api/src/b.ts", line: null, author: "ripley", body: "Missing null check." },
  ],
  reviews: [
    { author: "alex", state: "CHANGES_REQUESTED" },
    { author: "ripley", state: "COMMENTED" },
  ],
  failingChecks: ["CI: Server", "Lint"],
};

test("github attach prompt — built-in, with pr_diff / review_threads / latest_reviews / failing_checks", () => {
  const p = buildAttachPrompt({ repo, worktree: { ...worktree, branch: "feature/thing" }, pr, instruction: "Address the review.", prContext });
  snapshot("attach-github", p);
  assert.match(p, /<pull_request>[\s\S]*<number>77<\/number>/);
  assert.match(p, /<pr_diff>\n  <stat>\n[\s\S]*1 file changed[\s\S]*<\/stat>\n  <head truncated="true">\n[\s\S]*\+const a = 2;\n  <\/head>\n  \(The diff continues/);
  assert.match(p, /<review_threads>\n[\s\S]*- packages\/api\/src\/a\.ts:2 \(alex\): Why 2\?[\s\S]*- packages\/api\/src\/b\.ts \(ripley\): Missing null check\.\n<\/review_threads>/);
  assert.match(p, /<latest_reviews>\n- alex: CHANGES_REQUESTED\n- ripley: COMMENTED\n<\/latest_reviews>/);
  assert.match(p, /<failing_checks>\n- CI: Server\n- Lint\n<\/failing_checks>/);
  assert.match(p, /<requested_change>\nAddress the review\.\n<\/requested_change>/);
  assert.match(p, /Do NOT run `gh pr create`/);
  assert.match(p, /MILO_RESULT=\{"outcome":"implemented","wroteCode":true,"prUrl":"https:\/\/github\.com\/octave-partners\/wazzon\/pull\/77"/);
});

test("github attach prompt — no PR context and no workflow → no empty blocks", () => {
  const p = buildAttachPrompt({ repo, worktree, pr, instruction: "Fix it." });
  for (const tag of ["<pr_diff>", "<review_threads>", "<latest_reviews>", "<failing_checks>", "<previous_attempt>"]) {
    assert.ok(!p.includes(tag), `${tag} must be omitted when empty`);
  }
});

test("linear attach prompt — workflow body with PR placeholders + previous_attempt from a failed verify", () => {
  const p = buildLinearAttachPrompt({
    repo,
    worktree,
    issue,
    prUrl: "https://github.com/octave-partners/wazzon/pull/77",
    instruction: "Verification failed; make it pass.",
    prContext: { reviewThreads: [], reviews: [], failingChecks: ["CI: iOS"] },
    workflow: "Revise PR #{{PR_NUMBER}} ({{PR_URL}}) for {{ISSUE_ID}} on {{BRANCH}}.",
    previousAttempt: { attempt: 1, errorDetail: "Verification gate failed:\n✗ `pnpm typecheck` (exit 2, 41s)", outputTail: "error TS2345" },
  });
  snapshot("attach-linear-workflow", p);
  assert.match(p, /<existing_pull_request>https:\/\/github\.com\/octave-partners\/wazzon\/pull\/77<\/existing_pull_request>/);
  assert.match(p, /<failing_checks>\n- CI: iOS\n<\/failing_checks>/);
  assert.match(p, /Revise PR #77 \(https:\/\/github\.com\/octave-partners\/wazzon\/pull\/77\) for WAZ-1234 on feature\/waz-1234-add-thing\./);
  assert.match(p, /<previous_attempt>[\s\S]*pnpm typecheck[\s\S]*error TS2345[\s\S]*<\/previous_attempt>/);
  assert.ok(!p.includes("<pr_diff>"), "no diff → no pr_diff block");
  assert.ok(!p.includes("## Your Workflow"), "built-in body replaced");
  assert.match(p, /## Final output \(REQUIRED\)/);
});

test("freeform (scheduled) prompt — built-in and workflow variants", () => {
  const builtIn = buildFreeformPrompt({ repo, worktree, instruction: "Tidy the TODOs." });
  snapshot("freeform-builtin", builtIn);
  assert.match(builtIn, /<task>\nTidy the TODOs\.\n<\/task>/);
  assert.match(builtIn, /AGENTS\.md/);
  assert.match(builtIn, /### Phase 5: Create Pull Request/);

  const wf = buildFreeformPrompt({ repo, worktree, instruction: "Tidy the TODOs.", workflow: "Do it on {{BRANCH}} then label {{LABELS}}.", labels: ["agent-authored"] });
  snapshot("freeform-workflow", wf);
  assert.match(wf, /Do it on feature\/waz-1234-add-thing then label agent-authored\./);
  assert.ok(!wf.includes("### Phase 5"));
  assert.match(wf, /MILO_RESULT=/);
});

test("conductor prompt keeps its built-in branch contract and gains previous_attempt", () => {
  const p = buildConductorPrompt({
    repo,
    issue,
    routingInstruction: "No specific routing.",
    branch: worktree.branch,
    baseBranch: "main",
    githubRepo: "octave-partners/wazzon",
    previousAttempt: { attempt: 2, errorDetail: "session timed out" },
  });
  snapshot("conductor-retry", p);
  assert.match(p, /### Phase 0: Switch to Milo's branch/);
  assert.match(p, /git switch -c feature\/waz-1234-add-thing/);
  assert.match(p, /<previous_attempt>[\s\S]*session timed out[\s\S]*<\/previous_attempt>/);
  assert.match(p, /AGENTS\.md/);
  assert.match(p, /Always leave prUrl null/);
});
