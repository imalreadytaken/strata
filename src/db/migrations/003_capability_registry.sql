-- STRATA_SPEC.md §3.1 — capability_registry
--
-- Records every capability that has actually landed code on disk. Proposals
-- and in-flight builds live in their own tables; this table is the source
-- of truth for "what capabilities exist and are loadable right now."

CREATE TABLE capability_registry (
  name TEXT PRIMARY KEY,           -- 'expenses' / 'moods' / ...
  version INTEGER NOT NULL,        -- current active version

  -- Lifecycle status (see STRATA_SPEC.md §5.5).
  -- Rows only appear here after the code has been installed; proposals are
  -- elsewhere.
  status TEXT NOT NULL,

  meta_path TEXT NOT NULL,         -- capabilities/<name>/v<N>/meta.json path
  primary_table TEXT NOT NULL,     -- e.g. 'expenses'

  -- Times.
  created_at TEXT NOT NULL,        -- first entered 'active'
  archived_at TEXT,
  deleted_at TEXT,                 -- soft delete marker

  -- Source.
  proposal_id INTEGER REFERENCES proposals(id),
  build_id INTEGER REFERENCES builds(id),

  CHECK (status IN ('active', 'archived', 'deleted'))
);

CREATE INDEX idx_capability_status ON capability_registry(status);
