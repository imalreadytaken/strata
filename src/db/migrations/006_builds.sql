-- STRATA_SPEC.md §3.1 — builds
--
-- One row per Build Bridge session. Tracks the phase state machine
-- (plan → decompose → build → integrate → post_deploy → done) and points
-- to the Claude Code session ID so a build can be resumed across restarts.

CREATE TABLE builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,

  -- Trigger.
  trigger_kind TEXT NOT NULL,      -- 'user_request' | 'reflect_proposal'
  trigger_proposal_id INTEGER REFERENCES proposals(id),

  -- Target.
  target_capability TEXT NOT NULL,
  target_action TEXT NOT NULL,     -- 'create' | 'evolve' | 'archive'

  -- State machine.
  phase TEXT NOT NULL,
  plan_path TEXT,                  -- plans/<timestamp>-<target>/PLAN.md
  workdir_path TEXT,               -- builds/<session_id>/
  claude_session_id TEXT,          -- Claude Code session for resume

  -- Progress.
  changes_total INTEGER,
  changes_done INTEGER NOT NULL DEFAULT 0,
  current_change_id TEXT,

  -- Times.
  created_at TEXT NOT NULL,
  paused_at TEXT,
  completed_at TEXT,
  last_heartbeat_at TEXT,

  -- Failure.
  failure_reason TEXT,

  CHECK (phase IN ('plan', 'decompose', 'build', 'integrate', 'post_deploy', 'done', 'failed', 'cancelled', 'paused')),
  CHECK (trigger_kind IN ('user_request', 'reflect_proposal')),
  CHECK (target_action IN ('create', 'evolve', 'archive'))
);

CREATE INDEX idx_builds_phase   ON builds(phase);
CREATE INDEX idx_builds_session ON builds(session_id);
