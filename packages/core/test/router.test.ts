import { test } from "node:test";
import assert from "node:assert/strict";
import { MiloConfigSchema, resolveRunner, modelFor, resolveRepoByGithub } from "@milo/core";

const config = MiloConfigSchema.parse({
  repositories: [
    { name: "sandbox", path: "/nope/sandbox", teamKeys: ["SBX"], githubRepo: "acme/milo-sandbox" },
    { name: "codey", path: "/nope/codey", teamKeys: ["COD"], defaultRunner: "codex" },
  ],
});

const sandbox = config.repositories[0]!;
const codey = config.repositories[1]!;

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
});

test("resolveRepoByGithub matches the explicit githubRepo slug, then bare name", () => {
  assert.equal(resolveRepoByGithub(config, "acme/milo-sandbox")?.name, "sandbox");
  assert.equal(resolveRepoByGithub(config, "whoever/codey")?.name, "codey"); // bare-name fallback
  assert.equal(resolveRepoByGithub(config, "x/unknown"), undefined);
});
