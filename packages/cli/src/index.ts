#!/usr/bin/env node
import { existsSync } from "node:fs";
import { configPath } from "@milo/core";
import { runDoctor, printDoctor } from "./doctor.js";
import { runIssues, runPrompt, listJobs, showJob, watchJob, rerunJob, retryJob, cancelJob, listRepos, removeRepo, status, tailLog, pollNow, listSchedules, restartDaemon, stopDaemon } from "./run.js";
import type { JobsFilter, StateFilter } from "./viewmodel.js";
import { linearAuth } from "./linear-auth.js";

const HELP = `milo — local autonomous coding agent

Usage:
  milo <ID> [<ID>...]     enqueue Linear issues (daemon runs them, else runs inline)
  milo                    interactive TUI (same as \`milo ui\`)
  milo ui                 interactive TUI
  milo init [--sandbox]   guided setup: environment check, Linear, first repo
                          (--sandbox: full dry run — no daemon install or shell-profile writes)
  milo add-repo [path]    wire a git repo into Milo (infers details, maps Linear teams)
  milo repos [--json]     list configured repositories
  milo remove-repo <name> remove a repo from config
  milo jobs [--json]      list jobs (filters: --state <s> --repo <r> --search <q>)
  milo job <jobId>        full detail for one job (events, deps, PR, failure)
  milo status [--json]    daemon liveness + queue counts
  milo logs <id>          print the latest raw runner log for an issue
  milo watch <id> [--json] stream a job's live transcript (replay + tail)
  milo rerun <id>         re-run a job from scratch as a new job
  milo retry <id>         re-queue a failed/needs-attention job in place
  milo cancel <id>        cancel a queued or in-flight job (kills the runner)
  milo daemon             run the always-on worker (usually launched by launchd)
  milo restart [--force]  restart the daemon (picks up new code; --force skips graceful drain)
  milo stop [--force]     stop the daemon (graceful; --force SIGKILLs)
  milo poll               poll Linear + GitHub once and enqueue any new work
  milo schedules [--json] list scheduled automations (next/last run)
  milo prompt <name>      run a scheduled prompt now (from <repo>/.milo/schedules.json)
  milo doctor [--json]    check the environment is ready
  milo linear-auth        register Milo as a Linear agent (OAuth actor=app)
  milo --help             show this help
`;

/** Read the value of a `--flag value` pair from argv (returns undefined if absent or trailing). */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0];
  const json = args.includes("--json");

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (!cmd || cmd === "ui") {
    // Auto-suggest onboarding: a bare `milo` with no config means a fresh install.
    if (!existsSync(configPath())) {
      if (process.stdin.isTTY) {
        console.log("No Milo config found — starting setup. (Ctrl-C / Esc to cancel; `milo init` re-runs it.)");
        const { runInit } = await import("./init/index.js");
        return runInit([]);
      }
      console.error(`No Milo config found at ${configPath()}. Run \`milo init\` to get started.`);
      return 1;
    }
    const { runTui } = await import("./ui.js");
    await runTui();
    return 0;
  }

  switch (cmd) {
    case "init": {
      const { runInit } = await import("./init/index.js");
      return runInit(args.slice(1));
    }
    case "doctor":
      return printDoctor(runDoctor(), json);
    case "linear-auth":
      return linearAuth(args.slice(1));
    case "add-repo": {
      const { runAddRepo } = await import("./repo-setup/index.js");
      return runAddRepo(args.slice(1));
    }
    case "repos":
      return listRepos(json);
    case "remove-repo": {
      const name = args[1];
      if (!name) {
        console.error("usage: milo remove-repo <name>");
        return 1;
      }
      return removeRepo(name);
    }
    case "jobs": {
      const filter: JobsFilter = {};
      const state = flagValue(args, "--state");
      if (state) filter.state = state as StateFilter;
      const repo = flagValue(args, "--repo");
      if (repo) filter.repo = repo;
      const search = flagValue(args, "--search");
      if (search) filter.search = search;
      return listJobs(json, filter);
    }
    case "job": {
      const id = args[1];
      if (!id) {
        console.error("usage: milo job <jobId>");
        return 1;
      }
      return showJob(id, json);
    }
    case "status":
      return status(json);
    case "logs": {
      const id = args[1];
      if (!id) {
        console.error("usage: milo logs <ISSUE-ID>");
        return 1;
      }
      return tailLog(id);
    }
    case "watch": {
      const id = args[1];
      if (!id) {
        console.error("usage: milo watch <ISSUE-ID | jobId>");
        return 1;
      }
      return watchJob(id, json);
    }
    case "rerun": {
      const id = args[1];
      if (!id) {
        console.error("usage: milo rerun <ISSUE-ID | jobId>");
        return 1;
      }
      return rerunJob(id);
    }
    case "retry": {
      const id = args[1];
      if (!id) {
        console.error("usage: milo retry <ISSUE-ID | jobId>");
        return 1;
      }
      return retryJob(id);
    }
    case "cancel": {
      const id = args[1];
      if (!id) {
        console.error("usage: milo cancel <ISSUE-ID | jobId>");
        return 1;
      }
      return cancelJob(id);
    }
    case "daemon": {
      const { startDaemon } = await import("@milo/daemon");
      try {
        await startDaemon();
      } catch (err) {
        // e.g. the singleton guard refusing because a daemon already holds the lock.
        console.error(`[milo] ${(err as Error).message}`);
        return 1;
      }
      return 0;
    }
    case "restart":
      return restartDaemon(args.slice(1));
    case "stop":
      return stopDaemon(args.slice(1));
    case "poll":
      return pollNow(json);
    case "schedules":
      return listSchedules(json);
    case "prompt": {
      const name = args[1];
      if (!name) {
        console.error("usage: milo prompt <schedule-name>");
        return 1;
      }
      return runPrompt(name);
    }
    default: {
      const ids = args.filter((a) => /^[A-Z][A-Z0-9]*-\d+$/.test(a));
      if (ids.length > 0) {
        return runIssues(ids);
      }
      console.error(`Unknown command: ${cmd}\n`);
      process.stdout.write(HELP);
      return 1;
    }
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[milo] fatal: ${err?.stack ?? err}`);
    if (/Config not found/.test(String(err?.message ?? err))) {
      console.error("\nRun `milo init` to get started.");
    }
    process.exit(1);
  });
