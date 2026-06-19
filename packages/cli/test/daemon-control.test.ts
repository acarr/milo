import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-daemon-control-"));
import { readDaemon, pidAlive } from "@milo/core";
import { stopDaemon, restartDaemon } from "../src/run.js";

const freshHome = () => {
  process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-daemon-control-"));
};

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-daemon.ts");

/** Spawn the fake daemon and resolve once it has written daemon.pid. */
function spawnFakeDaemon(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const execArgv = process.execArgv.filter((a) => a !== "--test");
    const child = spawn(process.execPath, [...execArgv, fixture], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("READY")) resolve(child);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!out.includes("READY")) reject(new Error(`fake daemon exited (${code}) before READY`));
    });
  });
}

const exited = (child: ChildProcess) => new Promise<void>((res) => (child.exitCode !== null ? res() : child.on("exit", () => res())));

// Tests inject isLaunchd:false so the flow never shells out to launchctl, and (for restart)
// inject spawnDaemon so "starting a daemon" spawns the fixture instead of the real thing.
const manual = { isLaunchd: () => false };

test("milo stop: SIGTERMs a manually-run daemon, waits for the drain, reports stopped", async () => {
  freshHome();
  const daemon = await spawnFakeDaemon();
  assert.equal(readDaemon()?.pid, daemon.pid);

  const code = await stopDaemon([], manual);
  assert.equal(code, 0);
  await exited(daemon);
  assert.equal(pidAlive(daemon.pid!), false, "daemon process is gone");
  assert.equal(readDaemon(), undefined, "pid record cleared by the daemon's graceful shutdown");
});

test("milo stop: no-op (exit 0) when no daemon is running", async () => {
  freshHome();
  assert.equal(await stopDaemon([], manual), 0);
});

test("milo restart: when nothing is running, starts a daemon and confirms liveness", async () => {
  freshHome();
  let started: ChildProcess | undefined;
  let startPromise: Promise<ChildProcess> | undefined;
  const code = await restartDaemon([], {
    ...manual,
    spawnDaemon: () => {
      startPromise = spawnFakeDaemon().then((c) => (started = c));
    },
  });
  await startPromise;
  try {
    assert.equal(code, 0);
    assert.ok(started, "spawnDaemon was called");
    assert.equal(readDaemon()?.pid, started!.pid, "new daemon's pid is recorded and alive");
    assert.equal(pidAlive(started!.pid!), true);
  } finally {
    started?.kill("SIGKILL");
  }
});

test("milo restart: stops the old daemon, starts a new one, and reports the fresh pid", async () => {
  freshHome();
  const oldDaemon = await spawnFakeDaemon();
  const oldPid = oldDaemon.pid!;

  let newDaemon: ChildProcess | undefined;
  let startPromise: Promise<ChildProcess> | undefined;
  const code = await restartDaemon([], {
    ...manual,
    spawnDaemon: () => {
      startPromise = spawnFakeDaemon().then((c) => (newDaemon = c));
    },
  });
  await startPromise;
  try {
    assert.equal(code, 0);
    await exited(oldDaemon);
    assert.equal(pidAlive(oldPid), false, "old daemon was stopped");
    assert.ok(newDaemon, "a new daemon was spawned");
    assert.notEqual(newDaemon!.pid, oldPid);
    assert.equal(readDaemon()?.pid, newDaemon!.pid, "pid record points at the new daemon");
  } finally {
    newDaemon?.kill("SIGKILL");
  }
});
