import React from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { useState, useEffect } from "react";
import { openDatabase, JobStore, Scheduler, isDaemonRunning, readDaemon, loadConfig, type Job } from "@milo/core";

/** A schedule row for the TUI's Scheduled panel (name/cron/kind + enabled). */
export interface ScheduleRow {
  name: string;
  cron: string;
  kind: string;
  enabled: boolean;
}

const STATE_COLOR: Record<string, string> = {
  done: "green",
  "discovery-done": "green",
  running: "cyan",
  verifying: "cyan",
  "setting-up": "cyan",
  reporting: "cyan",
  remediating: "magenta",
  queued: "yellow",
  claimed: "yellow",
  retrying: "yellow",
  failed: "red",
  "needs-attention": "red",
  abandoned: "red",
};

function age(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function App({ store, schedules = [] }: { store: JobStore; schedules?: ScheduleRow[] }) {
  const { exit } = useApp();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [daemon, setDaemon] = useState(false);
  const [pid, setPid] = useState<number | undefined>(undefined);
  const [sel, setSel] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [events, setEvents] = useState<{ seq: number; kind: string; from: string | null; to: string | null }[]>([]);
  const [schedRuns, setSchedRuns] = useState<Record<string, number | undefined>>({});

  useEffect(() => {
    const tick = () => {
      setJobs(store.list({ limit: 50 }));
      setCounts(store.countByState());
      setDaemon(isDaemonRunning());
      setPid(readDaemon()?.pid);
      setNow(Date.now());
      if (schedules.length) {
        setSchedRuns(Object.fromEntries(schedules.map((s) => [s.name, store.lastScheduleRun(s.name)])));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const job = jobs[Math.min(sel, jobs.length - 1)];
    if (job) setEvents(store.events(job.id, 8));
  }, [sel, jobs]);

  useInput((input, key) => {
    if (input === "q") exit();
    else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(Math.max(0, jobs.length - 1), s + 1));
  });

  const selected = jobs[Math.min(sel, Math.max(0, jobs.length - 1))];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>milo </Text>
        <Text color={daemon ? "green" : "yellow"}>{daemon ? `● daemon running (pid ${pid})` : "○ daemon stopped"}</Text>
        <Text dimColor>{"   "}{Object.entries(counts).map(([s, c]) => `${s}:${c}`).join("  ") || "no jobs"}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {jobs.length === 0 && <Text dimColor>no jobs yet — try `milo SBX-1`</Text>}
        {jobs.map((j, i) => (
          <Box key={j.id}>
            <Text color={i === sel ? "cyan" : undefined}>{i === sel ? "› " : "  "}</Text>
            <Text>{(j.entityRef ?? j.entityId).padEnd(8)} </Text>
            <Text color={STATE_COLOR[j.state] ?? "white"}>{j.state.padEnd(15)}</Text>
            <Text dimColor>{(j.runner ?? "-").padEnd(7)}{age(j.createdAt, now).padStart(4)}  </Text>
            <Text dimColor>{j.prUrl ?? j.failureDetail ?? ""}</Text>
          </Box>
        ))}
      </Box>

      {selected && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text>
            <Text bold>{selected.entityRef ?? selected.entityId}</Text>
            <Text color={STATE_COLOR[selected.state] ?? "white"}> {selected.state}</Text>
          </Text>
          {selected.summary ? <Text dimColor>{selected.summary}</Text> : null}
          {events.map((e) => (
            <Text key={e.seq} dimColor>
              {e.kind}
              {e.from || e.to ? ` ${e.from ?? ""}→${e.to ?? ""}` : ""}
            </Text>
          ))}
        </Box>
      )}

      {schedules.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>Scheduled</Text>
          {schedules.map((s) => {
            const next = s.enabled ? Scheduler.nextRun(s.cron) : null;
            const last = schedRuns[s.name];
            return (
              <Box key={s.name}>
                <Text>{"  "}{(s.enabled ? s.name : `${s.name} (off)`).padEnd(16)}</Text>
                <Text dimColor>{s.kind.padEnd(12)}{s.cron.padEnd(14)}</Text>
                <Text dimColor>next {next ? `in ${age(now, next)}` : "—"}   last {last ? `${age(last, now)} ago` : "—"}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑/↓ select · q quit · live (1s)</Text>
      </Box>
    </Box>
  );
}

/** Launch the interactive TUI (bare `milo` / `milo ui`). Falls back to a static dump when not a TTY. */
export async function runTui(): Promise<void> {
  const db = openDatabase();
  const store = new JobStore(db);
  if (!process.stdin.isTTY) {
    for (const j of store.list({ limit: 50 })) {
      console.log(`${(j.entityRef ?? j.entityId).padEnd(10)} ${j.state.padEnd(16)} ${j.prUrl ?? ""}`);
    }
    db.close();
    return;
  }
  let schedules: ScheduleRow[] = [];
  try {
    const { config } = loadConfig();
    const { effectiveSchedules } = await import("@milo/daemon");
    schedules = effectiveSchedules(config).map((s) => ({
      name: s.name,
      cron: s.cron,
      kind: (s.intent?.["kind"] as string) ?? "enqueue",
      enabled: s.enabled,
    }));
  } catch {
    /* no/invalid config — show jobs only */
  }
  const app = render(<App store={store} schedules={schedules} />);
  await app.waitUntilExit();
  db.close();
}
