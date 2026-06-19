import React from "react";
import { Box, Text } from "ink";
import type { CheckResult } from "../doctor.js";
import type { DaemonStatus, RepoHealthRow } from "../viewmodel.js";

const STATUS_COLOR: Record<string, string> = { ok: "green", warn: "yellow", fail: "red" };
const STATUS_MARK: Record<string, string> = { ok: "✓", warn: "!", fail: "✗" };
const BREAKER_COLOR: Record<string, string> = { closed: "green", "half-open": "yellow", open: "red" };

/** System view: daemon status, per-repo circuit-breaker health, and the in-TUI doctor checks. */
export function SystemView({
  daemon,
  health,
  doctor,
}: {
  daemon: DaemonStatus;
  health: RepoHealthRow[];
  doctor: CheckResult[] | null;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>System</Text>
      <Text>
        <Text dimColor>daemon  </Text>
        <Text color={daemon.running ? "green" : "yellow"}>
          {daemon.running ? `running (pid ${daemon.pid})` : "stopped — run `milo daemon`"}
        </Text>
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>repo health (circuit breakers):</Text>
        {health.length === 0 ? (
          <Text dimColor>{"  "}no repos configured</Text>
        ) : (
          health.map((h) => (
            <Text key={h.repo}>
              {"  "}
              <Text>{h.repo.padEnd(20)}</Text>
              <Text color={BREAKER_COLOR[h.breakerState] ?? "white"}>{h.breakerState.padEnd(10)}</Text>
              <Text dimColor>{h.consecutiveInfraFailures > 0 ? `${h.consecutiveInfraFailures} infra-failure(s)` : "healthy"}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>doctor:</Text>
        {doctor === null ? (
          <Text dimColor>{"  "}press d to run environment checks</Text>
        ) : (
          doctor.map((c) => (
            <Text key={c.name}>
              {"  "}
              <Text color={STATUS_COLOR[c.status] ?? "white"}>{STATUS_MARK[c.status] ?? "?"} </Text>
              <Text>{c.name.padEnd(14)}</Text>
              <Text dimColor>{c.detail}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
