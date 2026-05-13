-- STRATA_SPEC.md §3.1 — proposals
--
-- Reflect Agent and user-requested proposals for new capabilities, schema
-- evolutions, or archives. Lives separately from capability_registry —
-- proposals are suggestions; only after a build completes does a row appear
-- in capability_registry.

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Source.
  source TEXT NOT NULL,            -- 'reflect_agent' | 'user_request'

  -- Kind.
  kind TEXT NOT NULL,
  target_capability TEXT,          -- existing capability name (if evolve/archive)

  -- Content.
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposed_design TEXT,            -- JSON, specific design suggestions

  -- Signal.
  signal_strength REAL,            -- 0-1
  evidence_event_ids TEXT,         -- JSON array of raw_event ids
  estimated_cost_cents INTEGER,
  estimated_time_minutes INTEGER,

  -- State.
  status TEXT NOT NULL,

  -- Times.
  created_at TEXT NOT NULL,
  pushed_to_user_at TEXT,
  responded_at TEXT,
  expires_at TEXT,                 -- 30 days no-response → expired
  cooldown_until TEXT,             -- after decline

  -- Tie-in.
  resulting_build_id INTEGER REFERENCES builds(id),

  CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'applied')),
  CHECK (kind IN ('new_capability', 'schema_evolution', 'capability_archive', 'capability_demote')),
  CHECK (source IN ('reflect_agent', 'user_request'))
);

CREATE INDEX idx_proposals_status     ON proposals(status);
CREATE INDEX idx_proposals_capability ON proposals(target_capability) WHERE target_capability IS NOT NULL;
