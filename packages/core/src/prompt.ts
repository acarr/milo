import type { LinearIssue } from "./linear.js";
import type { RepoConfig } from "./config.js";
import type { Worktree } from "./worktree.js";
import type { PullRequest, PrContext } from "./github.js";
import { renderWorkflow } from "./repo-config.js";

/**
 * Prompt assembly. Every prompt Milo sends has the same shape:
 *
 *   <context> … </context>            ─┐
 *   <linear_issue> / <pull_request> …  │ header — always produced by code
 *   <routing> / <requested_change> …   │
 *   <previous_attempt> … (retries)    ─┘
 *   …the phase body…                   ← built-in text, OR the repo's `.milo/workflows/*.md`
 *   ## Final output (REQUIRED) …       ← footer — always produced by code (the MILO_RESULT contract)
 *
 * The header and footer are Milo's contract with the pipeline (what it parses, what the gate
 * checks); the body is the part a repository is allowed to own. A repo with no workflow file gets
 * the built-in body, so the assembled prompt is exactly what it was before workflows existed.
 */

// ---------------------------------------------------------------- shared pieces

/** What the previous attempt of this job left behind, so a retry doesn't start blind. */
export interface PreviousAttempt {
  /** 1-based number of the attempt that FAILED (the new run is `attempt + 1`). */
  attempt: number;
  /** The stored failure detail (`errorDetail` from the runner, or the gate's reason). */
  errorDetail?: string;
  /** The last ~50 lines of the previous run's output (or the failing verify command's output). */
  outputTail?: string;
}

/** Placeholder values substituted into a workflow body (`{{ISSUE_ID}}` etc.). */
export interface WorkflowVars {
  ISSUE_ID?: string;
  BASE_BRANCH: string;
  BRANCH: string;
  PR_NUMBER?: number | string;
  PR_URL?: string;
  REPO: string;
  WORKING_DIRECTORY: string;
  /** Comma-joined PR labels (`agent-authored,class:chore`), or empty. */
  LABELS?: string;
}

/** Per-issue routing note: the first issue label with a `repo.routing` entry, else the default. */
export function routingInstruction(repo: RepoConfig, issue: LinearIssue): string {
  for (const label of issue.labels) {
    const r = repo.routing?.[label.toLowerCase().trim()];
    if (r) return r;
  }
  return repo.defaultRouting ?? "No specific routing.";
}

function join(parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}

function contextBlock(repo: RepoConfig, worktree: Pick<Worktree, "path" | "branch" | "baseBranch">): string {
  return `<context>
  <repository>${repo.name}</repository>
  <working_directory>${worktree.path}</working_directory>
  <base_branch>${worktree.baseBranch}</base_branch>
  <branch>${worktree.branch}</branch>
  <package_manager>${repo.packageManager}</package_manager>
</context>`;
}

function commentsText(issue: LinearIssue): string {
  return issue.comments.length > 0
    ? issue.comments.map((c) => `[${c.author} — ${c.createdAt}]:\n${c.body}`).join("\n\n")
    : "No comments";
}

/**
 * The `<linear_issue>` block. Attachments, the parent issue, and sub-issues are rendered only when
 * present, so an issue without them reads exactly as it always has.
 */
function linearIssueBlock(issue: LinearIssue, opts: { priority?: boolean; extra?: string[] } = {}): string {
  const lines: string[] = [
    `  <identifier>${issue.identifier}</identifier>`,
    `  <title>${issue.title}</title>`,
  ];
  if (opts.priority) lines.push(`  <priority>${issue.priorityLabel}</priority>`);
  lines.push(`  <url>${issue.url}</url>`);
  if (opts.priority) lines.push(`  <labels>${issue.labels.join(", ")}</labels>`);
  for (const e of opts.extra ?? []) lines.push(`  ${e}`);
  if (issue.parent) lines.push(`  <parent>${issue.parent.identifier} — ${issue.parent.title}</parent>`);
  lines.push(`  <description>\n${issue.description || "No description"}\n  </description>`);
  if (issue.attachments?.length) {
    lines.push(`  <attachments>\n${issue.attachments.map((a) => `- ${a.title || a.url}: ${a.url}`).join("\n")}\n  </attachments>`);
  }
  if (issue.children?.length) {
    lines.push(
      `  <sub_issues>\n${issue.children.map((c) => `- ${c.identifier} — ${c.title}${c.state ? ` (${c.state})` : ""}`).join("\n")}\n  </sub_issues>`,
    );
  }
  lines.push(`  <comments>\n${commentsText(issue)}\n  </comments>`);
  return `<linear_issue>\n${lines.join("\n")}\n</linear_issue>`;
}

function routingBlock(routing: string): string {
  return `<routing>\n${routing}\n</routing>`;
}

/**
 * Failure context for a retry. Rendered as a tagged block in the header so a workflow body doesn't
 * have to know about retries at all — the agent simply sees what went wrong last time.
 */
export function previousAttemptBlock(p: PreviousAttempt | undefined): string | undefined {
  if (!p) return undefined;
  const lines = [
    `<previous_attempt>`,
    `  <attempt>${p.attempt}</attempt>`,
    `  This is attempt ${p.attempt + 1} of this job. Attempt ${p.attempt} did not succeed. Read the error and the`,
    `  output tail below, fix the root cause first, and do not repeat the same approach blindly.`,
  ];
  if (p.errorDetail) lines.push(`  <error>\n${p.errorDetail.trim()}\n  </error>`);
  if (p.outputTail && p.outputTail.trim()) lines.push(`  <output_tail>\n${p.outputTail.trimEnd()}\n  </output_tail>`);
  lines.push(`</previous_attempt>`);
  return lines.join("\n");
}

/** `<pr_diff>`, `<review_threads>`, `<latest_reviews>`, `<failing_checks>` — each only when non-empty. */
export function prContextBlocks(ctx: PrContext | undefined): string[] {
  if (!ctx) return [];
  const out: string[] = [];
  if (ctx.diffStat || ctx.diffHead) {
    const parts = [`<pr_diff>`];
    if (ctx.diffStat) parts.push(`  <stat>\n${ctx.diffStat}\n  </stat>`);
    if (ctx.diffHead) {
      parts.push(
        `  <head${ctx.diffTruncated ? ' truncated="true"' : ""}>\n${ctx.diffHead}\n  </head>` +
          (ctx.diffTruncated ? `\n  (The diff continues — run \`gh pr diff\` in the working directory for the rest.)` : ""),
      );
    }
    parts.push(`</pr_diff>`);
    out.push(parts.join("\n"));
  }
  if (ctx.reviewThreads.length) {
    out.push(
      `<review_threads>\nUnresolved review threads — each one needs a fix or a reply:\n${ctx.reviewThreads
        .map((t) => `- ${t.path}${t.line != null ? `:${t.line}` : ""} (${t.author}): ${t.body.trim()}`)
        .join("\n")}\n</review_threads>`,
    );
  }
  if (ctx.reviews.length) {
    out.push(`<latest_reviews>\n${ctx.reviews.map((r) => `- ${r.author}: ${r.state}`).join("\n")}\n</latest_reviews>`);
  }
  if (ctx.failingChecks.length) {
    out.push(`<failing_checks>\n${ctx.failingChecks.map((c) => `- ${c}`).join("\n")}\n</failing_checks>`);
  }
  return out;
}

/** The label clause for the model's own `gh pr create` — empty when the repo configures no labels. */
function labelClause(labels: string[] | undefined): string {
  return labels && labels.length ? ` Add the labels \`--label ${labels.join(",")}\`.` : "";
}

const FINAL_OUTPUT_INTRO = `## Final output (REQUIRED)
As the very last line of your response, print one line of machine-readable JSON, prefixed exactly
with \`MILO_RESULT=\` and nothing after it, e.g.:`;

const CRITERIA_NOTE = `If you tracked acceptance criteria, also include
\`"criteria":{"passed":<n>,"total":<m>}\`.`;

function finalOutput(example: string, fields: string): string {
  return `${FINAL_OUTPUT_INTRO}\n\n${example}\n\n${fields} ${CRITERIA_NOTE}`;
}

/** Body text: the repo's workflow (placeholders substituted) when there is one, else the built-in. */
function body(workflow: string | undefined, vars: WorkflowVars, builtIn: () => string): string {
  return workflow ? renderWorkflow(workflow, { ...vars }) : builtIn();
}

// ---------------------------------------------------------------- Linear create mode

export interface PromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  issue: LinearIssue;
  routingInstruction: string;
  /** The repo's `workflows.linearIssue` body, already read from disk. Omit for the built-in text. */
  workflow?: string;
  /** Labels the PR must carry (repo config + `class:*` from the ticket). */
  labels?: string[];
  /** Set on a retry so the agent sees what the last attempt hit. */
  previousAttempt?: PreviousAttempt;
}

/**
 * The autonomous implementation prompt (ported from milo.sh's 7-phase prompt),
 * with a machine-readable MILO_RESULT line appended so the runner's outcome can
 * be parsed deterministically (the gate cross-checks this against git/gh ground truth).
 */
export function buildPrompt(input: PromptInput): string {
  const { repo, worktree, issue, labels, workflow, previousAttempt } = input;
  const vars: WorkflowVars = {
    ISSUE_ID: issue.identifier,
    BASE_BRANCH: worktree.baseBranch,
    BRANCH: worktree.branch,
    REPO: repo.name,
    WORKING_DIRECTORY: worktree.path,
    LABELS: (labels ?? []).join(","),
  };
  const builtIn = () => `You are autonomously implementing a Linear ticket. The CLAUDE.md in this repository (and AGENTS.md,
if present) contains all project conventions, patterns, and architecture — follow them strictly.

## Your Workflow — execute IN ORDER, do not skip, do not stop between phases unless blocked.

### Phase 1: Understand and Plan
1. Read the ticket description and comments above.
2. Read CLAUDE.md (and AGENTS.md, if present) for project conventions.
3. Read the existing code relevant to the ticket scope.
4. Form a brief internal plan.

### Phase 2: Implement
Make the code changes per the ticket, following CLAUDE.md conventions and the routing note above.

### Phase 3: Verify (MANDATORY)
Run the project's verification. If it has a \`verify\` script, run it; otherwise run typecheck/build/test
and lint as available. If there is a dev server and the change is testable over HTTP, exercise it.

### Phase 4: Fix and Re-verify
If verification fails, fix with the smallest change and re-run. Up to 3 attempts; if still failing,
proceed to Phase 5 but note the failures in the PR description.

### Phase 5: Commit and Push
1. Stage changed files explicitly (no \`git add -A\`/\`git add .\`).
2. Commit with a conventional message ending with a line: \`Implements ${issue.identifier}\`.
3. Push: \`git push -u origin HEAD\`.

### Phase 6: Create Pull Request
1. Check for an existing PR: \`gh pr list --head $(git branch --show-current) --json number\`.
2. If none, create one against ${worktree.baseBranch} with a clear title and a body that includes a
   "## Summary", a "## Verification" section, and the line \`Closes ${issue.identifier}\` so Linear
   auto-closes the ticket on merge.${labelClause(labels)}
3. If a PR exists, update it with \`gh pr edit\`. Then mark it ready: \`gh pr ready\`.

## Critical Rules
1. You are in an isolated git worktree at the working directory above. Stay within it.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If the ticket is genuinely a discovery/answer task with NO code to write, do not invent code or open
   an empty PR — set outcome=discovery below and put your findings in the summary.
4. If you write ANY code, you MUST commit, push, AND open a PR. Never leave code without a PR.
5. If you hit an unrecoverable blocker (e.g. infra down), set outcome=blocked and explain.`;

  return join([
    contextBlock(repo, worktree),
    linearIssueBlock(issue, { priority: true }),
    routingBlock(input.routingInstruction),
    previousAttemptBlock(previousAttempt),
    body(workflow, vars, builtIn),
    finalOutput(
      `MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/OWNER/${repo.name}/pull/123","summary":"Added X and Y; verify passed."}`,
      `Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL (or null), and summary is one or two sentences.`,
    ),
  ]);
}

// ---------------------------------------------------------------- Conductor (remote) create mode

export interface ConductorPromptInput {
  repo: RepoConfig;
  issue: LinearIssue;
  routingInstruction: string;
  /** The branch the agent MUST push — Milo's only way to find the work afterwards. */
  branch: string;
  baseBranch: string;
  /** `owner/name`, so the agent knows which repo it is looking at. */
  githubRepo: string;
  previousAttempt?: PreviousAttempt;
}

/**
 * The implementation prompt for a **Conductor Cloud** run.
 *
 * Differs from {@link buildPrompt} because the agent is on a machine Milo cannot see:
 *  - there is no known working directory (the cloud workspace path is Milo's business, not ours);
 *  - the ONLY observable output is what reaches `origin`, so pushing is the load-bearing step;
 *  - the agent must NOT open the PR — Milo's verification gate does that from the local clone,
 *    which keeps the "code always gets a PR" guarantee independent of the model's diligence.
 *
 * The branch name is the entire local/remote contract, so it is stated three times: as context, as
 * a mandatory first action, and as a self-check. The body is always built-in: a repo workflow is
 * written for a local worktree and would drop the branch contract.
 */
export function buildConductorPrompt(input: ConductorPromptInput): string {
  const { repo, issue, routingInstruction: routing, branch, baseBranch, githubRepo, previousAttempt } = input;
  return join([
    `<context>
  <repository>${repo.name}</repository>
  <github_repo>${githubRepo}</github_repo>
  <base_branch>${baseBranch}</base_branch>
  <branch>${branch}</branch>
  <package_manager>${repo.packageManager}</package_manager>
</context>`,
    `<workspace>
You are in a Conductor cloud workspace containing a clone of ${githubRepo}. Run \`pwd\` to find your
working directory — it is NOT any path on Milo's machine.

Milo is running on a DIFFERENT machine and cannot see this filesystem. The only thing it can observe
is what you push to \`origin\`. Work that is committed but not pushed is invisible to Milo and will
be lost when this workspace is torn down.
</workspace>`,
    linearIssueBlock(issue, { priority: true }),
    routingBlock(routing),
    previousAttemptBlock(previousAttempt),
    `You are autonomously implementing a Linear ticket. The CLAUDE.md in this repository (and AGENTS.md,
if present) contains all project conventions, patterns, and architecture — follow them strictly.

## Your Workflow — execute IN ORDER, do not skip, do not stop between phases unless blocked.

### Phase 0: Switch to Milo's branch (MANDATORY FIRST ACTION)
Run:
\`\`\`
git switch -c ${branch} 2>/dev/null || (git fetch origin ${branch} && git switch ${branch})
\`\`\`
This exact branch name is a contract with Milo — it is how Milo finds your work. Do not rename it,
do not work on the workspace's default branch, and do not push anywhere else.

### Phase 1: Understand and Plan
1. Read the ticket description and comments above.
2. Read CLAUDE.md (and AGENTS.md, if present) for project conventions.
3. Read the existing code relevant to the ticket scope.

### Phase 2: Implement
Make the code changes per the ticket, following CLAUDE.md conventions and the routing note above.

### Phase 3: Verify (MANDATORY)
Run the project's verification. If it has a \`verify\` script, run it; otherwise run typecheck/build/test
and lint as available.

### Phase 4: Fix and Re-verify
If verification fails, fix with the smallest change and re-run. Up to 3 attempts; if still failing,
proceed to Phase 5 but note the failures in your summary.

### Phase 5: Commit and Push (THE MOST IMPORTANT STEP)
1. Stage changed files explicitly (no \`git add -A\`/\`git add .\`).
2. Commit with a conventional message ending with a line: \`Implements ${issue.identifier}\`.
3. Push: \`git push -u origin ${branch}\`.
4. Confirm it landed: \`git ls-remote --exit-code origin ${branch}\` — this MUST succeed before you finish.

Push as soon as you have your first commit, and again after each subsequent commit. Do not save the
push for the end — an unpushed commit is a lost commit.

### Phase 6: Do NOT create a pull request
Milo opens the pull request itself from its own machine once it sees your branch on \`origin\`.
Do NOT run \`gh pr create\`, \`gh pr edit\`, or \`gh pr ready\` — doing so creates a duplicate PR.

## Critical Rules
1. Work only inside this repository checkout, on branch \`${branch}\`.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If the ticket is genuinely a discovery/answer task with NO code to write, do not invent code and do
   not push an empty branch — set outcome=discovery below and put your findings in the summary.
4. **If you write ANY code you MUST commit AND push it to \`${branch}\`.** Milo cannot see this
   filesystem; unpushed work is lost work. \`git push\` is not optional.
5. If you hit an unrecoverable blocker (e.g. infra down), set outcome=blocked and explain.`,
    finalOutput(
      `MILO_RESULT={"outcome":"implemented","wroteCode":true,"branch":"${branch}","prUrl":null,"summary":"Added X and Y; verify passed."}`,
      `Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, branch is the
branch you pushed, and summary is one or two sentences. Always leave prUrl null — Milo opens the PR.`,
    ),
  ]);
}

// ---------------------------------------------------------------- scheduled prompt (no ticket)

export interface FreeformPromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  /** The scheduled prompt's instruction (the contents of the `.md` the schedule points at). */
  instruction: string;
  /** The repo's `workflows.schedule` body. Omit for the built-in text. */
  workflow?: string;
  labels?: string[];
  previousAttempt?: PreviousAttempt;
}

/**
 * The prompt for a **scheduled prompt** job (no Linear ticket / GitHub PR): Milo runs the supplied
 * instruction autonomously in a fresh worktree. Same workflow scaffolding + machine-readable
 * MILO_RESULT line as `buildPrompt`, minus the issue-specific framing and the `Closes` requirement —
 * the verification gate decides PR-vs-report from real git state regardless.
 */
export function buildFreeformPrompt(input: FreeformPromptInput): string {
  const { repo, worktree, instruction, workflow, labels, previousAttempt } = input;
  const vars: WorkflowVars = {
    BASE_BRANCH: worktree.baseBranch,
    BRANCH: worktree.branch,
    REPO: repo.name,
    WORKING_DIRECTORY: worktree.path,
    LABELS: (labels ?? []).join(","),
  };
  const builtIn = () => `You are autonomously running a scheduled task on this repository (there is no ticket — the task above
is your full instruction). The CLAUDE.md in this repository (and AGENTS.md, if present) contains all
project conventions, patterns, and architecture — follow them strictly.

## Your Workflow — execute IN ORDER, run fully autonomously, do not stop between phases unless blocked.

### Phase 1: Understand and Plan
1. Read the task above.
2. Read CLAUDE.md (and AGENTS.md, if present) for project conventions and the existing code relevant
   to the task.
3. Form a brief internal plan.

### Phase 2: Implement
Make the changes the task calls for, following CLAUDE.md conventions. If the task is investigative and
genuinely needs NO code change, do not invent code — set outcome=discovery and put your findings in the
summary.

### Phase 3: Verify (MANDATORY if you changed code)
Run the project's verification (\`verify\` script, else typecheck/build/test/lint as available). Fix and
re-run with the smallest change; up to 3 attempts.

### Phase 4: Commit and Push (only if you changed code)
1. Stage changed files explicitly (no \`git add -A\`/\`git add .\`).
2. Commit with a conventional message describing the change.
3. Push: \`git push -u origin HEAD\`.

### Phase 5: Create Pull Request (only if you changed code)
1. Check for an existing PR: \`gh pr list --head $(git branch --show-current) --json number\`.
2. If none, create one against ${worktree.baseBranch} with a clear title and a body that includes a
   "## Summary" and a "## Verification" section. (No issue to close — omit any "Closes" line.)${labelClause(labels)}

## Critical Rules
1. You are in an isolated git worktree at the working directory above. Stay within it.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If you write ANY code, you MUST commit, push, AND open a PR. Never leave code without a PR.
4. If the task needs no code (a report/summary), set outcome=discovery and put the result in the
   summary — do not open an empty PR.
5. If you hit an unrecoverable blocker (e.g. infra down), set outcome=blocked and explain.`;

  return join([
    contextBlock(repo, worktree),
    `<task>\n${instruction}\n</task>`,
    previousAttemptBlock(previousAttempt),
    body(workflow, vars, builtIn),
    finalOutput(
      `MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/OWNER/${repo.name}/pull/123","summary":"Did X; verify passed."}`,
      `Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL (or null), and summary is one or two sentences.`,
    ),
  ]);
}

// ---------------------------------------------------------------- attach modes

export interface AttachPromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  pr: PullRequest;
  /** What triggered the attach (e.g. the @milo mention body, or a default follow-up instruction). */
  instruction: string;
  /** Diff, unresolved review threads, review states, failing checks — fetched by the pipeline. */
  prContext?: PrContext;
  /** The repo's `workflows.attach` body. Omit for the built-in text. */
  workflow?: string;
  previousAttempt?: PreviousAttempt;
}

export interface LinearAttachPromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  issue: LinearIssue;
  /** The existing PR this work belongs to (Milo already opened it for this ticket). */
  prUrl: string;
  /** The revision request — typically the latest `@milo` comment body. */
  instruction: string;
  prContext?: PrContext;
  workflow?: string;
  previousAttempt?: PreviousAttempt;
}

const ATTACH_FINAL_FIELDS = `Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL, and summary is one or two sentences.`;

/**
 * The follow-up prompt for **Linear revision (attach) mode**: Milo already implemented this ticket
 * and opened a PR; the user has now asked (via a Linear comment / agent chat) for a change. The
 * ticket's existing branch is checked out and the PR is open — the agent revises it and pushes to
 * the SAME branch. It must NOT open a second PR (pushing the branch updates the existing one).
 */
export function buildLinearAttachPrompt(input: LinearAttachPromptInput): string {
  const { repo, worktree, issue, prUrl, instruction, prContext, workflow, previousAttempt } = input;
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const vars: WorkflowVars = {
    ISSUE_ID: issue.identifier,
    BASE_BRANCH: worktree.baseBranch,
    BRANCH: worktree.branch,
    PR_NUMBER: prNumber,
    PR_URL: prUrl,
    REPO: repo.name,
    WORKING_DIRECTORY: worktree.path,
  };
  const builtIn = () => `You already implemented this ticket and opened the pull request above. The user has now asked for a
revision (see "requested_change"). The ticket's existing branch is already checked out in the working
directory, and the PR is already open. The CLAUDE.md in this repository (and AGENTS.md, if present)
contains all project conventions — follow them strictly.

## Your Workflow — execute IN ORDER, run fully autonomously, do not stop between phases unless blocked.

### Phase 1: Understand
1. Read the requested change above, the ticket, the prior comments, and any review threads / failing
   checks listed above.
2. Read CLAUDE.md (and AGENTS.md, if present) and the code relevant to the request (including what
   you changed before).

### Phase 2: Implement
Make the requested change, following CLAUDE.md conventions.

### Phase 3: Verify (MANDATORY)
Run the project's verification (\`verify\` script, else typecheck/build/test/lint as available). Fix and
re-run with the smallest change; up to 3 attempts.

### Phase 4: Commit and Push (update the existing PR — do NOT open a new one)
1. Stage changed files explicitly (no \`git add -A\`/\`git add .\`).
2. Commit with a conventional message referencing ${issue.identifier}.
3. Push to the SAME branch: \`git push origin HEAD\`. This updates the existing PR automatically.
4. Do NOT run \`gh pr create\` — the PR already exists.

## Critical Rules
1. Stay within the working directory / branch above. Never open a second PR for this ticket.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If the request needs no code change (e.g. it was a question), set outcome=discovery and answer in
   the summary.
4. If you hit an unrecoverable blocker, set outcome=blocked and explain.`;

  return join([
    contextBlock(repo, worktree),
    linearIssueBlock(issue, { extra: [`<existing_pull_request>${prUrl}</existing_pull_request>`] }),
    ...prContextBlocks(prContext),
    `<requested_change>\n${instruction}\n</requested_change>`,
    previousAttemptBlock(previousAttempt),
    body(workflow, vars, builtIn),
    finalOutput(
      `MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"${prUrl}","summary":"Addressed the requested revision; verify passed."}`,
      ATTACH_FINAL_FIELDS,
    ),
  ]);
}

/**
 * The follow-up prompt for **attach mode**: an existing PR branch is already checked out and
 * already has an open PR. The agent makes the requested changes and pushes to the SAME branch —
 * it must NOT open a new PR (the PR already exists; pushing updates it).
 */
export function buildAttachPrompt(input: AttachPromptInput): string {
  const { repo, worktree, pr, instruction, prContext, workflow, previousAttempt } = input;
  const vars: WorkflowVars = {
    BASE_BRANCH: worktree.baseBranch,
    BRANCH: worktree.branch,
    PR_NUMBER: pr.number,
    PR_URL: pr.url,
    REPO: repo.name,
    WORKING_DIRECTORY: worktree.path,
  };
  const builtIn = () => `You are iterating on an EXISTING pull request. Its branch is already checked out in the working
directory above, and the PR is already open on GitHub. The CLAUDE.md in this repository (and AGENTS.md,
if present) contains all project conventions — follow them strictly.

## Your Workflow — execute IN ORDER, run fully autonomously, do not stop between phases unless blocked.

### Phase 1: Understand
1. Read the requested change above, the PR description, and any review threads / failing checks
   listed above.
2. Read CLAUDE.md (and AGENTS.md, if present) and the code relevant to the request.

### Phase 2: Implement
Make the requested change, following CLAUDE.md conventions.

### Phase 3: Verify (MANDATORY)
Run the project's verification (\`verify\` script, else typecheck/build/test/lint as available). Fix and
re-run with the smallest change; up to 3 attempts.

### Phase 4: Commit and Push (update the existing PR — do NOT open a new one)
1. Stage changed files explicitly (no \`git add -A\`/\`git add .\`).
2. Commit with a conventional message.
3. Push to the SAME branch: \`git push origin HEAD\`. This updates PR #${pr.number} automatically.
4. Do NOT run \`gh pr create\` — the PR already exists.

## Critical Rules
1. Stay within the working directory / branch above. Never open a second PR for this work.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If there is genuinely nothing to change, set outcome=discovery and explain in the summary.
4. If you hit an unrecoverable blocker, set outcome=blocked and explain.`;

  return join([
    contextBlock(repo, worktree),
    `<pull_request>
  <number>${pr.number}</number>
  <title>${pr.title}</title>
  <url>${pr.url}</url>
  <body>
${pr.body || "No description"}
  </body>
</pull_request>`,
    ...prContextBlocks(prContext),
    `<requested_change>\n${instruction}\n</requested_change>`,
    previousAttemptBlock(previousAttempt),
    body(workflow, vars, builtIn),
    finalOutput(
      `MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"${pr.url}","summary":"Addressed the review feedback; verify passed."}`,
      ATTACH_FINAL_FIELDS,
    ),
  ]);
}

/**
 * The instruction for the gate's one verify-failure retry: the code is on the branch already, the
 * verify command failed, and the agent's job is to make it pass — nothing else.
 */
export function verifyFailureInstruction(failed: { command: string; exitCode: number | null; timedOut?: boolean }[]): string {
  const lines = failed.map(
    (f) => `- \`${f.command}\` ${f.timedOut ? "timed out" : `exited ${f.exitCode ?? "unknown"}`}`,
  );
  return `Milo's verification gate ran the repository's verify command(s) against your branch and they FAILED:
${lines.join("\n")}

The output tail is in <previous_attempt>. Fix the cause so the command(s) pass, re-run them yourself
to confirm, then commit and push to the same branch. Do not disable, skip, or weaken the checks.`;
}
