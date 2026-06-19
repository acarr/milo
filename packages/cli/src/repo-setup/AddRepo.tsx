import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { LinearTeam, RepoConfig } from "@milo/core";
import type { InferredRepoDefaults } from "./infer.js";

/**
 * The interactive repo-setup flow, built on the existing Ink TUI. Three steps:
 *   1. confirm inferred values (each overridable; correct-by-default on a standard repo)
 *   2. map to Linear team(s) via multi-select (fuzzy-matches pre-selected)
 *   3. optional per-repo overrides (skipped by pressing Enter)
 *
 * Pure presentation: inference + the teams fetch happen before render and are passed in; the
 * assembled plain object is handed to `onDone` (null when cancelled) for the caller to validate
 * and write. This keeps the component testable headlessly with ink-testing-library.
 */

export type AddRepoResult = {
  name: string;
  path: string;
  baseBranch: string;
  teamKeys: string[];
  packageManager: "npm" | "pnpm" | "yarn";
  githubRepo?: string;
  defaultRunner?: "claude" | "codex";
  setupScript?: string;
  teardownScript?: string;
};

const PMS = ["npm", "pnpm", "yarn"] as const;
const RUNNERS = ["none", "claude", "codex"] as const;

type Step = "confirm" | "teams" | "optional";

export function AddRepo({
  inferred,
  teams,
  preselected = [],
  existing,
  onDone,
}: {
  inferred: InferredRepoDefaults;
  teams: LinearTeam[];
  preselected?: string[];
  /** The repo's current config when it's already in config.json — pre-fills the form to edit it. */
  existing?: RepoConfig;
  onDone: (result: AddRepoResult | null) => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("confirm");

  // Step 1 — values to confirm; pre-filled from existing config when re-adding, else inferred.
  const [name, setName] = useState(existing?.name ?? inferred.name);
  const [githubRepo, setGithubRepo] = useState(existing?.githubRepo ?? inferred.githubRepo ?? "");
  const [baseBranch, setBaseBranch] = useState(existing?.baseBranch ?? inferred.baseBranch);
  const [pmIdx, setPmIdx] = useState(
    Math.max(0, PMS.indexOf(existing?.packageManager ?? inferred.packageManager)),
  );
  const [confirmFocus, setConfirmFocus] = useState(0); // 0..4 (last is the "Next" action row)

  // Step 2 — team multi-select (existing selection wins over fuzzy preselection).
  const [selected, setSelected] = useState<Set<string>>(new Set(existing?.teamKeys ?? preselected));
  const [teamCursor, setTeamCursor] = useState(0);

  // Step 3 — optional overrides, pre-filled from existing config when present.
  const [runnerIdx, setRunnerIdx] = useState(Math.max(0, RUNNERS.indexOf(existing?.defaultRunner ?? "none")));
  const [setupScript, setSetupScript] = useState(existing?.setupScript ?? "");
  const [teardownScript, setTeardownScript] = useState(existing?.teardownScript ?? "");
  const [optFocus, setOptFocus] = useState(0); // 0=runner 1=setup 2=teardown 3=Finish

  const finish = () => {
    const result: AddRepoResult = {
      name: name.trim() || inferred.name,
      path: inferred.path,
      baseBranch: baseBranch.trim() || "main",
      teamKeys: [...selected],
      packageManager: PMS[pmIdx]!,
    };
    if (githubRepo.trim()) result.githubRepo = githubRepo.trim();
    if (RUNNERS[runnerIdx] !== "none") result.defaultRunner = RUNNERS[runnerIdx] as "claude" | "codex";
    if (setupScript.trim()) result.setupScript = setupScript.trim();
    if (teardownScript.trim()) result.teardownScript = teardownScript.trim();
    onDone(result);
    exit();
  };

  const editText = (
    value: string,
    set: (v: string) => void,
    input: string,
    key: { backspace?: boolean; delete?: boolean },
  ) => {
    if (key.backspace || key.delete) set(value.slice(0, -1));
    else if (input && !key.backspace && !key.delete) set(value + input);
  };

  useInput((input, key) => {
    if (key.escape) {
      onDone(null);
      exit();
      return;
    }

    if (step === "confirm") {
      if (key.upArrow) return setConfirmFocus((f) => Math.max(0, f - 1));
      if (key.downArrow) return setConfirmFocus((f) => Math.min(4, f + 1));
      if (key.return) {
        if (confirmFocus === 4) return setStep("teams"); // the "Next" action row advances
        return setConfirmFocus((f) => Math.min(4, f + 1)); // otherwise Enter steps to the next row
      }
      if (confirmFocus === 0) editText(name, setName, input, key);
      else if (confirmFocus === 1) editText(githubRepo, setGithubRepo, input, key);
      else if (confirmFocus === 2) editText(baseBranch, setBaseBranch, input, key);
      else if (confirmFocus === 3) {
        if (key.leftArrow) setPmIdx((i) => (i + PMS.length - 1) % PMS.length);
        else if (key.rightArrow) setPmIdx((i) => (i + 1) % PMS.length);
      }
      return;
    }

    if (step === "teams") {
      if (key.upArrow) return setTeamCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setTeamCursor((c) => Math.min(teams.length, c + 1));
      if (key.return) {
        if (teamCursor === teams.length) return setStep("optional"); // the "Next" action row advances
        return setTeamCursor((c) => Math.min(teams.length, c + 1)); // otherwise Enter steps down a row
      }
      if (input === " ") {
        const t = teams[teamCursor];
        if (t) {
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(t.key)) next.delete(t.key);
            else next.add(t.key);
            return next;
          });
        }
      }
      return;
    }

    // step === "optional"
    if (key.upArrow) return setOptFocus((f) => Math.max(0, f - 1));
    if (key.downArrow) return setOptFocus((f) => Math.min(3, f + 1));
    if (key.return) {
      if (optFocus === 3) return finish(); // the "Finish" action row
      return setOptFocus((f) => Math.min(3, f + 1)); // otherwise Enter steps to the next row
    }
    if (optFocus === 0) {
      if (key.leftArrow) setRunnerIdx((i) => (i + RUNNERS.length - 1) % RUNNERS.length);
      else if (key.rightArrow) setRunnerIdx((i) => (i + 1) % RUNNERS.length);
    } else if (optFocus === 1) editText(setupScript, setSetupScript, input, key);
    else if (optFocus === 2) editText(teardownScript, setTeardownScript, input, key);
  });

  const field = (label: string, value: string, focused: boolean, hint?: string) => (
    <Box>
      <Text color={focused ? "cyan" : undefined}>{focused ? "› " : "  "}</Text>
      <Text dimColor>{label.padEnd(15)}</Text>
      <Text color={focused ? "cyan" : undefined}>{value || <Text dimColor>(empty)</Text>}</Text>
      {focused && hint ? <Text dimColor>{`   ${hint}`}</Text> : null}
    </Box>
  );

  const action = (label: string, focused: boolean, hint: string) => (
    <Box marginTop={1}>
      <Text color={focused ? "cyan" : undefined}>{focused ? "› " : "  "}</Text>
      <Text bold color={focused ? "cyan" : undefined}>{label}</Text>
      {focused ? <Text dimColor>{`   ${hint}`}</Text> : null}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>milo add-repo</Text>
      <Text dimColor>{inferred.path}</Text>
      {existing && (
        <Text color="yellow">Already configured as '{existing.name}' — editing its settings.</Text>
      )}

      {step === "confirm" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Confirm the repo details (↑/↓ move · type to edit · Enter for next field):</Text>
          <Box marginTop={1} flexDirection="column">
            {field("name", name, confirmFocus === 0)}
            {field("githubRepo", githubRepo, confirmFocus === 1)}
            {field("baseBranch", baseBranch, confirmFocus === 2)}
            {field("packageManager", PMS[pmIdx]!, confirmFocus === 3, "←/→ to change")}
          </Box>
          {action("Next", confirmFocus === 4, "Enter to continue")}
        </Box>
      )}

      {step === "teams" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Map to Linear team(s) (↑/↓ move · space toggles · Enter for next):</Text>
          <Box marginTop={1} flexDirection="column">
            {teams.length === 0 && <Text dimColor>No Linear teams visible.</Text>}
            {teams.map((t, i) => (
              <Box key={t.id}>
                <Text color={i === teamCursor ? "cyan" : undefined}>{i === teamCursor ? "› " : "  "}</Text>
                <Text>{selected.has(t.key) ? "[x] " : "[ ] "}</Text>
                <Text>{t.key.padEnd(8)}</Text>
                <Text dimColor>{t.name}</Text>
              </Box>
            ))}
          </Box>
          {action("Next", teamCursor === teams.length, "Enter to continue")}
        </Box>
      )}

      {step === "optional" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Optional overrides:</Text>
          <Box marginTop={1} flexDirection="column">
            {field("defaultRunner", RUNNERS[runnerIdx]!, optFocus === 0, "←/→ to change")}
            {field("setupScript", setupScript, optFocus === 1)}
            {field("teardownScript", teardownScript, optFocus === 2)}
          </Box>
          {action("Finish", optFocus === 3, "Enter to finish")}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
}
