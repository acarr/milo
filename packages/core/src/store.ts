import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./paths.js";

export type DB = Database.Database;

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  identity_key        TEXT NOT NULL UNIQUE,
  source              TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  entity_ref          TEXT,
  trigger_type        TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  state               TEXT NOT NULL,
  mode                TEXT NOT NULL DEFAULT 'create',
  runner              TEXT,
  model               TEXT,
  custom_prompt       TEXT,
  repo                TEXT NOT NULL,
  worktree_path       TEXT,
  branch              TEXT,
  base_branch         TEXT DEFAULT 'main',
  routing_instruction TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  next_eligible_at    INTEGER,
  lease_owner         TEXT,
  lease_expires_at    INTEGER,
  last_heartbeat_at   INTEGER,
  declared_outcome    TEXT,
  declared_pr_url     TEXT,
  declared_wrote_code INTEGER,
  verified_outcome    TEXT,
  pr_url              TEXT,
  failure_class       TEXT,
  failure_detail      TEXT,
  summary             TEXT,
  -- v5: remote-runner session pointers (Conductor Cloud). Present so a daemon restart RESUMES the
  -- work already running off-machine instead of dispatching a duplicate cloud workspace.
  remote_provider     TEXT,
  remote_workspace_id TEXT,
  remote_session_id   TEXT,
  remote_url          TEXT,
  remote_cursor       TEXT,
  remote_saw_working  INTEGER,
  remote_polled_at    INTEGER,
  -- v6: verification gate + retry context. output_tail is the last lines of the previous run's
  -- output so a retry's prompt can carry it; verify_* record what the gate ran; criteria_*
  -- keep the agent's acceptance-criteria tally.
  verify_status       TEXT,
  verify_detail       TEXT,
  output_tail         TEXT,
  criteria_passed     INTEGER,
  criteria_total      INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  terminal_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state    ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_entity   ON jobs(entity_id);
-- idx_jobs_eligible is created in openDatabase() after the additive column migrations, since it
-- references next_eligible_at (which an older DB may not have yet).

CREATE TABLE IF NOT EXISTS inbound_events (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  channel      TEXT NOT NULL,
  raw_payload  TEXT NOT NULL,
  identity_key TEXT,
  job_id       TEXT,
  disposition  TEXT,
  reason       TEXT,
  received_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_events (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  data       TEXT,
  at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events ON job_events(job_id, seq);

CREATE TABLE IF NOT EXISTS pending_followups (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  trigger_type TEXT,
  content_hash TEXT,
  payload      TEXT,
  created_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS repo_health (
  repo                       TEXT PRIMARY KEY,
  consecutive_infra_failures INTEGER NOT NULL DEFAULT 0,
  breaker_state              TEXT NOT NULL DEFAULT 'closed',
  opened_at                  INTEGER,
  cooldown_until             INTEGER
);

CREATE TABLE IF NOT EXISTS side_effects (
  idempotency_key TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  external_id     TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_dependencies (
  dependent_entity_id TEXT NOT NULL,   -- the issue that is blocked (e.g. SBX-2)
  blocker_entity_id   TEXT NOT NULL,   -- the issue blocking it (e.g. SBX-1)
  strategy            TEXT NOT NULL DEFAULT 'wait',   -- 'wait' | 'stacked'
  resolved            INTEGER NOT NULL DEFAULT 0,     -- 1 once the blocker no longer gates
  blocker_branch      TEXT,            -- the blocker's head branch (for stacked base-off)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (dependent_entity_id, blocker_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_job_deps_dependent ON job_dependencies(dependent_entity_id, resolved);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  kind   TEXT,
  detail TEXT,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs ON schedule_runs(name, at);
`;

/** Open (creating if needed) the Milo SQLite database in WAL mode and apply the schema. */
export function openDatabase(path = dbPath()): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // daemon + CLI share the DB across processes
  db.exec(SCHEMA);
  // Idempotent additive migrations for databases created before a column existed. `CREATE TABLE IF
  // NOT EXISTS` won't add columns to an existing table, so reconcile via PRAGMA.
  const jobCols = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  if (!jobCols.has("custom_prompt")) db.exec("ALTER TABLE jobs ADD COLUMN custom_prompt TEXT");
  if (!jobCols.has("next_eligible_at")) db.exec("ALTER TABLE jobs ADD COLUMN next_eligible_at INTEGER");
  // v3: per-job transcript + raw runner log paths (recorded when a job reaches `running`).
  if (!jobCols.has("events_log")) db.exec("ALTER TABLE jobs ADD COLUMN events_log TEXT");
  if (!jobCols.has("runner_log")) db.exec("ALTER TABLE jobs ADD COLUMN runner_log TEXT");
  // v4: user-initiated cancel — an out-of-band flag the running worker polls (not a state, which
  // would race the pipeline's own running→verifying→… transitions).
  if (!jobCols.has("cancel_requested")) db.exec("ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0");
  if (!jobCols.has("cancel_requested_at")) db.exec("ALTER TABLE jobs ADD COLUMN cancel_requested_at INTEGER");
  // v5: remote-runner session pointers. `recoverOnStartup` requeues in-flight jobs on daemon start,
  // which for a remote job must mean "reattach to the workspace already doing the work", not "start
  // a second one" — these columns are what make that distinction possible.
  if (!jobCols.has("remote_provider")) db.exec("ALTER TABLE jobs ADD COLUMN remote_provider TEXT");
  if (!jobCols.has("remote_workspace_id")) db.exec("ALTER TABLE jobs ADD COLUMN remote_workspace_id TEXT");
  if (!jobCols.has("remote_session_id")) db.exec("ALTER TABLE jobs ADD COLUMN remote_session_id TEXT");
  if (!jobCols.has("remote_url")) db.exec("ALTER TABLE jobs ADD COLUMN remote_url TEXT");
  if (!jobCols.has("remote_cursor")) db.exec("ALTER TABLE jobs ADD COLUMN remote_cursor TEXT");
  if (!jobCols.has("remote_saw_working")) db.exec("ALTER TABLE jobs ADD COLUMN remote_saw_working INTEGER");
  // Liveness for a PARKED remote job: it holds no worker lease for hours at a time, so the
  // ordinary lease watchdog cannot see it. This is what `reclaimStalledRemote` keys on.
  if (!jobCols.has("remote_polled_at")) db.exec("ALTER TABLE jobs ADD COLUMN remote_polled_at INTEGER");
  // v6: verification gate results + the previous attempt's output tail (retry context) + criteria.
  if (!jobCols.has("verify_status")) db.exec("ALTER TABLE jobs ADD COLUMN verify_status TEXT");
  if (!jobCols.has("verify_detail")) db.exec("ALTER TABLE jobs ADD COLUMN verify_detail TEXT");
  if (!jobCols.has("output_tail")) db.exec("ALTER TABLE jobs ADD COLUMN output_tail TEXT");
  if (!jobCols.has("criteria_passed")) db.exec("ALTER TABLE jobs ADD COLUMN criteria_passed INTEGER");
  if (!jobCols.has("criteria_total")) db.exec("ALTER TABLE jobs ADD COLUMN criteria_total INTEGER");
  // Created here (not in SCHEMA) so the next_eligible_at column exists first on migrated databases.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_eligible ON jobs(state, next_eligible_at)");
  db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', '6') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
  return db;
}
