import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The shell-setup step of `milo init`: make the `milo` command available everywhere
 * (symlink into ~/.local/bin) and persist a non-default MILO_HOME into the shell profile.
 *
 * Everything here is idempotent and throw-free — re-running init never duplicates profile
 * lines or clobbers a foreign file, and filesystem errors come back as messages, not crashes.
 * Runs after the wizard exits (plain stdout land), never inside Ink.
 */

const SENTINEL = "# added by `milo init`";

export interface ShellSetupPlan {
  createSymlink: boolean;
  writeMiloHomeExport: boolean;
  /** The chosen Milo home (only written to the profile when writeMiloHomeExport is true). */
  miloHome: string;
  /** The milo repo root (for the bin/milo.mjs symlink target). */
  repoRoot: string;
  /** Overridable for tests. */
  localBinDir?: string;
  profilePath?: string;
  pathEnv?: string;
}

export interface ShellSetupResult {
  symlink: "created" | "exists" | "skipped" | "error";
  profile: "updated" | "present" | "skipped" | "error";
  /** Human-readable lines describing what happened (printed by init). */
  messages: string[];
}

/** The profile file matching $SHELL (zsh → ~/.zshrc, bash → ~/.bashrc, else ~/.profile). */
export function detectShellProfile(): string {
  const shell = process.env["SHELL"] ?? "";
  if (shell.endsWith("/zsh")) return join(homedir(), ".zshrc");
  if (shell.endsWith("/bash")) return join(homedir(), ".bashrc");
  return join(homedir(), ".profile");
}

/** True when `milo` already resolves on PATH or the ~/.local/bin symlink is in place. */
export function isMiloOnPath(): boolean {
  if (spawnSync("/usr/bin/which", ["milo"], { stdio: "ignore" }).status === 0) return true;
  return existsSync(join(homedir(), ".local", "bin", "milo"));
}

export function applyShellSetup(plan: ShellSetupPlan): ShellSetupResult {
  const messages: string[] = [];
  const localBin = plan.localBinDir ?? join(homedir(), ".local", "bin");
  const profilePath = plan.profilePath ?? detectShellProfile();
  const pathEnv = plan.pathEnv ?? process.env["PATH"] ?? "";

  // ---- 1. Symlink ~/.local/bin/milo → <repo>/bin/milo.mjs ----
  let symlink: ShellSetupResult["symlink"] = "skipped";
  if (plan.createSymlink) {
    const link = join(localBin, "milo");
    const target = join(plan.repoRoot, "bin", "milo.mjs");
    try {
      mkdirSync(localBin, { recursive: true });
      let existing: string | null = null;
      try {
        existing = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "";
      } catch {
        /* no existing entry */
      }
      if (existing === target) {
        symlink = "exists";
        messages.push(`✓ \`milo\` is already linked at ${link}`);
      } else if (existing !== null) {
        symlink = "error";
        messages.push(`! ${link} already exists and isn't Milo's — left untouched. Link it manually if you want:\n    ln -sf "${target}" "${link}"`);
      } else {
        symlinkSync(target, link);
        symlink = "created";
        messages.push(`✓ linked \`milo\` → ${link}`);
      }
    } catch (err) {
      symlink = "error";
      messages.push(`! couldn't create the \`milo\` symlink: ${(err as Error).message}`);
    }
  }

  // ---- 2. Shell profile: PATH (if needed) + MILO_HOME export ----
  let profile: ShellSetupResult["profile"] = "skipped";
  const wantPathLine =
    plan.createSymlink && symlink !== "error" && !pathEnv.split(delimiter).includes(localBin);
  const lines: string[] = [];
  if (wantPathLine) lines.push(`export PATH="${localBin}:$PATH"`);
  if (plan.writeMiloHomeExport) lines.push(`export MILO_HOME="${plan.miloHome}"`);

  if (lines.length > 0) {
    try {
      const current = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
      const missing = lines.filter((l) => !current.includes(l));
      if (missing.length === 0) {
        profile = "present";
        messages.push(`✓ ${profilePath} already has Milo's setup`);
      } else {
        appendFileSync(profilePath, `\n${SENTINEL}\n${missing.join("\n")}\n`);
        profile = "updated";
        messages.push(`✓ added to ${profilePath}:`);
        for (const l of missing) messages.push(`    ${l}`);
        messages.push(`  Restart your shell (or \`source ${profilePath}\`) to pick it up.`);
      }
    } catch (err) {
      profile = "error";
      messages.push(`! couldn't update ${profilePath}: ${(err as Error).message}. Add this yourself:`);
      for (const l of lines) messages.push(`    ${l}`);
    }
  }

  return { symlink, profile, messages };
}
