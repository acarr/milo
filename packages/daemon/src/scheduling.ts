import {
  Scheduler,
  runMaintenance,
  worktreeBase,
  logsDir,
  logger,
  DEFAULT_MAINTENANCE_SCHEDULE,
  discoverRepoSchedules,
  resolvePromptScheduleJob,
  type ScheduleDef,
  type JobStore,
  type MiloConfig,
} from "@milo/core";

export interface SchedulingDeps {
  config: MiloConfig;
  store: JobStore;
}

export interface SchedulingControls {
  stop: () => void;
  /** Re-discover in-repo schedules and re-arm the scheduler if the effective set changed. */
  reload: () => void;
}

/**
 * The effective schedule set: a built-in maintenance schedule (every 6h) unless the user defined one,
 * the user's central `config.schedules`, and every in-repo `.milo/schedules.json` entry discovered
 * across the configured repos.
 */
export function effectiveSchedules(config: MiloConfig): ScheduleDef[] {
  const central = config.schedules.map((s) => ({ ...s })) as ScheduleDef[];
  const hasMaintenance = central.some((d) => (d.intent?.["kind"] as string) === "maintenance");
  const base = hasMaintenance ? central : [DEFAULT_MAINTENANCE_SCHEDULE, ...central];
  return [...base, ...discoverRepoSchedules(config)];
}

/** A stable fingerprint of the effective schedules — reload re-arms only when this changes. */
function scheduleSignature(defs: ScheduleDef[]): string {
  return JSON.stringify(
    defs
      .map((d) => ({ n: d.name, c: d.cron, e: d.enabled, i: d.intent }))
      .sort((a, b) => a.n.localeCompare(b.n)),
  );
}

/**
 * Start the in-daemon scheduler (croner). On each fire we either run housekeeping
 * (`kind: "maintenance"`) or run a scheduled prompt (`kind: "prompt"` — enqueue a `source:"prompt"`
 * job), recording the run so `milo schedules` and the TUI show last/next fire across processes.
 * Returns a stop fn plus a `reload` the poll loop calls to pick up `.milo/schedules.json` changes.
 */
export function startScheduling(deps: SchedulingDeps): SchedulingControls {
  const { config, store } = deps;

  const onFire = async (def: ScheduleDef): Promise<void> => {
    const kind = (def.intent["kind"] as string) ?? "prompt";
    try {
      if (kind === "maintenance") {
        const report = await runMaintenance({
          worktreeBasePath: worktreeBase(config.worktreeBase),
          logsDir: logsDir(),
          activePaths: store.activeWorktreePaths(),
        });
        const detail = `pruned=${report.worktreesPruned.length} logs=${report.logsDeleted} freeGb=${
          Number.isFinite(report.freeGb) ? report.freeGb.toFixed(1) : "?"
        }`;
        store.recordScheduleRun(def.name, kind, detail);
        logger.info({ schedule: def.name, ...report }, "maintenance run complete");
      } else if (kind === "prompt") {
        const newJob = resolvePromptScheduleJob(config, def, store.lastScheduleRun(def.name));
        const { job, disposition } = store.enqueue(newJob);
        store.recordScheduleRun(def.name, kind, `${disposition} ${job.id}`);
        logger.info({ schedule: def.name, jobId: job.id, disposition }, "scheduled prompt enqueued");
      } else {
        // schedule-a-ticket (`kind: "enqueue"`) was removed in favor of prompt scheduling.
        store.recordScheduleRun(def.name, kind, `ignored unknown kind "${kind}"`);
        logger.warn({ schedule: def.name, kind }, "unknown schedule kind — ignoring");
      }
    } catch (err) {
      store.recordScheduleRun(def.name, kind, `error: ${(err as Error).message}`);
      logger.warn({ schedule: def.name, err: (err as Error).message }, "schedule handler failed");
    }
  };

  const scheduler = new Scheduler(effectiveSchedules(config), onFire);
  scheduler.start();
  let lastSig = scheduleSignature(effectiveSchedules(config));

  const reload = (): void => {
    try {
      const defs = effectiveSchedules(config);
      const sig = scheduleSignature(defs);
      if (sig === lastSig) return;
      lastSig = sig;
      scheduler.reload(defs);
      logger.info({ count: defs.length }, "schedules reloaded (in-repo .milo/schedules.json changed)");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "schedule reload failed");
    }
  };

  return { stop: () => scheduler.stop(), reload };
}
