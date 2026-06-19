import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "ink-testing-library";
import { AddRepo, type AddRepoResult } from "../src/repo-setup/AddRepo.js";
import type { InferredRepoDefaults } from "../src/repo-setup/infer.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r";
const DOWN = "[B";

// Advance a step: arrow down to its trailing action row (Next/Finish), then Enter.
const advance = async (stdin: { write: (s: string) => void }, downs: number) => {
  for (let i = 0; i < downs; i++) {
    stdin.write(DOWN);
    await delay(10);
  }
  stdin.write(ENTER);
  await delay(20);
};

const inferred: InferredRepoDefaults = {
  path: "/repos/milo-sandbox",
  name: "milo-sandbox",
  githubRepo: "acme/milo-sandbox",
  baseBranch: "main",
  packageManager: "pnpm",
};
const teams = [
  { id: "1", key: "SBX", name: "Milo Sandbox" },
  { id: "2", key: "WAZ", name: "Wazzon" },
];

test("AddRepo renders inferred values and the team list, preselecting fuzzy matches", async () => {
  const { lastFrame, unmount } = render(
    <AddRepo inferred={inferred} teams={teams} preselected={["SBX"]} onDone={() => {}} />,
  );
  await delay(40);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /milo add-repo/, "shows the header");
  assert.match(frame, /milo-sandbox/, "shows the inferred name");
  assert.match(frame, /acme\/milo-sandbox/, "shows the inferred github slug");
  assert.match(frame, /pnpm/, "shows the inferred package manager");
  assert.match(frame, /Next/, "shows the Next action row");
});

test("AddRepo: Enter through the steps produces a config with the preselected team", async () => {
  let result: AddRepoResult | null | undefined;
  const { stdin, unmount } = render(
    <AddRepo
      inferred={inferred}
      teams={teams}
      preselected={["SBX"]}
      onDone={(r) => {
        result = r;
      }}
    />,
  );
  await delay(40);
  await advance(stdin, 4); // confirm → teams (down past 4 fields to Next)
  await advance(stdin, 2); // teams → optional (down past 2 teams to Next; SBX stays selected)
  await advance(stdin, 3); // optional → finish (down past 3 fields to Finish)
  await delay(40);
  unmount();

  assert.ok(result, "onDone received a result");
  assert.equal(result!.name, "milo-sandbox");
  assert.equal(result!.path, "/repos/milo-sandbox");
  assert.equal(result!.baseBranch, "main");
  assert.equal(result!.packageManager, "pnpm");
  assert.equal(result!.githubRepo, "acme/milo-sandbox");
  assert.deepEqual(result!.teamKeys, ["SBX"]);
  assert.equal(result!.defaultRunner, undefined, "optional overrides skipped by default");
});

test("AddRepo: space toggles a team selection", async () => {
  let result: AddRepoResult | null | undefined;
  const { stdin, unmount } = render(
    <AddRepo
      inferred={inferred}
      teams={teams}
      preselected={["SBX"]}
      onDone={(r) => {
        result = r;
      }}
    />,
  );
  await delay(40);
  await advance(stdin, 4); // confirm → teams (cursor on SBX)
  stdin.write(DOWN); // cursor → WAZ
  await delay(20);
  stdin.write(" "); // select WAZ
  await delay(20);
  await advance(stdin, 1); // teams → optional (down to Next, then Enter)
  await advance(stdin, 3); // optional → finish
  await delay(40);
  unmount();

  assert.ok(result);
  assert.deepEqual(result!.teamKeys.sort(), ["SBX", "WAZ"], "both teams selected");
});

test("AddRepo: Enter on a field steps to the next row, it does not advance the step", async () => {
  const { stdin, lastFrame, unmount } = render(
    <AddRepo inferred={inferred} teams={teams} preselected={["SBX"]} onDone={() => {}} />,
  );
  await delay(40);
  stdin.write(ENTER); // from the first field — should move focus down, not jump to teams
  await delay(20);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /Confirm the repo details/, "still on the confirm step");
  assert.doesNotMatch(frame, /Map to Linear team/, "did not advance to the teams step");
});

test("AddRepo: pre-fills from an existing repo config and shows the configured banner", async () => {
  let result: AddRepoResult | null | undefined;
  const existing = {
    name: "milo-sandbox",
    path: "/repos/milo-sandbox",
    baseBranch: "develop",
    teamKeys: ["WAZ"],
    packageManager: "yarn" as const,
    defaultRunner: "codex" as const,
    setupScript: "pnpm i",
    teardownPolicy: "always" as const,
  };
  const { stdin, lastFrame, unmount } = render(
    <AddRepo
      inferred={inferred}
      teams={teams}
      preselected={["SBX"]}
      existing={existing}
      onDone={(r) => {
        result = r;
      }}
    />,
  );
  await delay(40);
  const frame = lastFrame() ?? "";
  assert.match(frame, /Already configured/, "shows the already-configured banner");
  assert.match(frame, /develop/, "pre-fills the existing baseBranch, not the inferred main");

  await advance(stdin, 4); // confirm → teams (existing values untouched)
  await advance(stdin, 2); // teams → optional (WAZ stays selected from existing)
  await advance(stdin, 3); // optional → finish
  await delay(40);
  unmount();

  assert.ok(result, "onDone received a result");
  assert.equal(result!.baseBranch, "develop", "kept the existing baseBranch");
  assert.equal(result!.packageManager, "yarn", "kept the existing package manager");
  assert.deepEqual(result!.teamKeys, ["WAZ"], "kept the existing team selection");
  assert.equal(result!.defaultRunner, "codex", "kept the existing runner");
  assert.equal(result!.setupScript, "pnpm i", "kept the existing setup script");
});
