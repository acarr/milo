import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MiloConfigSchema,
  resolveRunner,
  modelFor,
  resolveRepoByGithub,
  isRemoteRunner,
  conductorAgentFor,
} from "@milo/core";

const config = MiloConfigSchema.parse({
  repositories: [
    { name: "sandbox", path: "/nope/sandbox", teamKeys: ["SBX"], githubRepo: "acme/milo-sandbox" },
    { name: "codey", path: "/nope/codey", teamKeys: ["COD"], defaultRunner: "codex" },
    {
      name: "cloudy",
      path: "/nope/cloudy",
      teamKeys: ["CLD"],
      defaultRunner: "conductor",
      conductor: { projectId: "proj-1", agent: "codex", model: "gpt-5.5" },
    },
  ],
});

const sandbox = config.repositories[0]!;
const codey = config.repositories[1]!;
const cloudy = config.repositories[2]!;

test("resolveRunner: [agent=...] tag wins over everything", () => {
  assert.equal(resolveRunner(config, codey, { text: "fix it [agent=claude]", labels: ["runner:codex"] }), "claude");
  assert.equal(resolveRunner(config, sandbox, { text: "do X [agent=codex]" }), "codex");
});

test("resolveRunner: runner:<id> label beats repo/global default", () => {
  assert.equal(resolveRunner(config, sandbox, { labels: ["bug", "runner:codex"] }), "codex");
});

test("resolveRunner: repo.defaultRunner, then global default", () => {
  assert.equal(resolveRunner(config, codey, {}), "codex"); // repo default
  assert.equal(resolveRunner(config, sandbox, {}), "claude"); // falls through to global default
});

test("modelFor returns the head of each runner's model chain", () => {
  assert.equal(modelFor(config, "claude"), "opus");
  assert.equal(modelFor(config, "codex"), "gpt-5.5");
  assert.equal(modelFor(config, "conductor"), "opus-5-1m");
});

test("resolveRunner selects conductor by tag, label, and repo default", () => {
  assert.equal(resolveRunner(config, sandbox, { text: "ship it [agent=conductor]" }), "conductor");
  assert.equal(resolveRunner(config, sandbox, { labels: ["bug", "runner:conductor"] }), "conductor");
  assert.equal(resolveRunner(config, cloudy, {}), "conductor");
  // A local tag still beats a conductor repo default — precedence is unchanged.
  assert.equal(resolveRunner(config, cloudy, { text: "[agent=claude]" }), "claude");
});

test("isRemoteRunner marks only conductor as off-machine", () => {
  assert.equal(isRemoteRunner("conductor"), true);
  assert.equal(isRemoteRunner("claude"), false);
  assert.equal(isRemoteRunner("codex"), false);
});

test("conductor agent/model come from the repo, falling back to the global default", () => {
  assert.equal(conductorAgentFor(config, cloudy), "codex"); // repo override
  assert.equal(conductorAgentFor(config, sandbox), "claude"); // global default
  assert.equal(modelFor(config, "conductor", cloudy), "gpt-5.5"); // repo model wins the chain head
  assert.equal(modelFor(config, "conductor", sandbox), "opus-5-1m");
});

test("resolveRepoByGithub matches the explicit githubRepo slug, then bare name", () => {
  assert.equal(resolveRepoByGithub(config, "acme/milo-sandbox")?.name, "sandbox");
  assert.equal(resolveRepoByGithub(config, "whoever/codey")?.name, "codey"); // bare-name fallback
  assert.equal(resolveRepoByGithub(config, "x/unknown"), undefined);
});
