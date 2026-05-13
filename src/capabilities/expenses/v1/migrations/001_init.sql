-- expenses capability v1 — initial schema.
--
-- Business table for personal consumption. Every row traces back to one
-- raw_event via `raw_event_id` (AGENTS.md hard constraint #4). Money lives
-- in INTEGER minor units paired with a TEXT currency code (hard constraint
-- #2); time is ISO 8601 with timezone (hard constraint #3).

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Mandatory: traceability + extraction telemetry (AGENTS.md #4).
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extraction_confidence REAL,

  -- Mandatory: time of the expense as the user lives it.
  occurred_at TEXT NOT NULL,

  -- Domain: money + merchant + category.
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  merchant TEXT,
  category TEXT,

  -- Mandatory meta.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (amount_minor >= 0),
  CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  CHECK (
    category IS NULL OR category IN (
      'dining',
      'transport',
      'groceries',
      'entertainment',
      'service',
      'health',
      'other'
    )
  )
);

CREATE INDEX idx_expenses_occurred ON expenses(occurred_at);
CREATE INDEX idx_expenses_category ON expenses(category);
