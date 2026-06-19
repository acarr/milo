import React from "react";
import { render } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { configPath, miloHome, worktreeBase } from "@milo/core";
import { runDoctor, runToolChecks, printDoctor } from "../doctor.js";
import { runLinearOAuth } from "../linear-auth.js";
import { runAddRepo } from "../repo-setup/index.js";
import { InitWizard, type InitResult } from "./InitWizard.js";
import { writeBaseConfig } from "./config-init.js";
import { applyShellSetup, isMiloOnPath } from "./shell-setup.js";

export { InitWizard } from "./InitWizard.js";
export type { InitResult, InitDefaults } from "./InitWizard.js";
export { writeBaseConfig } from "./config-init.js";
export type { InitConfigInput } from "./config-init.js";

async function confirm(question: string, def: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Race the question against the interface closing (EOF / piped stdin running out):
    // a closed stdin takes the default instead of hanging forever.
    const answer = (
      await Promise.race([
        rl.question(`${question} ${def ? "[Y/n]" : "[y/N]"} `),
        new Promise<string>((res) => rl.once("close", () => res(""))),
      ])
    )
      .trim()
      .toLowerCase();
    if (answer === "") return def;
    return answer.startsWith("y");
  } finally {
    rl.close();
  }
}

/** The repo root (for scripts/), resolved from this source file's location. */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/**
 * `milo init` — guided onboarding: quiet tool check → wizard (welcome, paths, Linear-with-auth,
 * webhooks, options, shell) → write config → install the daemon → shell setup → first repo(s) →
 * final doctor. Infer or default everything; ask only what can't be inferred. Never silently
 * overwrites an existing config.
 *
 * `--sandbox` makes the full flow safe to run end-to-end on a dev machine: config still goes to
 * MILO_HOME (point it at a temp dir), but the system-level writes — the launchd daemon install and
 * the shell-profile/symlink changes — are skipped and printed as "(sandbox) would …" instead.
 */
export async function runInit(argv: string[] = []): Promise<number> {
  const sandbox = argv.includes("--sandbox");

  console.log("\nPreparing Milo setup…");
  if (sandbox) {
    console.log(
      "Sandbox mode: no system changes (daemon install, shell profile, symlinks) will be made.\n" +
        "Config/db still write to MILO_HOME — point it at a temp dir to keep this run disposable.",
    );
  }

  // ---- 1. Quiet tool check (claude/codex/gh/docker — only problems are surfaced) ----
  // Path checks (config, store, worktrees, disk) wait for the final doctor: the user hasn't
  // even chosen where Milo lives yet.
  let tools = runToolChecks();

  const claude = tools.find((c) => c.name === "claude");
  if (claude?.status !== "ok") {
    console.error(
      "\nThe Claude Code CLI is required and wasn't found.\n" +
        "Install it from https://claude.com/claude-code and re-run `milo init`.",
    );
    return 1;
  }

  if (!process.stdin.isTTY) {
    console.error("\nmilo init is interactive — run it in a terminal (TTY).");
    return 1;
  }

  // gh auth is an interactive subprocess, so it has to happen before Ink owns the TTY.
  const gh = tools.find((c) => c.name === "gh");
  if (gh?.status !== "ok") {
    console.log("");
    if (await confirm("GitHub CLI isn't authenticated. Run `gh auth login` now?", true)) {
      spawnSync("gh", ["auth", "login"], { stdio: "inherit" });
      tools = runToolChecks();
      const again = tools.find((c) => c.name === "gh");
      if (again?.status !== "ok") console.warn("gh still isn't authenticated — PR creation will fail until it is.");
    }
  }

  // ---- 2. Existing state (config / Linear) ----
  const cfgPath = configPath();
  const configExists = existsSync(cfgPath);
  let linearConnected = false;
  if (configExists) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      linearConnected = typeof raw["linearToken"] === "string" && raw["linearToken"].length > 0;
    } catch {
      /* unparseable config — treat as not connected; init will rewrite a valid one */
    }
  }

  // ---- 3. The wizard ----
  const defaults = {
    miloHome: miloHome(),
    worktreeBase: worktreeBase(),
    standardMiloHome: join(homedir(), ".milo"),
  };
  const result = await new Promise<InitResult | null>((resolveResult) => {
    const app = render(
      React.createElement(InitWizard, {
        defaults,
        codexAvailable: tools.find((c) => c.name === "codex")?.status === "ok",
        linearConnected,
        configExists,
        miloOnPath: isMiloOnPath(),
        // The in-wizard Authenticate button drives the real OAuth flow.
        authenticate: (creds: { clientId: string; clientSecret: string }, signal?: AbortSignal) =>
          runLinearOAuth(creds, { openBrowser: true, ...(signal ? { signal } : {}) }),
        onDone: (r: InitResult | null) => resolveResult(r),
      }),
    );
    void app.waitUntilExit();
  });
  if (!result) {
    console.log("\nmilo init: cancelled — nothing was written.");
    return 1;
  }

  // The chosen home applies to everything below (config path, daemon env, doctor).
  if (result.miloHome !== defaults.miloHome) process.env["MILO_HOME"] = result.miloHome;

  // ---- 4. Write config (merge-preserving; tokens included when in-wizard auth succeeded) ----
  const defaultWtBase = join(result.miloHome, "worktrees");
  try {
    writeBaseConfig({
      worktreeBase: result.worktreeBase !== defaultWtBase ? result.worktreeBase : undefined,
      defaultRunner: result.defaultRunner,
      enableWebhook: result.enableWebhook,
      autoMerge: result.autoMerge,
      linearClientId: result.linear.clientId || undefined,
      linearClientSecret: result.linear.clientSecret || undefined,
      linearToken: result.linear.token || undefined,
      linearRefreshToken: result.linear.refreshToken || undefined,
    });
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    return 1;
  }
  console.log(`\n✓ wrote ${configPath()}`);

  if (result.linear.connected && result.linear.token) {
    console.log("✓ Linear connected");
  } else if (!result.linear.connected) {
    console.log("Skipped Linear — connect later with `milo linear-auth`.");
  }

  // ---- 5. Always-on daemon (core to the product — installed unconditionally, degrades gracefully) ----
  if (sandbox) {
    console.log(
      `\n(sandbox) skipped daemon install — would run scripts/install-launchd.sh with MILO_HOME=${result.miloHome}`,
    );
  } else if (process.platform === "darwin") {
    const script = join(repoRoot(), "scripts", "install-launchd.sh");
    if (existsSync(script)) {
      console.log("\nInstalling the always-on daemon so Milo starts at login and picks up work automatically…");
      const r = spawnSync("bash", [script], {
        stdio: "inherit",
        env: { ...process.env, MILO_HOME: result.miloHome },
      });
      if (r.status !== 0) {
        console.warn("The daemon install reported an issue (see above) — `milo daemon` still works manually.");
      }
    } else {
      console.warn(`\nDaemon install script not found at ${script} — run \`milo daemon\` manually.`);
    }
  } else {
    console.log("\nDaemon auto-start is macOS-only here — run `milo daemon` to keep Milo working in the background.");
  }

  // ---- 6. Webhook follow-up (only when enabled) ----
  if (result.enableWebhook) {
    console.log(
      "\nWebhook acceleration enabled (webhook.enabled=true). To finish:\n" +
        "  1. Expose 127.0.0.1:3457 publicly — Tailscale Funnel is the one-tap path\n" +
        "     (bash scripts/setup-funnel.sh), but any HTTPS tunnel/proxy works.\n" +
        "  2. Set trust.webhookSecrets.{linear,github} in config.json.\n" +
        "  3. Register the webhook URLs in Linear/GitHub.\n" +
        "Polling remains the system of record — webhooks only lower latency.",
    );
  }

  // ---- 7. Shell setup (symlink + profile exports) ----
  if (sandbox && (result.shell.createSymlink || result.shell.writeMiloHomeExport)) {
    console.log("\n(sandbox) skipped shell setup — would have:");
    if (result.shell.createSymlink) {
      console.log(`  • symlinked ~/.local/bin/milo → ${join(repoRoot(), "bin", "milo.mjs")}`);
    }
    if (result.shell.writeMiloHomeExport) {
      console.log(`  • added export MILO_HOME="${result.miloHome}" to your shell profile`);
    }
  } else if (result.shell.createSymlink || result.shell.writeMiloHomeExport) {
    const shell = applyShellSetup({
      createSymlink: result.shell.createSymlink,
      writeMiloHomeExport: result.shell.writeMiloHomeExport,
      miloHome: result.miloHome,
      repoRoot: repoRoot(),
    });
    console.log("");
    for (const line of shell.messages) console.log(line);
  }

  // ---- 8. First repo(s) ----
  const canAddRepos = linearConnected || (result.linear.connected && !!result.linear.token);
  if (canAddRepos) {
    console.log("\nNow let's add your first repository.\n");
    let again = true;
    while (again) {
      await runAddRepo([]);
      again = await confirm("\nAdd another repo?", false);
    }
  } else {
    console.log(
      "\nRepositories can only be mapped to Linear teams once Linear is connected.\n" +
        "Run `milo linear-auth`, then `milo add-repo`, when you're ready.",
    );
  }

  // ---- 9. Final verify ----
  console.log("\nFinal check:\n");
  return printDoctor(runDoctor(), false);
}
