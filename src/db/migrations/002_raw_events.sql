-- STRATA_SPEC.md §3.1 — raw_events
--
-- The second layer: a semantic event extracted from one or more messages.
-- Append-only by convention (AGENTS.md hard constraint #1) — corrections go
-- through supersedes_event_id / superseded_by_event_id rather than UPDATE.

CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,

  -- Semantic info.
  event_type TEXT NOT NULL,        -- 'unclassified' | 'consumption' | 'mood_log' | ...
  status TEXT NOT NULL,            -- 'pending' | 'committed' | 'superseded' | 'abandoned'

  -- Content.
  extracted_data TEXT NOT NULL,    -- JSON
  source_summary TEXT NOT NULL,    -- one-line description

  -- Link back to messages.
  primary_message_id INTEGER NOT NULL REFERENCES messages(id),
  related_message_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array

  -- Time.
  event_occurred_at TEXT,          -- user-described time (may differ from received_at)
  committed_at TEXT,

  -- Correction chain.
  supersedes_event_id INTEGER REFERENCES raw_events(id),
  superseded_by_event_id INTEGER REFERENCES raw_events(id),
  abandoned_reason TEXT,

  -- Link to business table.
  capability_name TEXT,            -- 'expenses' / 'moods' / ...
  business_row_id INTEGER,         -- row id in the capability's primary table

  -- Extraction version + telemetry.
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extraction_confidence REAL,
  extraction_errors TEXT,          -- JSON

  -- Meta.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (status IN ('pending', 'committed', 'superseded', 'abandoned')),
  CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1))
);

CREATE INDEX idx_raw_events_status     ON raw_events(status, capability_name);
CREATE INDEX idx_raw_events_session    ON raw_events(session_id);
CREATE INDEX idx_raw_events_occurred   ON raw_events(event_occurred_at) WHERE event_occurred_at IS NOT NULL;
CREATE INDEX idx_raw_events_capability ON raw_events(capability_name, status);
CREATE INDEX idx_raw_events_supersedes ON raw_events(supersedes_event_id) WHERE supersedes_event_id IS NOT NULL;
