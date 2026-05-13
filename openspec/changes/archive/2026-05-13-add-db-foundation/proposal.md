## Why

Strata uses SQLite at `~/.strata/main.db` as the source of truth (`STRATA_SPEC.md` §2.1, §3, §4.1). Before any system or business table can be created we need three thin primitives:

1. A configured database connection (foreign keys on, WAL, `sqlite-vec` loaded for embeddings)
2. A `Repository<T>` interface so the application layer never writes raw SQL — the spec explicitly says this so we can keep the option of swapping in Postgres later (§3.3)
3. A migration runner that applies versioned `.sql` files in order and refuses to re-run or silently re-edit them (AGENTS.md hard constraint #5: migrations are immutable)

Landing these now keeps the next change (`add-system-tables`) focused on schema only.

References: `STRATA_SPEC.md` §3.3 (Repository interface), §4.1 (filesystem layout), §10.1 (config schema for `database.path`), AGENTS.md hard constraints #5 and #6 (immutable migrations + `schema_evolutions` updates on alter).

## What Changes

- Add `database-foundation` capability covering:
  - **Connection**: a `openDatabase(config)` function returning a configured `better-sqlite3` handle (`foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`), with `sqlite-vec` loaded for vector ops.
  - **Repository abstraction**: a `Repository<T>` interface declaring `findById` / `findMany` / `insert` / `update` / `softDelete` / `transaction`. Implementations land in `add-repositories`.
  - **Migration runner**: `applyMigrations(db, dir)` discovers `NNN_*.sql` files, tracks applied filenames + content checksum in a `_strata_migrations` ledger, applies each new file inside a transaction, and throws on checksum mismatch (refuses to silently re-run an edited migration).

## Capabilities

### New Capabilities
- `database-foundation`: SQLite connection setup, repository contract, and migration runner.

### Modified Capabilities
*(none — `core-infrastructure` already exists but is not modified)*

## Impact

- **Files added**: `src/db/{connection,repository,migrations,index}.ts` + co-located `*.test.ts`
- **Dependencies**: `better-sqlite3` and `sqlite-vec` (already declared); no new deps
- **Runtime side-effects**: opens / creates `<config.database.path>` on first call; creates the parent dir; creates `_strata_migrations` ledger if absent
- **Non-goals**: no concrete `SQLiteRepository<T>` implementation yet (lives in `add-repositories`), no business or system tables (`add-system-tables`), no embedding generation logic, no Postgres adapter
