import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { applyShellSetup, detectShellProfile } from "../src/init/shell-setup.js";

function fixture() {
  const root = mkdtempSync(join(os.tmpdir(), "milo-shell-"));
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "bin"), { recursive: true });
  writeFileSync(join(repoRoot, "bin", "milo.mjs"), "#!/usr/bin/env node\n");
  return {
    root,
    repoRoot,
    localBinDir: join(root, "local-bin"),
    profilePath: join(root, ".zshrc"),
  };
}

test("applyShellSetup creates the symlink and PATH export, and is idempotent on re-run", () => {
  const f = fixture();
  const plan = {
    createSymlink: true,
    writeMiloHomeExport: false,
    miloHome: join(f.root, ".milo"),
    repoRoot: f.repoRoot,
    localBinDir: f.localBinDir,
    profilePath: f.profilePath,
    pathEnv: "/usr/bin:/bin", // local-bin not on PATH → the export line is needed
  };

  const first = applyShellSetup(plan);
  assert.equal(first.symlink, "created");
  assert.equal(readlinkSync(join(f.localBinDir, "milo")), join(f.repoRoot, "bin", "milo.mjs"));
  assert.equal(first.profile, "updated");
  const profile = readFileSync(f.profilePath, "utf8");
  assert.match(profile, /export PATH=".*local-bin:\$PATH"/);

  // Re-running changes nothing and duplicates nothing.
  const second = applyShellSetup(plan);
  assert.equal(second.symlink, "exists");
  assert.equal(second.profile, "present");
  const again = readFileSync(f.profilePath, "utf8");
  assert.equal(again, profile, "no duplicate lines on re-run");
});

test("applyShellSetup writes the MILO_HOME export once", () => {
  const f = fixture();
  const plan = {
    createSymlink: false,
    writeMiloHomeExport: true,
    miloHome: "/data/milo",
    repoRoot: f.repoRoot,
    localBinDir: f.localBinDir,
    profilePath: f.profilePath,
    pathEnv: "",
  };

  const first = applyShellSetup(plan);
  assert.equal(first.symlink, "skipped");
  assert.equal(first.profile, "updated");
  const profile = readFileSync(f.profilePath, "utf8");
  assert.match(profile, /export MILO_HOME="\/data\/milo"/);

  const second = applyShellSetup(plan);
  assert.equal(second.profile, "present");
  assert.equal(readFileSync(f.profilePath, "utf8"), profile);
});

test("applyShellSetup never clobbers a foreign file at the symlink path", () => {
  const f = fixture();
  mkdirSync(f.localBinDir, { recursive: true });
  writeFileSync(join(f.localBinDir, "milo"), "#!/bin/sh\necho not milo\n");

  const r = applyShellSetup({
    createSymlink: true,
    writeMiloHomeExport: false,
    miloHome: join(f.root, ".milo"),
    repoRoot: f.repoRoot,
    localBinDir: f.localBinDir,
    profilePath: f.profilePath,
    pathEnv: "",
  });
  assert.equal(r.symlink, "error");
  assert.equal(readFileSync(join(f.localBinDir, "milo"), "utf8"), "#!/bin/sh\necho not milo\n", "file untouched");
  assert.ok(r.messages.some((m) => m.includes("left untouched")), "explains why");
});

test("applyShellSetup reports filesystem errors as messages instead of throwing", () => {
  const f = fixture();
  // A profile path whose parent directory doesn't exist → appendFileSync fails.
  const r = applyShellSetup({
    createSymlink: false,
    writeMiloHomeExport: true,
    miloHome: "/data/milo",
    repoRoot: f.repoRoot,
    localBinDir: f.localBinDir,
    profilePath: join(f.root, "no-such-dir", ".zshrc"),
    pathEnv: "",
  });
  assert.equal(r.profile, "error");
  assert.ok(r.messages.some((m) => m.includes("Add this yourself")), "fallback instructions printed");
  assert.equal(existsSync(join(f.root, "no-such-dir")), false);
});

test("detectShellProfile maps $SHELL to the right profile file", () => {
  const orig = process.env["SHELL"];
  try {
    process.env["SHELL"] = "/bin/zsh";
    assert.ok(detectShellProfile().endsWith(".zshrc"));
    process.env["SHELL"] = "/bin/bash";
    assert.ok(detectShellProfile().endsWith(".bashrc"));
    process.env["SHELL"] = "/bin/fish";
    assert.ok(detectShellProfile().endsWith(".profile"));
  } finally {
    if (orig === undefined) delete process.env["SHELL"];
    else process.env["SHELL"] = orig;
  }
});
