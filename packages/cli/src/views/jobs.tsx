import React from "react";
import { Box, Text } from "ink";
import { ageStr, fit, stateColor } from "../components/index.js";
import type { JobRow } from "../viewmodel.js";

/**
 * The root jobs list. Presentational: the App owns selection (by job id, so the 1s poll never moves
 * the cursor), the filter string, and the state filter.
 */
export function JobsView({
  rows,
  selectedId,
  filtering,
  filterText,
  stateFilter,
  pageInfo,
}: {
  rows: JobRow[];
  selectedId: string | null;
  filtering: boolean;
  filterText: string;
  stateFilter?: string;
  pageInfo?: string;
}) {
  const showFilterBar = filtering || filterText.length > 0 || !!stateFilter;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {pageInfo ? <Text dimColor>{`${pageInfo}   `}</Text> : null}
        {showFilterBar ? (
          <>
            <Text dimColor>filter </Text>
            {stateFilter ? <Text color="yellow">{`state:${stateFilter} `}</Text> : null}
            <Text color={filtering ? "cyan" : undefined}>{`/${filterText}${filtering ? "▏" : ""}`}</Text>
          </>
        ) : null}
      </Box>
      {rows.length === 0 ? (
        <Text dimColor>no jobs match — try `milo SBX-1`, or press f/ to change the filter</Text>
      ) : (
        rows.map((r) => {
          const sel = r.id === selectedId;
          const cancelling = r.cancelRequested && r.state !== "cancelled";
          return (
            <Box key={r.id}>
              <Text color={sel ? "cyan" : undefined}>{sel ? "› " : "  "}</Text>
              <Text dimColor>{r.id.slice(-6)} </Text>
              <Text color={sel ? "cyan" : undefined}>{fit(r.ref, 20).padEnd(21)}</Text>
              <Text color={stateColor(r.state)}>{r.state.padEnd(16)}</Text>
              <Text dimColor>
                {(r.runner ?? "-").padEnd(7)}
                {ageStr(r.ageMs).padStart(4)}
                {"  "}
              </Text>
              {cancelling ? <Text color="gray">⊗ </Text> : null}
              <Text dimColor>{fit(r.detail ?? "", 56)}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
