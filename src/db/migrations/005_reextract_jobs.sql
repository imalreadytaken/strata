-- STRATA_SPEC.md §3.1 — reextract_jobs
--
-- Re-extraction worker queue. One row per backfill job triggered by a
-- schema evolution. The worker (src/reextract/worker.ts, P6) drains this
-- table by polling for status = 'pending'.

CREATE TABLE reextract_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_evolution_id INTEGER NOT NULL REFERENCES schema_evolutions(id),
  capability_name TEXT NOT NULL,
  strategy TEXT NOT NULL,

  -- Progress counters.
  status TEXT NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_done INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  rows_low_confidence INTEGER NOT NULL DEFAULT 0,

  -- Cost telemetry.
  estimated_cost_cents INTEGER,
  actual_cost_cents INTEGER,

  -- Times.
  started_at TEXT,
  completed_at TEXT,
  last_checkpoint_at TEXT,

  -- Errors.
  last_error TEXT,

  CHECK (status IN ('pending', 'running', 'paused', 'done', 'failed'))
);

CREATE INDEX idx_reextract_status ON reextract_jobs(status);
