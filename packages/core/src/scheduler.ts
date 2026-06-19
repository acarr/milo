import { Cron } from "croner";
import { logger } from "./logger.js";

export interface ScheduleDef {
  name: string;
  cron: string;
  /** Free-form intent; `kind` selects behavior ("maintenance" | "prompt"). */
  intent: Record<string, unknown>;
  enabled: boolean;
}

export interface ScheduleStatus {
  name: string;
  cron: string;
  enabled: boolean;
  kind: string;
  nextRun: number | null;
  lastRun: number | null;
}

export type ScheduleFire = (def: ScheduleDef) => void | Promise<void>;

/**
 * Thin wrapper over croner: turns config `schedules[]` into live cron jobs and invokes `onFire`
 * for each tick. Keeps croner at the edge so the rest of the system stays testable. Validates
 * patterns up front (an invalid cron disables that schedule rather than crashing the daemon).
 */
export class Scheduler {
  private readonly crons: Cron[] = [];
  private readonly lastRun = new Map<string, number>();

  constructor(
    private schedules: ScheduleDef[],
    private readonly onFire: ScheduleFire,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True if `pattern` is a valid cron expression croner can parse. */
  static isValid(pattern: string): boolean {
    try {
      const c = new Cron(pattern, { paused: true });
      c.stop();
      return true;
    } catch {
      return false;
    }
  }

  /** Next fire time (epoch ms) for a cron pattern, or null if invalid/none. Process-agnostic. */
  static nextRun(pattern: string): number | null {
    try {
      const c = new Cron(pattern, { paused: true });
      const next = c.nextRun()?.getTime() ?? null;
      c.stop();
      return next;
    } catch {
      return null;
    }
  }

  start(): void {
    for (const def of this.schedules) {
      if (!def.enabled) {
        logger.info({ schedule: def.name }, "schedule disabled — skipping");
        continue;
      }
      if (!Scheduler.isValid(def.cron)) {
        logger.warn({ schedule: def.name, cron: def.cron }, "invalid cron — schedule skipped");
        continue;
      }
      const cron = new Cron(def.cron, { name: def.name }, () => {
        this.lastRun.set(def.name, this.now());
        logger.info({ schedule: def.name }, "schedule fired");
        try {
          void this.onFire(def);
        } catch (err) {
          logger.warn({ schedule: def.name, err: (err as Error).message }, "schedule handler threw");
        }
      });
      this.crons.push(cron);
      logger.info({ schedule: def.name, cron: def.cron, nextRun: cron.nextRun() }, "schedule armed");
    }
  }

  stop(): void {
    for (const c of this.crons) c.stop();
    this.crons.length = 0;
  }

  /** Swap in a new schedule set (e.g. after in-repo `.milo/schedules.json` changed) and re-arm. */
  reload(schedules: ScheduleDef[]): void {
    this.stop();
    this.schedules = schedules;
    this.start();
  }

  status(): ScheduleStatus[] {
    const byName = new Map(this.crons.map((c) => [c.name, c]));
    return this.schedules.map((def) => ({
      name: def.name,
      cron: def.cron,
      enabled: def.enabled,
      kind: (def.intent["kind"] as string) ?? "prompt",
      nextRun: byName.get(def.name)?.nextRun()?.getTime() ?? null,
      lastRun: this.lastRun.get(def.name) ?? null,
    }));
  }
}

/** A default housekeeping schedule injected when the user hasn't defined their own maintenance one. */
export const DEFAULT_MAINTENANCE_SCHEDULE: ScheduleDef = {
  name: "maintenance",
  cron: "0 */6 * * *", // every 6 hours
  intent: { kind: "maintenance" },
  enabled: true,
};
