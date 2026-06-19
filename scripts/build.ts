/**
 * Bundles the daemon (and CLI) to single ESM files in dist/, so launchd can exec
 * a stable file under a cleaned environment without node_modules resolution.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node" as const,
  format: "esm" as const,
  target: "node22",
  // Native modules + things that must resolve at runtime stay external.
  external: ["better-sqlite3", "node:sqlite", "fsevents"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info" as const,
};

await build({
  ...common,
  entryPoints: [resolve(repo, "packages/daemon/src/index.ts")],
  outfile: resolve(repo, "dist/daemon.mjs"),
});

await build({
  ...common,
  entryPoints: [resolve(repo, "packages/cli/src/index.ts")],
  outfile: resolve(repo, "dist/milo.mjs"),
});

console.log("build complete -> dist/");
