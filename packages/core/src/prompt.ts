import type { LinearIssue } from "./linear.js";
import type { RepoConfig } from "./config.js";
import type { Worktree } from "./worktree.js";
import type { PullRequest } from "./github.js";

export interface PromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  issue: LinearIssue;
  routingInstruction: string;
}

/**
 * The autonomous implementation prompt (ported from milo.sh's 7-phase prompt),
 * with a machine-readable MILO_RESULT line appended so the runner's outcome can
 * be parsed deterministically (Phase 2 cross-checks this against git/gh ground truth).
 */
export function buildPrompt({ repo, worktree, issue, routingInstruction }: PromptInput): string {
  const comments =
    issue.comments.length > 0
      ? issue.comments.map((c) => `[${c.author} — ${c.createdAt}]:\n${c.body}`).join("\n\n")
      : "No comments";

  return `<context>
  <repository>${repo.name}</repository>
  <working_directory>${worktree.path}</working_directory>
  <base_branch>${worktree.baseBranch}</base_branch>
  <branch>${worktree.branch}</branch>
  <package_manager>${repo.packageManager}</package_manager>
</context>

<linear_issue>
  <identifier>${issue.identifier}</identifier>
  <title>${issue.title}</title>
  <priority>${issue.priorityLabel}</priority>
  <url>${issue.url}</url>
  <labels>${issue.labels.join(", ")}</labels>
  <description>
${issue.description || "No description"}
  </description>
  <comments>
${comments}
  </comments>
</linear_issue>

<routing>
${routingInstruction}
</routing>

You are autonomously implementing a Linear ticket. The CLAUDE.md in this repository contains all
project conventions, patterns, and architecture — follow them strictly.

## Your Workflow — execute IN ORDER, do not skip, do not stop between phases unless blocked.

### Phase 1: Understand and Plan
1. Read the ticket description and comments above.
2. Read CLAUDE.md for project conventions.
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
   auto-closes the ticket on merge.
3. If a PR exists, update it with \`gh pr edit\`. Then mark it ready: \`gh pr ready\`.

## Critical Rules
1. You are in an isolated git worktree at the working directory above. Stay within it.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If the ticket is genuinely a discovery/answer task with NO code to write, do not invent code or open
   an empty PR — set outcome=discovery below and put your findings in the summary.
4. If you write ANY code, you MUST commit, push, AND open a PR. Never leave code without a PR.
5. If you hit an unrecoverable blocker (e.g. infra down), set outcome=blocked and explain.

## Final output (REQUIRED)
As the very last line of your response, print one line of machine-readable JSON, prefixed exactly
with \`MILO_RESULT=\` and nothing after it, e.g.:

MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/OWNER/${repo.name}/pull/123","summary":"Added X and Y; verify passed."}

Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL (or null), and summary is one or two sentences.`;
}

export interface FreeformPromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  /** The scheduled prompt's instruction (the contents of the `.md` the schedule points at). */
  instruction: string;
}

/**
 * The prompt for a **scheduled prompt** job (no Linear ticket / GitHub PR): Milo runs the supplied
 * instruction autonomously in a fresh worktree. Same workflow scaffolding + machine-readable
 * MILO_RESULT line as `buildPrompt`, minus the issue-specific framing and the `Closes` requirement —
 * the verification gate decides PR-vs-report from real git state regardless.
 */
export function buildFreeformPrompt({ repo, worktree, instruction }: FreeformPromptInput): string {
  return `<context>
  <repository>${repo.name}</repository>
  <working_directory>${worktree.path}</working_directory>
  <base_branch>${worktree.baseBranch}</base_branch>
  <branch>${worktree.branch}</branch>
  <package_manager>${repo.packageManager}</package_manager>
</context>

<task>
${instruction}
</task>

You are autonomously running a scheduled task on this repository (there is no ticket — the task above
is your full instruction). The CLAUDE.md in this repository contains all project conventions, patterns,
and architecture — follow them strictly.

## Your Workflow — execute IN ORDER, run fully autonomously, do not stop between phases unless blocked.

### Phase 1: Understand and Plan
1. Read the task above.
2. Read CLAUDE.md for project conventions and the existing code relevant to the task.
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
   "## Summary" and a "## Verification" section. (No issue to close — omit any "Closes" line.)

## Critical Rules
1. You are in an isolated git worktree at the working directory above. Stay within it.
2. Do NOT ask questions or wait for input — run fully autonomously.
3. If you write ANY code, you MUST commit, push, AND open a PR. Never leave code without a PR.
4. If the task needs no code (a report/summary), set outcome=discovery and put the result in the
   summary — do not open an empty PR.
5. If you hit an unrecoverable blocker (e.g. infra down), set outcome=blocked and explain.

## Final output (REQUIRED)
As the very last line of your response, print one line of machine-readable JSON, prefixed exactly
with \`MILO_RESULT=\` and nothing after it, e.g.:

MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/OWNER/${repo.name}/pull/123","summary":"Did X; verify passed."}

Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL (or null), and summary is one or two sentences.`;
}

export interface AttachPromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  pr: PullRequest;
  /** What triggered the attach (e.g. the @milo mention body, or a default follow-up instruction). */
  instruction: string;
}

export interface LinearAttachPromptInput {
  repo: RepoConfig;
  worktree: Worktree;
  issue: LinearIssue;
  /** The existing PR this work belongs to (Milo already opened it for this ticket). */
  prUrl: string;
  /** The revision request — typically the latest `@milo` comment body. */
  instruction: string;
}

/**
 * The follow-up prompt for **Linear revision (attach) mode**: Milo already implemented this ticket
 * and opened a PR; the user has now asked (via a Linear comment / agent chat) for a change. The
 * ticket's existing branch is checked out and the PR is open — the agent revises it and pushes to
 * the SAME branch. It must NOT open a second PR (pushing the branch updates the existing one).
 */
export function buildLinearAttachPrompt({ repo, worktree, issue, prUrl, instruction }: LinearAttachPromptInput): string {
  const comments =
    issue.comments.length > 0
      ? issue.comments.map((c) => `[${c.author} — ${c.createdAt}]:\n${c.body}`).join("\n\n")
      : "No comments";

  return `<context>
  <repository>${repo.name}</repository>
  <working_directory>${worktree.path}</working_directory>
  <base_branch>${worktree.baseBranch}</base_branch>
  <branch>${worktree.branch}</branch>
  <package_manager>${repo.packageManager}</package_manager>
</context>

<linear_issue>
  <identifier>${issue.identifier}</identifier>
  <title>${issue.title}</title>
  <url>${issue.url}</url>
  <existing_pull_request>${prUrl}</existing_pull_request>
  <description>
${issue.description || "No description"}
  </description>
  <comments>
${comments}
  </comments>
</linear_issue>

<requested_change>
${instruction}
</requested_change>

You already implemented this ticket and opened the pull request above. The user has now asked for a
revision (see "requested_change"). The ticket's existing branch is already checked out in the working
directory, and the PR is already open. The CLAUDE.md in this repository contains all project
conventions — follow them strictly.

## Your Workflow — execute IN ORDER, run fully autonomously, do not stop between phases unless blocked.

### Phase 1: Understand
1. Read the requested change above, the ticket, and the prior comments for context.
2. Read CLAUDE.md and the code relevant to the request (including what you changed before).

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
4. If you hit an unrecoverable blocker, set outcome=blocked and explain.

## Final output (REQUIRED)
As the very last line of your response, print one line of machine-readable JSON, prefixed exactly
with \`MILO_RESULT=\` and nothing after it, e.g.:

MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"${prUrl}","summary":"Addressed the requested revision; verify passed."}

Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL, and summary is one or two sentences.`;
}

/**
 * The follow-up prompt for **attach mode**: an existing PR branch is already checked out and
 * already has an open PR. The agent makes the requested changes and pushes to the SAME branch —
 * it must NOT open a new PR (the PR already exists; pushing updates it).
 */
export function buildAttachPrompt({ repo, worktree, pr, instruction }: AttachPromptInput): string {
  return `<context>
  <repository>${repo.name}</repository>
  <working_directory>${worktree.path}</working_directory>
  <base_branch>${worktree.baseBranch}</base_branch>
  <branch>${worktree.branch}</branch>
  <package_manager>${repo.packageManager}</package_manager>
</context>

<pull_request>
  <number>${pr.number}</number>
  <title>${pr.title}</title>
  <url>${pr.url}</url>
  <body>
${pr.body || "No description"}
  </body>
</pull_request>

<requested_change>
${instruction}
</requested_change>

You are iterating on an EXISTING pull request. Its branch is already checked out in the working
directory above, and the PR is already open on GitHub. The CLAUDE.md in this repository contains all
project conventions — follow them strictly.

## Your Workflow — execute IN ORDER, run fully autonomously, do not stop between phases unless blocked.

### Phase 1: Understand
1. Read the requested change above and the PR description.
2. Read CLAUDE.md and the code relevant to the request.

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
4. If you hit an unrecoverable blocker, set outcome=blocked and explain.

## Final output (REQUIRED)
As the very last line of your response, print one line of machine-readable JSON, prefixed exactly
with \`MILO_RESULT=\` and nothing after it, e.g.:

MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"${pr.url}","summary":"Addressed the review feedback; verify passed."}

Where outcome is one of "implemented" | "discovery" | "blocked", wroteCode is a boolean, prUrl is the
PR URL, and summary is one or two sentences.`;
}
