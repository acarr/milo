#!/usr/bin/env node
import { existsSync } from "node:fs";
import { configPath } from "@milo/core";
import { runDoctor, printDoctor } from "./doctor.js";
import { runIssues, runPrompt, listJobs, status, tailLog, pollNow, listSchedules, restartDaemon, stopDaemon } from "./run.js";
import { linearAuth } from "./linear-auth.js";

const HELP = `milo — local autonomous coding agent

Usage:
  milo <ID> [<ID>...]     enqueue Linear issues (daemon runs them, else runs inline)
  milo                    interactive TUI (same as \`milo ui\`)
  milo ui                 interactive TUI
  milo init [--sandbox]   guided setup: environment check, Linear, first repo
                          (--sandbox: full dry run — no daemon install or shell-profile writes)
  milo add-repo [path]    wire a git repo into Milo (infers details, maps Linear teams)
  milo jobs [--json]      list jobs and their state
  milo status [--json]    daemon liveness + queue counts
  milo logs <id>          print the latest runner log for an issue
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
    case "jobs":
      return listJobs(json);
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
