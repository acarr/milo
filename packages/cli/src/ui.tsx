import React from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import { Scheduler, type PersistedEvent } from "@milo/core";
import { createClient, type MiloClient, type StateFilter, type SchedulesView as SchedulesData, type ScheduleViewRow } from "./viewmodel.js";
import { runDoctor, type CheckResult } from "./doctor.js";
import { Header, Footer } from "./components/index.js";
import { JobsView } from "./views/jobs.js";
import { JobDetailView } from "./views/job-detail.js";
import { TranscriptView } from "./views/transcript.js";
import { SchedulesView } from "./views/schedules.js";
import { SystemView } from "./views/system.js";
import type { JobRow, RepoHealthRow } from "./viewmodel.js";

/** A schedule row injected directly into the TUI (test convenience; live data comes from the client). */
export interface ScheduleRow {
  name: string;
  cron: string;
  kind: string;
  enabled: boolean;
}

/** The view stack: the root is `jobs`; drilling in pushes detail/transcript. */
type View =
  | { name: "jobs" }
  | { name: "job-detail"; jobId: string }
  | { name: "transcript"; jobId: string }
  | { name: "schedules" }
  | { name: "system" };

const STATE_CYCLE: (StateFilter | undefined)[] = [undefined, "active", "failed", "needs-attention", "cancelled", "done"];

const HINTS: Record<string, string> = {
  jobs: "↑/↓ select · ⏎ detail · t transcript · r rerun · R retry · x cancel · p poll · / search · f filter · 1/2/3 views · q quit",
  "jobs-filter": "type to filter · ⏎ apply · esc clear",
  "job-detail": "t transcript · r rerun · R retry · x cancel · esc back · q quit",
  transcript: "esc back · q quit",
  schedules: "↑/↓ select · ⏎/p run now · 1/2/3 views · q quit",
  system: "d run doctor · p poll · 1/2/3 views · q quit",
};

export function App({
  client: providedClient,
  store,
  schedules: schedulesProp,
}: {
  client?: MiloClient;
  store?: import("@milo/core").JobStore;
  schedules?: ScheduleRow[];
}) {
  const { exit } = useApp();
  const clientRef = useRef<MiloClient>(providedClient ?? createClient({ store }));
  const client = clientRef.current;

  const [stack, setStack] = useState<View[]>([{ name: "jobs" }]);
  const top = stack[stack.length - 1]!;
  const push = (v: View) => setStack((s) => [...s, v]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const [rows, setRows] = useState<JobRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [daemon, setDaemon] = useState<{ running: boolean; pid?: number }>({ running: false });
  const [health, setHealth] = useState<RepoHealthRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState<PersistedEvent[]>([]);
  const [sched, setSched] = useState<SchedulesData>({ rows: [], recent: [] });
  const [schedSel, setSchedSel] = useState(0);
  const [doctor, setDoctor] = useState<CheckResult[] | null>(null);

  const filterRef = useRef<{ search?: string; state?: StateFilter }>({});

  const refresh = () => {
    setRows(client.jobs({ limit: 300, ...filterRef.current }));
    const d = client.daemon();
    setDaemon({ running: d.running, pid: d.pid });
    setCounts(d.counts);
    setHealth(client.repoHealth().rows);
    setNow(Date.now());
  };

  // Single 1s poll feeds the jobs/system views. The transcript view ignores it (push-only below).
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live transcript: subscribe while the transcript view is on top; replay + tail into local state.
  const transcriptKey = top.name === "transcript" ? top.jobId : null;
  useEffect(() => {
    if (!transcriptKey) return;
    const acc: PersistedEvent[] = [];
    setTranscript([]);
    const unsub = client.tailTranscript(transcriptKey, (e) => {
      acc.push(e);
      setTranscript([...acc]);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptKey]);

  // Fetch schedules when the schedules view opens (unless injected via the prop, for tests).
  const onSchedules = top.name === "schedules";
  useEffect(() => {
    if (!onSchedules || (schedulesProp && schedulesProp.length)) return;
    let live = true;
    void client.schedules().then((sv) => {
      if (live) setSched(sv);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSchedules]);

  // --- derived ---
  const selId = rows.find((r) => r.id === selectedId)?.id ?? rows[0]?.id ?? null;
  const detail = top.name === "job-detail" || top.name === "transcript" ? client.job(top.jobId) : undefined;
  const schedView: SchedulesData =
    schedulesProp && schedulesProp.length
      ? {
          rows: schedulesProp.map<ScheduleViewRow>((s) => ({
            name: s.name,
            cron: s.cron,
            kind: s.kind,
            enabled: s.enabled,
            nextRun: s.enabled ? Scheduler.nextRun(s.cron) : null,
            lastRun: client.store.lastScheduleRun(s.name) ?? null,
          })),
          recent: [],
        }
      : sched;
  const schedIdx = Math.min(schedSel, Math.max(0, schedView.rows.length - 1));

  // --- actions ---
  const act = (kind: "rerun" | "retry" | "cancel", jobId: string | null) => {
    if (!jobId) return;
    const r = kind === "rerun" ? client.rerun(jobId) : kind === "retry" ? client.retry(jobId) : client.cancel(jobId);
    setMessage(r.ok ? `${kind}: ${typeof r.value === "string" ? r.value : `job ${r.value.id.slice(-6)}`}` : `${kind} failed: ${r.error}`);
    refresh();
  };
  const doPoll = () => {
    setMessage("polling Linear + GitHub…");
    void client.pollNow().then((r) => {
      setMessage(r.ok ? `polled: linear=${r.value.linear} github=${r.value.github}` : `poll failed: ${r.error}`);
      refresh();
    });
  };
  const runSchedule = () => {
    const def = schedView.rows[schedIdx];
    if (!def || def.kind !== "prompt") {
      setMessage("select a prompt schedule to run");
      return;
    }
    void client.runPrompt(def.name).then((r) => {
      setMessage(r.ok ? `queued ${r.value.disposition} (job ${r.value.jobId.slice(-6)})` : `run failed: ${r.error}`);
      refresh();
    });
  };
  const moveSel = (delta: number) => {
    // Functional update so rapid presses don't all read the same (stale) selection before re-render.
    setSelectedId((prev) => {
      if (rows.length === 0) return prev;
      const cur = Math.max(0, rows.findIndex((r) => r.id === (prev ?? rows[0]?.id)));
      return rows[Math.min(rows.length - 1, Math.max(0, cur + delta))]!.id;
    });
  };
  const cycleStateFilter = () => {
    const i = STATE_CYCLE.findIndex((s) => s === stateFilter);
    const next = STATE_CYCLE[(i + 1) % STATE_CYCLE.length];
    setStateFilter(next);
    filterRef.current.state = next;
    refresh();
  };

  // --- input (single handler, dispatched by view + mode) ---
  useInput((input, key) => {
    if (top.name === "jobs" && filtering) {
      if (key.escape) {
        setFiltering(false);
        setFilterText("");
        filterRef.current.search = undefined;
        refresh();
      } else if (key.return) {
        setFiltering(false);
      } else if (key.backspace || key.delete) {
        const t = filterText.slice(0, -1);
        setFilterText(t);
        filterRef.current.search = t || undefined;
        refresh();
      } else if (input && !key.ctrl && !key.meta) {
        const t = filterText + input;
        setFilterText(t);
        filterRef.current.search = t || undefined;
        refresh();
      }
      return;
    }

    if (input === "q") return exit();
    if (key.escape || key.backspace) {
      if (stack.length > 1) pop();
      return;
    }
    if (input === "1") return setStack([{ name: "jobs" }]);
    if (input === "2") return setStack([{ name: "schedules" }]);
    if (input === "3") return setStack([{ name: "system" }]);

    if (top.name === "jobs") {
      if (key.upArrow) return moveSel(-1);
      if (key.downArrow) return moveSel(1);
      if (key.return && selId) return push({ name: "job-detail", jobId: selId });
      if (input === "t" && selId) return push({ name: "transcript", jobId: selId });
      if (input === "r" && selId) return act("rerun", selId);
      if (input === "R" && selId) return act("retry", selId);
      if (input === "x" && selId) return act("cancel", selId);
      if (input === "p") return doPoll();
      if (input === "/") return setFiltering(true);
      if (input === "f") return cycleStateFilter();
      return;
    }
    if (top.name === "job-detail") {
      if (input === "t") return push({ name: "transcript", jobId: top.jobId });
      if (input === "r") return act("rerun", top.jobId);
      if (input === "R") return act("retry", top.jobId);
      if (input === "x") return act("cancel", top.jobId);
      return;
    }
    if (top.name === "schedules") {
      if (key.upArrow) return setSchedSel((s) => Math.max(0, s - 1));
      if (key.downArrow) return setSchedSel((s) => Math.min(schedView.rows.length - 1, s + 1));
      if (key.return || input === "p") return runSchedule();
      return;
    }
    if (top.name === "system") {
      if (input === "d") {
        // runDoctor is synchronous (it shells out) — defer a tick so the hint paints before it blocks.
        setMessage("running environment checks…");
        setTimeout(() => {
          setDoctor(runDoctor());
          setMessage("");
        }, 0);
        return;
      }
      if (input === "p") return doPoll();
      return;
    }
  });

  const hintKey = top.name === "jobs" && filtering ? "jobs-filter" : top.name;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header daemon={daemon.running} pid={daemon.pid} counts={counts} />
      {top.name === "jobs" && (
        <JobsView rows={rows} selectedId={selId} filtering={filtering} filterText={filterText} stateFilter={stateFilter} />
      )}
      {top.name === "job-detail" && detail && <JobDetailView detail={detail} />}
      {top.name === "transcript" && (
        <TranscriptView
          label={detail?.job.entityRef ?? detail?.job.entityId ?? top.jobId}
          state={detail?.job.state ?? "?"}
          events={transcript}
        />
      )}
      {top.name === "schedules" && (
        <SchedulesView rows={schedView.rows} selectedIndex={schedIdx} recent={schedView.recent} now={now} />
      )}
      {top.name === "system" && <SystemView daemon={client.daemon()} health={health} doctor={doctor} />}
      <Footer hints={HINTS[hintKey] ?? HINTS["jobs"]!} message={message || undefined} />
    </Box>
  );
}

/** Launch the interactive TUI (bare `milo` / `milo ui`). Falls back to a static dump when not a TTY. */
export async function runTui(): Promise<void> {
  const client = createClient();
  if (!process.stdin.isTTY) {
    for (const r of client.jobs({ limit: 50 })) {
      console.log(`${r.ref.padEnd(12)} ${r.state.padEnd(16)} ${r.prUrl ?? r.detail ?? ""}`);
    }
    client.close();
    return;
  }
  const app = render(<App client={client} />);
  await app.waitUntilExit();
  client.close();
}
