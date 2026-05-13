-- STRATA_SPEC.md §3.1 — schema_evolutions
--
-- Every schema change a capability undergoes is logged here, along with the
-- backfill strategy used to bring historical data forward. AGENTS.md hard
-- constraint #6: any ALTER TABLE in a capability migration MUST INSERT into
-- this table.

CREATE TABLE schema_evolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_name TEXT NOT NULL REFERENCES capability_registry(name),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,

  -- What changed.
  change_type TEXT NOT NULL,
  diff TEXT NOT NULL,              -- JSON

  -- Tie-in to OpenSpec.
  openspec_change_id TEXT,

  -- User decision trail.
  proposed_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,                -- 'user' | 'reflect_agent_auto'
  applied_at TEXT,

  -- Backfill.
  backfill_strategy TEXT,
  backfill_status TEXT,
  backfill_job_id INTEGER REFERENCES reextract_jobs(id),

  CHECK (change_type IN ('capability_create', 'add_column', 'modify_column', 'remove_column', 'rename_column', 'add_constraint', 'capability_archive', 'capability_restore')),
  CHECK (backfill_status IS NULL OR backfill_status IN ('not_needed', 'pending', 'running', 'done', 'failed', 'partial'))
);

CREATE INDEX idx_schema_evolutions_capability ON schema_evolutions(capability_name, to_version);
