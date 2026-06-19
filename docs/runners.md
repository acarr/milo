# Runners

A **runner** is the agent process that actually does the coding. Milo ships two —
**ClaudeRunner** (default) and **CodexRunner** — behind a small registry, and the `core` pipeline calls
whichever is injected. Both use your interactive **subscription**, never API billing
(`packages/runners/src/{claude,codex,result}.ts`).

---

## Selection precedence

The router (`packages/core/src/router.ts`) picks the runner in this order (first match wins):

1. **Explicit tag** in the issue title/description — `[agent=claude]` or `[agent=codex]`.
2. **Label** — `runner:claude` or `runner:codex`.
3. **Repo default** — `repositories[].defaultRunner`.
4. **Global default** — `runnerDefaults.default` (ships `claude`).

### Model selection

`modelFor` returns the **first** entry of the chosen runner's `modelChain`:

- Claude: `["opus", "sonnet", "haiku"]` → uses **opus**.
- Codex: `["gpt-5.5"]` → uses **gpt-5.5**.

> Only `chain[0]` is used today. Falling back along the chain on overload/crash is a planned follow-up
> (REMAINING-WORK B3).

---

## ClaudeRunner (`runClaude`)

Invokes Claude Code headlessly:

```
claude -p --dangerously-skip-permissions --model <model> \
       [--append-system-prompt <augment>] --verbose <prompt>
```

| Flag | Why |
|------|-----|
| `-p` | Headless: prompt comes from the arg, not stdin (stdin is ignored to avoid a `claude -p` stall). |
| `--dangerously-skip-permissions` | No interactive permission prompts (it's automation). |
| `--model` | The selected model. |
| `--append-system-prompt` | The combined global + per-repo prompt augmentation. |

**Environment:** strips `ANTHROPIC_API_KEY` and Claude-Code-specific vars to force OAuth/subscription
auth, and ensures `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin` are on PATH. stdout+stderr
are captured to the run's log file (and optionally mirrored to an `echo` stream).

---

## CodexRunner (`runCodex`)

Invokes Codex's headless `exec`:

```
codex exec --json --ephemeral --skip-git-repo-check -s workspace-write \
      -c sandbox_workspace_write.network_access=true \
      -C <cwd> --output-last-message <tmpfile> [-m <model>] <prompt>
```

| Flag | Why |
|------|-----|
| `--json` | JSONL output. |
| `--ephemeral` | No saved session state. |
| `-s workspace-write` | Sandbox: read/write the workspace, but **no access to the real `.git`**. |
| `-c …network_access=true` | Allow network (needed to push and open PRs). |
| `--output-last-message <file>` | Final message written to a temp file so the result parser gets it clean (un-escaped). |
| `-m <model>` | Model override (unless `default`). |

Codex has no `--append-system-prompt`, so augmentation is **prepended** to the prompt. OpenAI/Claude
keys are scrubbed from the env to force subscription auth.

### The Codex git-sandbox gotcha
Under `-s workspace-write` Codex commits via an alternate `GIT_OBJECT_DIRECTORY` (it cannot touch the
real `.git`), so it leaves the working tree **dirty with no branch commit**. That's fine — the
[verification gate](./reliability.md#the-verification-gate) sees the dirty tree and commits/pushes/opens
the PR itself. **Don't "fix" Codex's git;** the gate is the proven backstop (e.g. SBX-7 → PR #7).

---

## The `MILO_RESULT` protocol

Runners are asked (by the prompt) to end their output with a single machine-readable line:

```
MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/owner/repo/pull/123","summary":"…"}
```

`parseRunnerResult` (`result.ts`) extracts the **last** `MILO_RESULT=` line and parses the JSON:

| Field | Type | Meaning |
|-------|------|---------|
| `outcome` | `implemented` \| `discovery` \| `blocked` | What the runner believes happened. |
| `wroteCode` | boolean | Whether it wrote code. |
| `prUrl` | string \| null | PR it claims to have opened. |
| `summary` | string | Human-readable summary, posted back to Linear/GitHub. |

**Fallback parsing** if `MILO_RESULT` is absent: grep the output for a GitHub PR URL — found →
`implemented` + that URL; none → `discovery`. Either way, this is only the *declared* outcome — the
[verification gate](./reliability.md) resolves the ground truth and is what actually decides `done` vs
`discovery-done` vs remediation.

---

## The prompt

`buildPrompt` (create) and `buildAttachPrompt` (attach) assemble the runner input
(`packages/core/src/prompt.ts`). The create prompt wraps repo context, the Linear issue (title,
description, labels, priority, comments), and the routing instruction in tagged sections, then gives a
**6-phase workflow**:

1. **Understand & plan** — read the ticket, `CLAUDE.md`, relevant code.
2. **Implement** — make the change.
3. **Verify** — run the project's verify script (or typecheck/build/test/lint).
4. **Fix & re-verify** — up to 3 attempts.
5. **Commit & push** — stage explicitly, commit `Implements <ID>`, `git push -u origin HEAD`.
6. **Create PR** — if none exists, open one whose body includes `Closes <ID>`.

Hard rules in the prompt: no code → don't invent, set `outcome: discovery`; any code → you **must**
commit, push, **and** open the PR; unrecoverable blocker → `outcome: blocked`. The attach prompt is
similar but omits step 6 (the PR already exists) and uses the `@milo` instruction in place of routing.

---

## Run guards (MILO-16)

Both runners spawn their CLI **detached** (the child leads its own process group) and arm three
watchdogs (`packages/runners/src/guards.ts`) that kill the **whole process group** — the CLI plus
every MCP server / shell / dev server it spawned:

| Guard | Default | Fires when | Outcome |
|-------|---------|------------|---------|
| Result-exit grace | 30s | The final `result` event arrived but the process didn't exit (e.g. MCP children holding it open) | Run resolves as **success** — the output is complete |
| Inactivity | 20 min | No stdout/stderr at all | Run resolves with a non-zero code; the verification gate decides the real outcome |
| Wall clock | 3h | The run exceeded the absolute cap | Same as inactivity |

The guards exist because of a live incident (2026-06-02): two `claude -p` runs finished their work,
pushed their PRs, emitted their final results — and then never exited, because user-scope MCP servers
(`context7`, `chrome-devtools`) kept the CLI alive. The jobs sat in `running` for 4.5 hours holding
their entity locks and worktrees; the lease watchdog correctly refused to reclaim them (their
heartbeats were healthy). Guards make hung-CLI a non-event: the run resolves, verification confirms
ground truth, the job completes.

Codex has no reliable terminal stream event, so only the inactivity + wall-clock guards apply there
(completion is signaled by process exit). Timeouts are overridable per run via the `guards` option;
tests use a fake CLI via the `bin` option (`packages/runners/test/guards.test.ts`).
