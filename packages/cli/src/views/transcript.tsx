import React from "react";
import { Box, Text } from "ink";
import { fit } from "../components/index.js";
import type { PersistedEvent } from "@milo/core";

const KIND_COLOR: Record<string, string> = {
  "file-change": "green",
  tool: "cyan",
  notice: "yellow",
  narration: "white",
};
const KIND_TAG: Record<string, string> = { "file-change": "±", tool: "›", notice: "!", narration: "·" };

/**
 * Live transcript of a job's agent run. The App subscribes to `client.tailTranscript` and feeds the
 * accumulated events here; we render only the tail that fits the terminal so a long run scrolls.
 */
export function TranscriptView({
  label,
  state,
  events,
  rows = 24,
}: {
  label: string;
  state: string;
  events: PersistedEvent[];
  rows?: number;
}) {
  const visible = events.slice(-Math.max(1, rows));
  const live = !["done", "discovery-done", "failed", "needs-attention", "cancelled", "abandoned"].includes(state);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold>transcript</Text>
        <Text dimColor>{"  "}{label} · {state}{live ? " · live" : ""}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {events.length === 0 ? (
          <Text dimColor>{live ? "waiting for the agent to start…" : "no transcript recorded for this job"}</Text>
        ) : (
          visible.map((e, i) => (
            <Text key={i} color={KIND_COLOR[e.kind] ?? "white"} dimColor={e.kind === "narration"}>
              {KIND_TAG[e.kind] ?? "·"} {e.tool ? `${e.tool}: ` : ""}
              {fit(e.text, 100)}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
