import { readFileSync, writeFileSync, existsSync, rmSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { miloHome } from "./paths.js";

export interface DaemonInfo {
  pid: number;
  startedAt: number;
}

export function pidFilePath(): string {
  return join(miloHome(), "daemon.pid");
}

/** The dedicated lock file backing the daemon singleton guard (separate from milo.db). */
export function lockFilePath(): string {
  return join(miloHome(), "daemon.lock");
}

export function readDaemon(): DaemonInfo | undefined {
  const p = pidFilePath();
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
}

/** True if a process with this pid exists (signal-0 probe). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness check
    return true;
  } catch {
    return false;
  }
}

/** True if a daemon process is recorded and still alive. */
export function isDaemonRunning(): boolean {
  const info = readDaemon();
  return info ? pidAlive(info.pid) : false;
}

/** Write the pid file atomically (write temp + rename) so readers never see a partial file. */
export function writeDaemon(pid = process.pid, now = Date.now()): void {
  mkdirSync(miloHome(), { recursive: true });
  const tmp = `${pidFilePath()}.tmp-${pid}`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt: now }));
  renameSync(tmp, pidFilePath());
}

/**
 * Remove the pid file. When `ownerPid` is given, only remove it if it still belongs to
 * that pid — so a stopping daemon never clobbers the record of a newer one.
 */
export function clearDaemon(ownerPid?: number): void {
  if (ownerPid !== undefined && readDaemon()?.pid !== ownerPid) return;
  try {
    rmSync(pidFilePath());
  } catch {
    /* ignore */
  }
}

/** A held daemon singleton lock. `release()` drops the OS lock and clears the pid file. */
export interface DaemonLock {
  release(): void;
}

export type DaemonLockResult =
  | { acquired: true; lock: DaemonLock }
  | { acquired: false; holderPid?: number };

/**
 * Acquire the exclusive daemon lock (the singleton guard, MILO-13).
 *
 * Race-free: backed by a `BEGIN EXCLUSIVE` SQLite transaction on a dedicated lock file —
 * an OS-level (fcntl) lock the kernel releases automatically when the holding process dies,
 * even on SIGKILL. So a crashed daemon never leaves a stale lock, and two daemons starting
 * simultaneously can never both win (unlike a read-check-write pid file).
 *
 * The pid file remains the human/CLI-readable record (`milo status`); it is written only
 * after the lock is held, and cleared on release only if still owned.
 */
export function acquireDaemonLock(pid = process.pid, now = Date.now()): DaemonLockResult {
  mkdirSync(miloHome(), { recursive: true });
  let opened: Database.Database | undefined;
  try {
    opened = new Database(lockFilePath());
    opened.pragma("busy_timeout = 0"); // fail immediately if another process holds the lock
    opened.exec("BEGIN EXCLUSIVE");
  } catch {
    // SQLITE_BUSY (or the open itself blocked): another daemon holds the lock.
    try {
      opened?.close();
    } catch {
      /* ignore */
    }
    return { acquired: false, holderPid: readDaemon()?.pid };
  }
  const db = opened;

  // Legacy backstop: a daemon started before this lock existed (or whose lock file was
  // removed) can be alive without holding it. Honor its live pid record rather than
  // double-running. (A stale record whose pid was recycled is the one false positive —
  // resolved by deleting daemon.pid.)
  const existing = readDaemon();
  if (existing && existing.pid !== pid && pidAlive(existing.pid)) {
    try {
      db.exec("ROLLBACK");
      db.close();
    } catch {
      /* ignore */
    }
    return { acquired: false, holderPid: existing.pid };
  }

  writeDaemon(pid, now);
  let released = false;
  return {
    acquired: true,
    lock: {
      release() {
        if (released) return;
        released = true;
        try {
          db.exec("ROLLBACK");
        } catch {
          /* connection already closed */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
        clearDaemon(pid);
      },
    },
  };
}
