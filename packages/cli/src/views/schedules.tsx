import React from "react";
import { Box, Text } from "ink";
import { ageStr } from "../components/index.js";
import type { ScheduleViewRow } from "../viewmodel.js";

/** Scheduled automations: maintenance + config + per-repo prompt schedules, with next/last runs. */
export function SchedulesView({
  rows,
  selectedIndex,
  recent,
  now,
}: {
  rows: ScheduleViewRow[];
  selectedIndex: number;
  recent: { name: string; detail: string | null; at: number }[];
  now: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Scheduled</Text>
      {rows.length === 0 ? (
        <Text dimColor>no schedules — add one in a repo's .milo/schedules.json</Text>
      ) : (
        rows.map((r, i) => {
          const sel = i === selectedIndex;
          const name = r.enabled ? r.name : `${r.name} (off)`;
          return (
            <Box key={r.name}>
              <Text color={sel ? "cyan" : undefined}>{sel ? "› " : "  "}</Text>
              <Text color={sel ? "cyan" : undefined}>{name.padEnd(28)}</Text>
              <Text dimColor>{r.kind.padEnd(12)}{r.cron.padEnd(16)}</Text>
              <Text dimColor>
                next {r.nextRun ? `in ${ageStr(r.nextRun - now)}` : "—"}   last {r.lastRun ? `${ageStr(now - r.lastRun)} ago` : "—"}
              </Text>
            </Box>
          );
        })
      )}
      {recent.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>recent runs:</Text>
          {recent.slice(0, 6).map((run, i) => (
            <Text key={i} dimColor>
              {"  "}
              {ageStr(now - run.at)} ago · {run.name} · {run.detail ?? ""}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
