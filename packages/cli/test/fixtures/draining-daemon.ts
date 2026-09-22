// Test fixture: a daemon whose drain outlives the caller's wait window.
// Writes daemon.pid, prints READY, and on SIGTERM keeps running — exactly like the real daemon
// finishing a long in-flight job. Only SIGKILL stops it.
import { writeDaemon } from "@milo/core";

writeDaemon(process.pid);
process.stdout.write("READY\n");

process.on("SIGTERM", () => {
  process.stdout.write("DRAINING\n");
});

setInterval(() => {}, 1_000);
