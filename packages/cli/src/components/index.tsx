/**
 * Shared Ink presentation primitives — the single set of form controls + chrome that the TUI views,
 * the init wizard, and the add-repo / settings flows all render. Replaces the `field`/`toggleRow`/
 * `action` helpers that were copy-pasted (with drift) across InitWizard and AddRepo.
 *
 * These are PRESENTATIONAL only: input is owned centrally by each screen's single `useInput` (Ink
 * fires every registered handler per key, so scattering `useInput` across components causes
 * double-handling). Components take `focused`/`value` props and render; the parent drives state.
 */
import React from "react";
import { Box, Text } from "ink";
import { useState } from "react";

/** Milo's accent (used for titles/selection). */
export const ACCENT = "#ff8800";

const LABEL_W = 16;

export const STATE_COLOR: Record<string, string> = {
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
  cancelled: "gray",
};

export function stateColor(state: string): string {
  return STATE_COLOR[state] ?? "white";
}

/** "3s" / "5m" / "2h" / "4d" from a millisecond duration. */
export function ageStr(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Truncate to `n` chars with an ellipsis (single-line). */
export function fit(s: string, n: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, Math.max(0, n - 1)) + "…";
}

export function Title({ children }: { children: React.ReactNode }) {
  return (
    <Text bold color={ACCENT}>
      {children}
    </Text>
  );
}

const marker = (focused: boolean) => (focused ? "› " : "  ");

/** A labelled editable value (text field). */
export function Field({
  label,
  value,
  focused = false,
  hint,
  placeholder = "(empty)",
  labelWidth = LABEL_W,
}: {
  label: string;
  value: string;
  focused?: boolean;
  hint?: string;
  placeholder?: string;
  labelWidth?: number;
}) {
  return (
    <Text>
      <Text color={focused ? "cyan" : undefined}>{marker(focused)}</Text>
      <Text dimColor>{label.padEnd(labelWidth)}</Text>
      {value ? <Text>{value}</Text> : <Text dimColor>{placeholder}</Text>}
      {hint ? <Text dimColor>{"  "}{hint}</Text> : null}
    </Text>
  );
}

/** A labelled bracketed value — toggles (`[yes]`) and ←/→ enum selects (`[claude]`). */
export function Select({
  label,
  value,
  focused = false,
  hint,
  labelWidth = LABEL_W,
}: {
  label: string;
  value: string;
  focused?: boolean;
  hint?: string;
  labelWidth?: number;
}) {
  return (
    <Text>
      <Text color={focused ? "cyan" : undefined}>{marker(focused)}</Text>
      <Text dimColor>{label.padEnd(labelWidth)}</Text>
      <Text color={focused ? "cyan" : undefined}>[{value}]</Text>
      {hint ? <Text dimColor>{"  "}{hint}</Text> : null}
    </Text>
  );
}

/** Alias kept for readability at call sites that toggle a yes/no. */
export const Toggle = Select;

/** A checkbox row (space toggles selection upstream). */
export function CheckRow({ label, checked, focused = false }: { label: string; checked: boolean; focused?: boolean }) {
  return (
    <Text color={focused ? "cyan" : undefined}>
      {marker(focused)}
      [{checked ? "x" : " "}] {label}
    </Text>
  );
}

/** A button / action row (Next, Finish, Authenticate). */
export function Action({
  label,
  focused = false,
  hint,
  disabled = false,
}: {
  label: string;
  focused?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Text>
      <Text color={focused && !disabled ? "cyan" : undefined}>{marker(focused)}</Text>
      <Text bold={!disabled} dimColor={disabled} color={focused && !disabled ? "cyan" : undefined}>
        {label}
      </Text>
      {hint ? <Text dimColor>{"  "}{hint}</Text> : null}
    </Text>
  );
}

/** The top chrome: title + daemon status + per-state counts. */
export function Header({
  daemon,
  pid,
  counts,
  title = "milo",
}: {
  daemon: boolean;
  pid?: number;
  counts: Record<string, number>;
  title?: string;
}) {
  const summary = Object.entries(counts)
    .map(([s, c]) => `${s}:${c}`)
    .join("  ");
  return (
    <Box>
      <Text bold color={ACCENT}>
        {title}{" "}
      </Text>
      <Text color={daemon ? "green" : "yellow"}>{daemon ? `● daemon running (pid ${pid})` : "○ daemon stopped"}</Text>
      <Text dimColor>{"   "}{summary || "no jobs"}</Text>
    </Box>
  );
}

/** The top-level view tabs. The active one is highlighted; 1-5 / ⇥ / ←→ switch between them. */
export function Tabs({ active }: { active: string }) {
  const tabs: [string, string][] = [
    ["1", "jobs"],
    ["2", "schedules"],
    ["3", "system"],
    ["4", "repos"],
    ["5", "settings"],
  ];
  return (
    <Box marginTop={1}>
      {tabs.map(([n, name]) => {
        const on = name === active;
        return (
          <Text
            key={name}
            bold={on}
            color={on ? "black" : undefined}
            backgroundColor={on ? ACCENT : undefined}
            dimColor={!on}
          >
            {` ${n}·${name} `}
          </Text>
        );
      })}
    </Box>
  );
}

/** A context-sensitive keybinding hint line plus an optional transient status message. */
export function Footer({ hints, message }: { hints: string; message?: string }) {
  return (
    <Box marginTop={1} flexDirection="column">
      {message ? <Text color={ACCENT}>{message}</Text> : null}
      <Text dimColor>{hints}</Text>
    </Box>
  );
}

/**
 * Index-based list navigation for a stable list (schedules, repos). Returns the clamped index plus
 * up/down movers. For the jobs list, prefer tracking the selected *id* so the 1s poll never moves
 * the cursor.
 */
export function useListNav(length: number): { index: number; up: () => void; down: () => void; set: (i: number) => void } {
  const [index, setIndex] = useState(0);
  const clamped = Math.min(index, Math.max(0, length - 1));
  return {
    index: clamped,
    up: () => setIndex((i) => Math.max(0, i - 1)),
    down: () => setIndex((i) => Math.min(Math.max(0, length - 1), i + 1)),
    set: setIndex,
  };
}
