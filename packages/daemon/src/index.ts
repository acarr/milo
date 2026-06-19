import {
  loadConfig,
  openDatabase,
  JobStore,
  JobQueue,
  makeProcessJob,
  LinearClient,
  makeReconcileTicker,
  logger,
  acquireDaemonLock,
} from "@milo/core";
import { runClaude, runCodex, parseRunnerResult } from "@milo/runners";
import { startPolling } from "./poller.js";
import { startScheduling } from "./scheduling.js";
import { startWebhookServer } from "./webhook-server.js";

export { startPolling, pollOnce } from "./poller.js";
export type { PollerDeps } from "./poller.js";
export { startScheduling, effectiveSchedules } from "./scheduling.js";
export { startWebhookServer } from "./webhook-server.js";
import { fileURLToPath } from "node:url";

/**
 * The long-lived Milo daemon: continuously drains the job queue with managed concurrency.
 * Started by launchd (RunAtLoad+KeepAlive) or `milo daemon`. The CLI/TUI observe via the
 * shared SQLite DB (WAL allows concurrent reads), so no HTTP is needed until Phase 6 webhooks.
 */
export async function startDaemon(): Promise<void> {
  // Singleton guard (MILO-13): an OS-level exclusive lock, acquired before touching the DB,
  // binding ports, or polling — so N concurrent `milo daemon`s can never double-process.
  const guard = acquireDaemonLock();
  if (!guard.acquired) {
    const holder = guard.holderPid !== undefined ? ` (pid ${guard.holderPid})` : "";
    throw new Error(`milo daemon is already running${holder}`);
  }
  const { config } = loadConfig();
  const db = openDatabase();
  const store = new JobStore(db);
  const recovered = store.recoverOnStartup();
  logger.info({ recovered, concurrency: config.concurrency }, "milo daemon starting");

  const linear = LinearClient.fromConfig();
  const processJob = makeProcessJob({
    config,
    store,
    linear,
    runners: { claude: runClaude, codex: runCodex },
    parseResult: parseRunnerResult,
  });
  // Dependency gates (MILO-4): a fire-and-forget reconcile each loop iteration promptly unblocks
  // dependents when a blocker finishes/merges; the poller's syncDependencies is the backstop.
  const reconcileTick = makeReconcileTicker({ config, store, linear });
  const queue = new JobQueue(store, processJob, {
    concurrency: config.concurrency,
    owner: "daemon",
    onTick: reconcileTick,
  });

  let stop = false;
  const shutdown = (sig: string) => {
    logger.info({ sig }, "milo daemon: draining in-flight jobs then exiting");
    stop = true;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // In-daemon scheduler (croner): in-repo `.milo/schedules.json` prompts + built-in maintenance.
  const scheduling = startScheduling({ config, store });
  // Poll-first triggers: Linear assignments + GitHub PRs → enqueue into the same durable queue; the
  // same loop re-discovers in-repo schedules (scheduling.reload) so edits land without a restart.
  const stopPolling = startPolling({ config, store, linear, onPollSchedules: scheduling.reload });
  // Webhook accelerator (opt-in): localhost HTTP ingress; polling above still backstops.
  const stopWebhook = config.webhook.enabled ? startWebhookServer({ config, store, linear }) : () => {};

  // Lease watchdog: requeue jobs whose processing died without reaching a terminal state. Healthy
  // in-flight jobs heartbeat throughout, so only genuinely-stranded leases expire and get reclaimed.
  const watchdog = setInterval(() => {
    try {
      const n = store.reclaimExpiredLeases();
      if (n > 0) logger.warn({ reclaimed: n }, "watchdog reclaimed stranded job(s)");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "watchdog tick failed");
    }
  }, 30_000);

  try {
    await queue.runForever(() => stop);
  } finally {
    clearInterval(watchdog);
    stopPolling();
    scheduling.stop();
    stopWebhook();
    guard.lock.release();
    db.close();
    logger.info("milo daemon stopped");
  }
}

// Auto-run when executed directly (the esbuild bundle / launchd target), not when imported.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  startDaemon().catch((err) => {
    logger.error({ err: (err as Error).message }, "milo daemon crashed");
    process.exit(1);
  });
}
