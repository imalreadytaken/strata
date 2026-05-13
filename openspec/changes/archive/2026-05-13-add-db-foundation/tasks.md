## 1. Connection

- [x] 1.1 Create `src/db/connection.ts`. Re-export `better-sqlite3`'s `Database` type. Define `OpenDatabaseOptions = { path: string; loadVec?: boolean }`.
- [x] 1.2 Implement `openDatabase(opts)`:
  - `mkdirSync(dirname(opts.path), { recursive: true })`
  - `new Database(opts.path)` — wrap in try/catch and rethrow as `DatabaseError('STRATA_E_DB_OPEN_FAILED', ..., { cause })`
  - Apply pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`
  - If `loadVec !== false`, call `sqliteVec.load(db)` (default export) and sanity-check by selecting `vec_version()`
- [x] 1.3 Write `src/db/connection.test.ts`: pragma round-trip, `vec_version()` returns a non-empty string, error wrapping when the parent dir cannot be created (use `/System/...` on macOS — read-only volume).

## 2. Repository interface

- [x] 2.1 Create `src/db/repository.ts` exporting:
  - `interface Repository<T extends { id: number }>` with methods `findById`, `findMany`, `count`, `insert`, `update`, `softDelete`, `transaction` (all `Promise`-returning).
  - `type FindManyOptions<T> = { limit?: number; offset?: number; orderBy?: keyof T; direction?: 'asc' | 'desc' }`.
- [x] 2.2 Add `src/db/repository.test.ts` that *type-checks* the interface by declaring a no-op stub class implementing it — exists so a later breaking change to the interface fails fast.

## 3. Migration runner

- [x] 3.1 Create `src/db/migrations.ts`. Define:
  - `const MIGRATION_FILE_RE = /^\d{3}_.+\.sql$/`
  - `const LEDGER_DDL = 'CREATE TABLE IF NOT EXISTS _strata_migrations (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)'`
- [x] 3.2 Implement helper `sha256(content: string): string` using `node:crypto`.
- [x] 3.3 Implement `applyMigrations(db, dir): { applied: string[]; skipped: string[] }`:
  - Run `LEDGER_DDL` (idempotent)
  - `fs.readdirSync(dir).filter(name => MIGRATION_FILE_RE.test(name)).sort()`
  - For each file: read content, hash, check ledger
    - Found + checksum match → push to `skipped`
    - Found + checksum mismatch → throw `DatabaseError('STRATA_E_DB_MIGRATE_FAILED', ...)` referencing the file and both hashes
    - Not found → wrap `db.exec(sql) + ledger insert` in `db.transaction(...)`, push to `applied`
  - Return summary
- [x] 3.4 Write `src/db/migrations.test.ts`: apply / re-run-skips / checksum-mismatch-throws / malformed-filename-ignored / non-migration-files-ignored.

## 4. Barrel and integration

- [x] 4.1 Create `src/db/index.ts` re-exporting `openDatabase`, the `Repository` interface, `applyMigrations`, and the `Database` type.
- [x] 4.2 Run `npm run typecheck` → must pass cleanly.
- [x] 4.3 Run `npm test` → all unit tests pass (55 total).
