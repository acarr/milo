import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-daemon-state-"));
import { acquireDaemonLock, readDaemon, clearDaemon, writeDaemon, pidFilePath } from "@milo/core";

const home = () => process.env["MILO_HOME"]!;
const freshHome = () => {
  process.env["MILO_HOME"] = mkdtempSync(join(os.tmpdir(), "milo-daemon-state-"));
};

test("acquireDaemonLock acquires, records the pid atomically, and releases cleanly", () => {
  freshHome();
  const result = acquireDaemonLock(1234, 999);
  assert.equal(result.acquired, true);
  assert.deepEqual(readDaemon(), { pid: 1234, startedAt: 999 });
  // Atomic write: no temp files left behind.
  assert.equal(readdirSync(home()).filter((f) => f.includes(".tmp-")).length, 0);

  if (result.acquired) result.lock.release();
  // Released → pid file gone, lock re-acquirable.
  assert.equal(readDaemon(), undefined);
  const again = acquireDaemonLock(5678);
  assert.equal(again.acquired, true);
  if (again.acquired) again.lock.release();
});

test("a second acquire is refused while the lock is held, and reports the holder pid", () => {
  freshHome();
  const first = acquireDaemonLock(1111);
  assert.equal(first.acquired, true);

  const second = acquireDaemonLock(2222);
  assert.equal(second.acquired, false);
  if (!second.acquired) assert.equal(second.holderPid, 1111);
  // The loser must not clobber the winner's pid record.
  assert.equal(readDaemon()?.pid, 1111);

  if (first.acquired) first.lock.release();
  // After release the same caller can acquire.
  const third = acquireDaemonLock(2222);
  assert.equal(third.acquired, true);
  if (third.acquired) third.lock.release();
});

test("release only clears a pid file it still owns", () => {
  freshHome();
  const lock = acquireDaemonLock(1111);
  assert.equal(lock.acquired, true);
  // Simulate a newer daemon having taken over the pid record (e.g. after a crash + restart race).
  writeDaemon(2222);
  if (lock.acquired) lock.lock.release();
  assert.equal(readDaemon()?.pid, 2222, "release must not remove another daemon's pid record");
  clearDaemon();
});

test("legacy backstop: a live foreign pid record refuses acquisition even when the lock is free", () => {
  freshHome();
  // Simulate a pre-lock-era daemon: alive (this very test process) and recorded in daemon.pid,
  // but holding no SQLite lock.
  writeDaemon(process.pid);
  const result = acquireDaemonLock(777_777);
  assert.equal(result.acquired, false);
  if (!result.acquired) assert.equal(result.holderPid, process.pid);
  // The legacy daemon's record is left untouched.
  assert.equal(readDaemon()?.pid, process.pid);

  // Once that pid is gone (stale record), acquisition proceeds and overwrites it.
  writeDaemon(999_999_999); // far beyond pid_max → never alive
  const after = acquireDaemonLock(777_777);
  assert.equal(after.acquired, true);
  assert.equal(readDaemon()?.pid, 777_777);
  if (after.acquired) after.lock.release();
});

test("clearDaemon(ownerPid) is a no-op when the pid file belongs to someone else", () => {
  freshHome();
  writeDaemon(4242);
  clearDaemon(9999); // not the owner
  assert.equal(readDaemon()?.pid, 4242);
  clearDaemon(4242); // the owner
  assert.equal(readDaemon(), undefined);
});

test("writeDaemon survives a corrupt pid file and readDaemon tolerates garbage", () => {
  freshHome();
  writeFileSync(pidFilePath(), "{not json");
  assert.equal(readDaemon(), undefined);
  writeDaemon(7);
  assert.equal(readDaemon()?.pid, 7);
  clearDaemon();
});

// --- Cross-process: the lock excludes other processes and dies with its holder. ---

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hold-daemon-lock.ts");

function spawnHolder(miloHome: string): Promise<{ child: ChildProcess; output: string }> {
  return new Promise((resolve, reject) => {
    // Re-use this process's loader setup (node --import tsx), minus --test.
    const execArgv = process.execArgv.filter((a) => a !== "--test");
    const child = spawn(process.execPath, [...execArgv, fixture], {
      env: { ...process.env, MILO_HOME: miloHome },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve({ child, output: out.trim() });
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!out.includes("\n")) reject(new Error(`fixture exited (${code}) before reporting`));
    });
  });
}

test("the lock excludes other processes, and a SIGKILLed holder leaves no stale lock", async () => {
  freshHome();
  const lockHome = home();

  const { child, output } = await spawnHolder(lockHome);
  try {
    assert.equal(output, "LOCKED");

    // While the child holds the lock, this process cannot acquire it.
    const blocked = acquireDaemonLock();
    assert.equal(blocked.acquired, false);

    // Kill the holder hard — no graceful release.
    child.kill("SIGKILL");
    await new Promise<void>((res) => child.on("exit", () => res()));

    // The OS released the lock with the process: acquisition succeeds, no manual cleanup needed.
    const after = acquireDaemonLock();
    assert.equal(after.acquired, true, "a crashed daemon must not leave a stale lock");
    if (after.acquired) after.lock.release();
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});
