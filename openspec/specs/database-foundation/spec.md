# database-foundation Specification

## Purpose

`database-foundation` is the SQLite layer every other Strata module sits on. It opens (and creates) `~/.strata/main.db` with the pragmas Strata's tables assume — foreign keys on, WAL journaling, normal sync, 5s busy timeout — loads `sqlite-vec` for vector ops, defines the `Repository<T>` contract that lets later phases stay agnostic about SQL, and ships a migration runner that applies versioned `NNN_*.sql` files exactly once and refuses to silently re-run an edited one (AGENTS.md hard constraint #5: migrations are immutable).
## Requirements
### Requirement: Database connection is configured with safe defaults

The system SHALL expose `openDatabase(opts: { path: string; loadVec?: boolean }): Database` that returns a `better-sqlite3` handle with:

- `foreign_keys = ON` (off by default in SQLite)
- `journal_mode = WAL` (concurrent readers + crash safety)
- `synchronous = NORMAL` (the standard fsync trade-off for WAL)
- `busy_timeout = 5000` ms
- Parent directory created (`mkdir -p`) if missing
- `sqlite-vec` extension loaded when `loadVec` is `true` (default `true`)

`openDatabase` MUST throw `DatabaseError('STRATA_E_DB_OPEN_FAILED', ...)` if the file cannot be opened, with the OS error as the cause. The handle MUST be usable for subsequent queries with no further setup.

#### Scenario: Opens a fresh database and applies all pragmas

- **WHEN** `openDatabase({ path: '<tmp>/main.db' })` is called for a non-existent path
- **THEN** the file is created, the function returns a `Database` instance, and `PRAGMA foreign_keys`, `journal_mode`, `synchronous`, and `busy_timeout` all report the configured values

#### Scenario: Wraps an OS error in DatabaseError

- **WHEN** `openDatabase({ path: '/nonexistent-root/x/y/main.db' })` cannot create the parent directory because the root is read-only
- **THEN** the call rejects with a `DatabaseError` whose `code === 'STRATA_E_DB_OPEN_FAILED'` and whose `cause` is the underlying error

#### Scenario: Loads sqlite-vec by default

- **WHEN** `openDatabase({ path: '<tmp>/main.db' })` returns
- **THEN** `SELECT vec_version();` succeeds, confirming the extension is loaded

### Requirement: Repository interface

The system SHALL expose a generic `Repository<T, ID = number>` interface declaring the following methods. The default `ID` is `number`, so existing call sites are unaffected; tables whose primary key is a string (e.g. `capability_registry.name`, `capability_health.capability_name`) instantiate the interface with `ID = string`.

- `findById(id: ID): Promise<T | null>`
- `findMany(filter: Partial<T>, options?: { limit?: number; offset?: number; orderBy?: keyof T; direction?: 'asc' | 'desc' }): Promise<T[]>`
- `insert(data: Partial<T>): Promise<T>` — the loose `Partial<T>` accommodates both synthetic-id tables (caller omits `id`) and natural-key tables (caller must provide the key column); concrete implementations validate required fields at runtime
- `update(id: ID, patch: Partial<T>): Promise<T>`
- `softDelete(id: ID): Promise<void>` — semantic delete; concrete implementations decide which column flips
- `count(filter?: Partial<T>): Promise<number>`
- `transaction<R>(fn: () => Promise<R>): Promise<R>`

The interface MUST NOT prescribe how implementations talk to SQLite — it is a contract, not an implementation.

#### Scenario: Type-only contract compiles for number-ID tables

- **WHEN** a downstream module imports `Repository<T>` (default `ID = number`) and writes a stub class declaring the methods
- **THEN** the TypeScript compiler accepts the class without raw-SQL leakage from `Repository<T>`

#### Scenario: Type-only contract compiles for string-ID tables

- **WHEN** a downstream module imports `Repository<T, string>` and writes a stub class with `findById(id: string)`, `update(id: string, ...)` etc.
- **THEN** the TypeScript compiler accepts the class without complaint

### Requirement: Migration runner applies versioned SQL files exactly once

The system SHALL expose `applyMigrations(db: Database, dir: string): MigrationSummary` that:

1. Ensures a ledger table `_strata_migrations` exists with columns `(filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`.
2. Reads every regular file in `dir` whose name matches `^\d{3}_.+\.sql$`, sorted lexicographically by filename.
3. For each migration file:
   - Compute a SHA-256 checksum of the file contents.
   - If the filename is in the ledger and the checksum matches, skip it.
   - If the filename is in the ledger but the checksum differs, throw `DatabaseError('STRATA_E_DB_MIGRATE_FAILED', ...)` referencing the file and the mismatch.
   - Otherwise, apply the file's SQL inside a single transaction, then insert a ledger row.
4. Returns `{ applied: string[]; skipped: string[] }`.

The function MUST be safe to run twice in a row with no side effects on the second call.

#### Scenario: Applies all migrations to a fresh DB

- **WHEN** a fresh database is given a directory containing `001_a.sql` and `002_b.sql`
- **THEN** both files are applied in order, the ledger contains two rows, and `summary.applied === ['001_a.sql', '002_b.sql']`

#### Scenario: Skips already-applied migrations

- **WHEN** `applyMigrations` is called twice with the same directory
- **THEN** the second call reports `applied === []` and `skipped` contains every filename, and no schema change occurs

#### Scenario: Refuses to silently re-run an edited migration

- **WHEN** a migration that has already been applied is edited on disk and `applyMigrations` is called again
- **THEN** the call throws a `DatabaseError` with code `STRATA_E_DB_MIGRATE_FAILED`, the error message identifies the offending filename, and no further migrations are attempted

#### Scenario: Rejects malformed migration filenames

- **WHEN** the directory contains a file named `foo.sql` (no `NNN_` prefix)
- **THEN** the file is ignored — it is not applied, and the ledger is not updated

