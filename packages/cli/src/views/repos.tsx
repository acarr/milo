import React from "react";
import { Box, Text } from "ink";
import { fit } from "../components/index.js";
import type { RepoSummary } from "../viewmodel.js";

/** Configured repositories: list + remove (add/edit route to `milo add-repo`). */
export function ReposView({
  repos,
  selectedIndex,
  confirming,
}: {
  repos: RepoSummary[];
  selectedIndex: number;
  confirming: boolean;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Repositories</Text>
      {repos.length === 0 ? (
        <Text dimColor>none configured — run `milo add-repo &lt;path&gt;`</Text>
      ) : (
        repos.map((r, i) => {
          const sel = i === selectedIndex;
          return (
            <Box key={r.name} flexDirection="column">
              <Text color={sel ? "cyan" : undefined}>
                {sel ? "› " : "  "}
                {r.name.padEnd(18)}
                <Text dimColor> {fit(r.path, 48)}</Text>
              </Text>
              {sel && (
                <Text dimColor>
                  {"     "}
                  base {r.baseBranch} · runner {r.runner ?? "default"} · {r.githubRepo ?? "no github"} · teams{" "}
                  {r.teamKeys.join(",") || "—"}
                </Text>
              )}
            </Box>
          );
        })
      )}
      {confirming && repos[selectedIndex] ? (
        <Box marginTop={1}>
          <Text color="red">remove {repos[selectedIndex]!.name}?  y / n</Text>
        </Box>
      ) : null}
    </Box>
  );
}
