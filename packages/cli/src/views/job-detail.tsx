import React from "react";
import { Box, Text } from "ink";
import { stateColor } from "../components/index.js";
import type { JobDetail } from "../viewmodel.js";

/** Full detail for a single job: fields, dependencies, and recent state-change events. */
export function JobDetailView({ detail }: { detail: JobDetail }) {
  const { job, events, dependencies, hasTranscript } = detail;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text>
        <Text bold>{job.entityRef ?? job.entityId}</Text>
        <Text color={stateColor(job.state)}>{"  "}{job.state}</Text>
        {job.cancelRequested && job.state !== "cancelled" ? <Text color="gray">{"  ⊗ cancelling"}</Text> : null}
      </Text>
      <Text dimColor>
        {job.source}/{job.triggerType} · {job.repo}
        {job.branch ? ` · ${job.branch}` : ""}
      </Text>
      <Text dimColor>
        runner {job.runner ?? "-"}
        {job.model ? ` (${job.model})` : ""} · attempt {job.attempts}/{job.maxAttempts}
        {hasTranscript ? " · transcript ✓ (press t)" : ""}
      </Text>
      {job.prUrl ? <Text color="green">{job.prUrl}</Text> : null}
      {job.summary ? (
        <Box marginTop={1}>
          <Text>{job.summary}</Text>
        </Box>
      ) : null}
      {job.failureDetail ? (
        <Text color="red">
          {job.failureClass ? `${job.failureClass}: ` : ""}
          {job.failureDetail}
        </Text>
      ) : null}
      {dependencies.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>blockedBy:</Text>
          {dependencies.map((d) => (
            <Text key={d.blockerEntityId} dimColor>
              {"  "}
              {d.blockerEntityId} · {d.strategy} · {d.resolved ? "resolved" : "pending"}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>events:</Text>
        {events.slice(-12).map((e) => (
          <Text key={e.seq} dimColor>
            {"  "}
            {new Date(e.at).toLocaleTimeString()} {e.kind}
            {e.from || e.to ? `  ${e.from ?? "—"}→${e.to ?? "—"}` : ""}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
