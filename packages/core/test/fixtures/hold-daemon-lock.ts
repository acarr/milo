// Test fixture: acquire the daemon singleton lock and hold it until killed.
// Used by daemon-state.test.ts to prove cross-process exclusion and that the
// OS releases the lock when the holder dies (even on SIGKILL).
import { acquireDaemonLock } from "../../src/daemon-state.js";

const result = acquireDaemonLock();
if (!result.acquired) {
  process.stdout.write("NOT_ACQUIRED\n");
  process.exit(2);
}
process.stdout.write("LOCKED\n");
// Stay alive holding the lock until the parent kills us.
setInterval(() => {}, 1_000);
