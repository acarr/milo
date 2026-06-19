/**
 * Run guards (MILO-16): watchdogs that keep a runner process from outliving its usefulness.
 *
 * Why: `claude -p` can finish its work — emit the final stream-json `result` event — and then never
 * exit, because MCP servers and stray shells it spawned keep the CLI alive (seen live 2026-06-02:
 * two finished runs hung 4.5h, holding their entity locks and worktrees, with Linear never updated).
 * The runner promise only resolved on process exit, so a hung CLI meant a hung job forever; the
 * lease watchdog correctly refuses to reclaim a heartbeating job, so nothing recovered it.
 *
 * Three guards, each of which kills the runner's whole process group (the CLI plus everything it
 * spawned — MCP servers, shells, dev servers):
 *
 *  - **result-exit grace**: the result event arrived but the process didn't exit within the grace
 *    window → kill. The run still counts as a success — we already have its full output, and the
 *    pipeline's verification gate confirms ground truth from git/GitHub regardless.
 *  - **inactivity**: no output at all for `inactivityMs` → kill. The verification gate decides the
 *    outcome from whatever really happened on disk.
 *  - **wall clock**: the run exceeded `maxRunMs` end-to-end → kill (same).
 *
 * Spawn runners with `detached: true` so the child leads its own process group and `killTree` can
 * signal the entire tree at once.
 */

export interface GuardTimeouts {
  /** How long a process may linger after emitting its final result before being killed. */
  resultExitGraceMs: number;
  /** Kill the run if no stdout/stderr arrives for this long. */
  inactivityMs: number;
  /** Absolute wall-clock cap on a run. */
  maxRunMs: number;
}

export const DEFAULT_GUARDS: GuardTimeouts = {
  resultExitGraceMs: 30_000,
  inactivityMs: 20 * 60_000,
  maxRunMs: 3 * 60 * 60_000,
};

/** Kill a detached child's entire process group; falls back to the single pid. Safe on dead pids. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal); // negative pid → the whole process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export class RunGuards {
  private inactivity?: NodeJS.Timeout;
  private wallClock?: NodeJS.Timeout;
  private grace?: NodeJS.Timeout;
  private readonly timeouts: GuardTimeouts;
  /** Set when a guard killed the process AFTER its final result — the run still succeeded. */
  completedBeforeKill = false;
  /** Why a guard fired (undefined if none did). */
  killReason?: string;

  constructor(
    private readonly pid: number | undefined,
    overrides?: Partial<GuardTimeouts>,
    private readonly onKill?: (reason: string) => void,
  ) {
    this.timeouts = { ...DEFAULT_GUARDS, ...overrides };
    this.wallClock = setTimeout(() => this.kill("wall-clock cap exceeded"), this.timeouts.maxRunMs);
    this.touch();
  }

  /** Output arrived — the runner is alive; push the inactivity deadline out. */
  touch(): void {
    if (this.killReason) return;
    clearTimeout(this.inactivity);
    this.inactivity = setTimeout(() => this.kill("inactivity timeout"), this.timeouts.inactivityMs);
  }

  /**
   * The final result event arrived — the work is done. The process gets a short grace window to
   * exit on its own; if it doesn't (MCP children holding it open), it's killed and the run is
   * still treated as a success (`completedBeforeKill`).
   */
  sawResult(): void {
    if (this.grace || this.killReason) return;
    this.grace = setTimeout(() => {
      this.completedBeforeKill = true;
      this.kill("did not exit after its final result");
    }, this.timeouts.resultExitGraceMs);
  }

  /** The process exited on its own — disarm everything. */
  clear(): void {
    clearTimeout(this.inactivity);
    clearTimeout(this.wallClock);
    clearTimeout(this.grace);
  }

  private kill(reason: string): void {
    if (this.killReason) return;
    this.killReason = reason;
    this.clear();
    try {
      this.onKill?.(reason);
    } catch {
      /* a notifier must never break the kill path */
    }
    killTree(this.pid, "SIGTERM");
    // A tree that ignores SIGTERM gets SIGKILL; unref so this never holds the host process open.
    const escalate = setTimeout(() => killTree(this.pid, "SIGKILL"), 10_000);
    escalate.unref();
  }
}
