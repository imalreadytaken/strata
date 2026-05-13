# system-tables Specification

## Purpose

`system-tables` ships the eight first-party SQL migrations that create Strata's core schema — `messages`, `raw_events`, `capability_registry`, `schema_evolutions`, `reextract_jobs`, `builds`, `proposals`, `capability_health` — plus the FTS5 shadow on `messages`. Together they implement the two-layer data model (`messages → raw_events → business tables`), the capability lifecycle ledger, the in-flight-build state machine, and the schema-evolution + backfill registry. Business tables are emitted per-capability at runtime; this spec covers only the always-present core.

## Requirements
### Requirement: All eight system tables are created by applying SYSTEM_MIGRATIONS_DIR

The system SHALL ship migration files under `src/db/migrations/` such that running `applyMigrations(db, SYSTEM_MIGRATIONS_DIR)` against a fresh SQLite database creates these tables and the `messages_fts` virtual table:

- `messages`
- `raw_events`
- `capability_registry`
- `schema_evolutions`
- `reextract_jobs`
- `builds`
- `proposals`
- `capability_health`
- `messages_fts` (FTS5 contentless-shadow table)

Each migration filename MUST conform to `^\d{3}_.+\.sql$`. The numerical prefixes MUST be `001`–`008` in dependency order (or simple lexicographic order if SQLite's FK-resolution is forward-tolerant). The system SHALL expose `SYSTEM_MIGRATIONS_DIR` as an absolute path resolved at module load time.

#### Scenario: Fresh DB ends up with every system table

- **WHEN** `applyMigrations(db, SYSTEM_MIGRATIONS_DIR)` is run against an empty database
- **THEN** `summary.applied` lists eight files in lexicographic order, and `sqlite_master` contains rows for each of the nine table names above

#### Scenario: Re-run is a no-op

- **WHEN** `applyMigrations` is run twice in succession with the system migrations dir
- **THEN** the second run reports `applied === []` and every filename in `skipped`

### Requirement: messages table enforces role and content_type CHECKs and indexes session+turn

The `messages` table SHALL have CHECK constraints:

- `role IN ('user', 'assistant', 'system')`
- `content_type IN ('text', 'image', 'audio', 'file', 'callback')`

It SHALL have an index `idx_messages_session` on `(session_id, turn_index)`. An FTS5 virtual table `messages_fts` SHALL mirror `content` via INSERT and UPDATE triggers.

#### Scenario: CHECK constraint rejects an unknown role

- **WHEN** a row with `role = 'tool'` is INSERTed
- **THEN** SQLite raises a constraint failure

#### Scenario: FTS5 trigger populates the index

- **WHEN** a row is INSERTed into `messages` with `content = 'coffee at blue bottle'`
- **THEN** `SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'coffee'` returns that row's id

### Requirement: raw_events is the append-only event ledger and tracks correction chains

The `raw_events` table SHALL have a CHECK constraint `status IN ('pending', 'committed', 'superseded', 'abandoned')` and an `extraction_confidence` CHECK requiring `NULL OR (0 <= value <= 1)`.

The table SHALL include self-referencing FKs `supersedes_event_id` and `superseded_by_event_id` so a correction chain is traversable. The table SHALL NOT enforce immutability at the schema level — that is a runtime/code rule (AGENTS.md #1) — but the schema MUST make corrections cheap by indexing `supersedes_event_id` where non-null.

#### Scenario: CHECK constraint rejects an unknown status

- **WHEN** an INSERT sets `status = 'maybe'`
- **THEN** SQLite raises a constraint failure

#### Scenario: extraction_confidence rejects values outside [0,1]

- **WHEN** an INSERT sets `extraction_confidence = 1.5`
- **THEN** SQLite raises a constraint failure

### Requirement: capability_registry tracks lifecycle status

The `capability_registry` table SHALL have a CHECK constraint `status IN ('active', 'archived', 'deleted')`, an index on `status`, and FKs to `proposals(id)` and `builds(id)` (nullable).

#### Scenario: status CHECK rejects unknown values

- **WHEN** `INSERT INTO capability_registry (..., status) VALUES (..., 'paused')`
- **THEN** SQLite raises a constraint failure

### Requirement: schema_evolutions tracks every schema change and its backfill

The `schema_evolutions` table SHALL have CHECK constraints on `change_type` (`capability_create`, `add_column`, `modify_column`, `remove_column`, `rename_column`, `add_constraint`, `capability_archive`, `capability_restore`) and on `backfill_status` (`NULL OR IN ('not_needed', 'pending', 'running', 'done', 'failed', 'partial')`).

The table MUST reference `capability_registry(name)` via a `capability_name` FK and `reextract_jobs(id)` via `backfill_job_id`.

#### Scenario: change_type CHECK rejects unknown values

- **WHEN** `INSERT INTO schema_evolutions (..., change_type) VALUES (..., 'weird')`
- **THEN** SQLite raises a constraint failure

### Requirement: reextract_jobs tracks worker progress

The `reextract_jobs` table SHALL have a CHECK constraint `status IN ('pending', 'running', 'paused', 'done', 'failed')` and an index on `status`. Counters `rows_total`, `rows_done`, `rows_failed`, `rows_low_confidence` SHALL default to `0`.

#### Scenario: status CHECK rejects unknown values

- **WHEN** `INSERT INTO reextract_jobs (..., status) VALUES (..., 'whatever')`
- **THEN** SQLite raises a constraint failure

### Requirement: builds tracks the Build Bridge state machine

The `builds` table SHALL have CHECK constraints `phase IN ('plan','decompose','build','integrate','post_deploy','done','failed','cancelled','paused')`, `trigger_kind IN ('user_request','reflect_proposal')`, and `target_action IN ('create','evolve','archive')`. It SHALL be indexed on `phase` and on `session_id`.

#### Scenario: phase CHECK rejects unknown values

- **WHEN** `INSERT INTO builds (..., phase) VALUES (..., 'reviewing')`
- **THEN** SQLite raises a constraint failure

### Requirement: proposals tracks Reflect-Agent and user-requested suggestions

The `proposals` table SHALL have CHECK constraints `status IN ('pending','approved','declined','expired','applied')`, `kind IN ('new_capability','schema_evolution','capability_archive','capability_demote')`, and `source IN ('reflect_agent','user_request')`. It SHALL be indexed on `status` and on `target_capability` (partial index, only when non-null).

#### Scenario: status CHECK rejects unknown values

- **WHEN** `INSERT INTO proposals (..., status) VALUES (..., 'rejected')`
- **THEN** SQLite raises a constraint failure

### Requirement: capability_health stores only mechanical counters

The `capability_health` table SHALL key on `capability_name` (FK to `capability_registry(name)`), and SHALL store only mechanical counters and timestamps — never derived "scores" or thresholds. Counters `total_writes`, `total_reads`, `total_corrections` SHALL default to `0`.

#### Scenario: A row can be upserted by capability_name

- **WHEN** `INSERT OR REPLACE` is run on `capability_health` with a known `capability_name`
- **THEN** the row is replaced atomically and the counter defaults apply when the INSERT omits them

