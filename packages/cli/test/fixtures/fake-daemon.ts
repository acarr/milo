// Test fixture: behaves like the real daemon for stop/restart tests.
// Writes daemon.pid, prints READY, then waits; on SIGTERM it "drains" briefly,
// clears its pid record, and exits 0 — mirroring startDaemon's graceful shutdown.
import { writeDaemon, clearDaemon } from "@milo/core";

writeDaemon(process.pid);
process.stdout.write("READY\n");

process.on("SIGTERM", () => {
  setTimeout(() => {
    clearDaemon(process.pid);
    process.exit(0);
  }, 100); // simulate a short drain
});

setInterval(() => {}, 1_000);
