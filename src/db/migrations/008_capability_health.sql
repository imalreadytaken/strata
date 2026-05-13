-- STRATA_SPEC.md §3.1 — capability_health
--
-- Mechanical usage counters only — explicitly NOT computed scores or
-- thresholds (§3.1: "this table only does mechanical statistics ... the
-- real judgment logic lives in Reflect Agent code"). Keeping subjective
-- normalization out of the schema means dogfood-driven threshold tuning
-- never requires a migration.

CREATE TABLE capability_health (
  capability_name TEXT PRIMARY KEY REFERENCES capability_registry(name),

  -- Usage counters.
  total_writes INTEGER NOT NULL DEFAULT 0,
  total_reads INTEGER NOT NULL DEFAULT 0,
  total_corrections INTEGER NOT NULL DEFAULT 0,

  -- Time markers.
  last_write_at TEXT,
  last_read_at TEXT,

  updated_at TEXT NOT NULL
);
