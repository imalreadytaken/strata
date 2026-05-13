## 1. Migration SQL files

- [x] 1.1 Write `src/db/migrations/001_messages.sql` — `messages` table + `idx_messages_session` + `idx_messages_time` + `idx_messages_raw_event` (partial) + `messages_fts` FTS5 virtual table + INSERT, UPDATE, and DELETE triggers (D6: spec's UPDATE trigger is wrong for external-content FTS5; we use delete-then-insert and add a delete trigger).
- [x] 1.2 Write `src/db/migrations/002_raw_events.sql` — `raw_events` table + 5 indexes (status, session, occurred (partial), capability, supersedes (partial)).
- [x] 1.3 Write `src/db/migrations/003_capability_registry.sql` — `capability_registry` + `idx_capability_status`.
- [x] 1.4 Write `src/db/migrations/004_schema_evolutions.sql` — `schema_evolutions` + `idx_schema_evolutions_capability`.
- [x] 1.5 Write `src/db/migrations/005_reextract_jobs.sql` — `reextract_jobs` + `idx_reextract_status`.
- [x] 1.6 Write `src/db/migrations/006_builds.sql` — `builds` + `idx_builds_phase` + `idx_builds_session`.
- [x] 1.7 Write `src/db/migrations/007_proposals.sql` — `proposals` + `idx_proposals_status` + `idx_proposals_capability` (partial).
- [x] 1.8 Write `src/db/migrations/008_capability_health.sql` — `capability_health` keyed by `capability_name`.

## 2. Path constant

- [x] 2.1 Export `SYSTEM_MIGRATIONS_DIR` from `src/db/index.ts`, resolved via `import.meta.url`.

## 3. Tests

- [x] 3.1 Create `src/db/migrations/system-tables.test.ts`. Open a temp DB, run `applyMigrations(db, SYSTEM_MIGRATIONS_DIR)`, assert all nine table names appear in `sqlite_master` (eight base tables + `messages_fts`).
- [x] 3.2 Re-run `applyMigrations` and assert `summary.applied === []` and `summary.skipped.length === 8`.
- [x] 3.3 For each table with a CHECK constraint mentioned in the spec, write one assertion that an invalid value throws (9 CHECK tests).
- [x] 3.4 INSERT a row into `messages` with `content = 'coffee at blue bottle'`, then assert `messages_fts MATCH 'coffee'` returns the row. Also assert UPDATE propagates through the trigger (catches the D6 bug if it ever regresses).
- [x] 3.5 Assert FK enforcement: inserting a row into `raw_events` with `primary_message_id = 999` (non-existent) raises a constraint failure, and likewise for `schema_evolutions` against an unknown capability_name.

## 4. Integration

- [x] 4.1 Run `npm run typecheck` → clean.
- [x] 4.2 Run `npm test` → all tests pass (70 total).
