#!/usr/bin/env node
// Dev entrypoint: runs the CLI from TypeScript source via tsx.
// (A bundled production binary is produced by `pnpm build` into dist/.)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const cliEntry = resolve(repo, "packages/cli/src/index.ts");
const tsx = resolve(repo, "node_modules/.bin/tsx");

const result = spawnSync(tsx, [cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
