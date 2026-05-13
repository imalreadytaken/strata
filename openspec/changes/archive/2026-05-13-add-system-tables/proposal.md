## Why

The eight Strata "core" tables described in `STRATA_SPEC.md` §3.1 are the spine the rest of the plugin hangs on:

- `messages` and `raw_events` are the two-layer data model
- `capability_registry`, `schema_evolutions`, `capability_health` track capability lifecycle
- `builds`, `proposals` track in-flight co-builds
- `reextract_jobs` tracks historical-data backfill

Until these tables exist, no hook, tool, skill, or capability can store anything. They belong in a dedicated change so review can focus on schema correctness independently of repository code.

References: `STRATA_SPEC.md` §3.1 (DDL for all eight tables), §3.2 (business-table required-fields convention), AGENTS.md hard constraints #1 (raw_events append-only), #2 (INTEGER minor money — not enforced at this layer but documented), #3 (ISO 8601 timestamps), #5 (immutable migrations), #6 (`schema_evolutions` registry).

## What Changes

- Add `system-tables` capability covering:
  - Eight `NNN_*.sql` files under `src/db/migrations/` containing the verbatim DDL from `STRATA_SPEC.md` §3.1 — with FTS5 virtual table + triggers on `messages`, all CHECK constraints, all indexes
  - A `SYSTEM_MIGRATIONS_DIR` export (resolved relative to `import.meta.url`) so callers don't need to know the path
  - Integration tests that apply all eight migrations to a fresh DB and verify: every table exists, every CHECK rejects bad data, every UNIQUE / FK enforces, FTS5 trigger populates the index on INSERT

## Capabilities

### New Capabilities
- `system-tables`: eight versioned SQL migrations defining Strata's core schema, plus a path constant for the migration runner.

### Modified Capabilities
*(none — first set of system tables)*

## Impact

- **Files added**: `src/db/migrations/00{1..8}_*.sql`, a path-resolving export in `src/db/index.ts`, and `src/db/migrations/system-tables.test.ts`
- **Dependencies**: none new
- **Runtime side-effects**: when `applyMigrations(db, SYSTEM_MIGRATIONS_DIR)` runs against a fresh DB, eight tables + the FTS5 virtual table + indexes are created
- **Non-goals**: no business tables (those are emitted per-capability by `pipeline.ts` at run time), no DML / sample data, no schema-evolution example, no repository implementations (`add-repositories` follows)
