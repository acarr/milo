import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-daemon-control-"));
import { readDaemon, pidAlive, openDatabase, JobStore } from "@milo/core";
import { stopDaemon, restartDaemon } from "../src/run.js";

const freshHome = () => {
  process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-daemon-control-"));
};

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = join(fixtureDir, "fake-daemon.ts");
/** Like `fake-daemon`, but never exits on SIGTERM — it "drains" past any wait window. */
const drainingFixture = join(fixtureDir, "draining-daemon.ts");

/** Spawn the fake daemon and resolve once it has written daemon.pid. */
function spawnFakeDaemon(script = fixture): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const execArgv = process.execArgv.filter((a) => a !== "--test");
    const child = spawn(process.execPath, [...execArgv, script], {
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

// --- A restart issued mid-job is a drain, not a failure -----------------------------------------
// `kickstart -k` / SIGTERM only asks the daemon to stop; it then finishes its in-flight jobs first,
// which can take hours. The old code waited 30s and reported failure, while launchd's KeepAlive
// respawned a replacement every ~10s that stood down on the singleton lock.

/** Record console output so a test can assert on what the operator was told. */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  return {
    lines,
    restore: () => {
      console.log = log;
      console.error = err;
    },
  };
}

/** Put one in-flight job in the store so the drain report has something to name. */
function seedRunningJob(ref: string): void {
  const db = openDatabase();
  const store = new JobStore(db);
  const { job } = store.enqueue({ source: "cli", entityId: ref, triggerType: "issue.start", repo: "sbx" });
  store.transition(job.id, "claimed");
  store.transition(job.id, "running");
  db.close();
}

test("milo restart (launchd): a draining daemon is reported as in-progress, not a failure", async () => {
  freshHome();
  seedRunningJob("SBX-1");
  const daemon = await spawnFakeDaemon(drainingFixture);
  let kicked = false;
  const cap = captureLog();
  let code: number;
  try {
    code = await restartDaemon([], {
      isLaunchd: () => true,
      kickstart: () => {
        kicked = true;
        daemon.kill("SIGTERM"); // what `kickstart -k` does: ask, don't force
        return true;
      },
      liveWaitMs: 300,
    });
  } finally {
    cap.restore();
    daemon.kill("SIGKILL");
  }
  const out = cap.lines.join("\n");
  assert.equal(kicked, true, "kickstart ran");
  assert.equal(code, 0, "a drain in progress is not a failure");
  assert.equal(pidAlive(daemon.pid!), true, "the old daemon is still draining");
  assert.match(out, /finishing 1 in-flight job\(s\) before it restarts/);
  assert.match(out, /SBX-1 \(running, sbx\)/, "names the job it is waiting on");
  assert.match(out, /launchd restarts it automatically/);
  assert.doesNotMatch(out, /did not come back within 30s/, "the false-failure message is gone");
});

test("milo restart (launchd, --force): SIGKILLs a daemon that won't drain", async () => {
  freshHome();
  const daemon = await spawnFakeDaemon(drainingFixture);
  let newDaemon: ChildProcess | undefined;
  let startPromise: Promise<ChildProcess> | undefined;
  const cap = captureLog();
  try {
    await restartDaemon(["--force"], {
      isLaunchd: () => true,
      kickstart: () => {
        daemon.kill("SIGTERM");
        // launchd would relaunch once the job is really gone; do it after the SIGKILL lands.
        startPromise = exited(daemon).then(() => spawnFakeDaemon().then((c) => (newDaemon = c)));
        return true;
      },
      liveWaitMs: 5_000,
    });
    await startPromise;
  } finally {
    cap.restore();
    newDaemon?.kill("SIGKILL");
    daemon.kill("SIGKILL");
  }
  assert.match(cap.lines.join("\n"), /--force: SIGKILLing the draining daemon/);
  assert.equal(pidAlive(daemon.pid!), false, "--force is no longer a no-op on the launchd path");
});

test("milo restart (manual): a draining daemon stays an error — nothing will restart it", async () => {
  freshHome();
  seedRunningJob("SBX-2");
  const daemon = await spawnFakeDaemon(drainingFixture);
  const cap = captureLog();
  let code: number;
  try {
    code = await restartDaemon([], { isLaunchd: () => false, spawnDaemon: () => {}, stopWaitMs: 300, liveWaitMs: 300 });
  } finally {
    cap.restore();
    daemon.kill("SIGKILL");
  }
  const out = cap.lines.join("\n");
  assert.equal(code, 1, "without launchd KeepAlive the restart really did not happen");
  assert.match(out, /finishing 1 in-flight job\(s\) before it exits/);
  assert.match(out, /SBX-2 \(running, sbx\)/);
  assert.match(out, /--force/);
});
