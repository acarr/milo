import React from "react";
import { Box, Text } from "ink";
import { Select } from "../components/index.js";
import type { SettingsView } from "../viewmodel.js";

/** The editable settings rows, in order — the App's ←/→ handler maps the focused index to a patch. */
export const SETTINGS_ROWS = ["default runner", "webhook", "auto-merge PRs", "concurrency"] as const;

/** Editable settings: runner/webhook/auto-merge/concurrency, plus read-only connection status. */
export function SettingsPanel({ settings, selectedIndex }: { settings: SettingsView; selectedIndex: number }) {
  const values: Record<string, string> = {
    "default runner": settings.defaultRunner,
    webhook: settings.webhookEnabled ? "on" : "off",
    "auto-merge PRs": settings.autoMerge ? "on" : "off",
    concurrency: String(settings.concurrency),
  };
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Settings</Text>
      {SETTINGS_ROWS.map((label, i) => (
        <Select
          key={label}
          label={label}
          value={values[label]!}
          focused={i === selectedIndex}
          hint={i === selectedIndex ? "←/→ change" : undefined}
        />
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Linear   {settings.linearConnected ? "connected" : "not connected — run `milo linear-auth`"}
        </Text>
        <Text dimColor>PATH     {settings.miloOnPath ? "milo on PATH" : "not on PATH — run `milo init`"}</Text>
        <Text dimColor>home     {settings.miloHome}</Text>
        <Text dimColor>worktrees {settings.worktreeBase ?? `${settings.miloHome}/worktrees`}</Text>
      </Box>
    </Box>
  );
}
