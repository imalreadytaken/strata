## 1. Base class

- [x] 1.1 Create `src/db/repositories/base.ts`. Define `SQLiteRepository<T extends object, ID = number>` with constructor `(db, table: string, columns: readonly string[], opts?: { now?: () => string; pkColumn?: string })`.
- [x] 1.2 Implement `findById`, `findMany`, `count` using parameterised `WHERE` built from `Object.entries(filter)`. Skip the `WHERE` clause entirely when the filter is empty. Emit `LIMIT -1 OFFSET ?` when only `offset` is supplied (SQLite quirk).
- [x] 1.3 Implement `insert(data)` using `INSERT INTO <table> (<columns>) VALUES (?, ?, ...) RETURNING *`. Bind only configured columns from `data`.
- [x] 1.4 Implement `update(id, patch)`: validate every patch key against `columns`; throw `ValidationError('STRATA_E_VALIDATION', ...)` on unknown key. Build `UPDATE ... SET col=? ... WHERE pk = ? RETURNING *`. Empty patch → return `findById(id)` (throws `ValidationError` if missing).
- [x] 1.5 Implement default `softDelete(id)` to throw `StateMachineError('STRATA_E_STATE_TRANSITION', ...)`.
- [x] 1.6 Implement `transaction(fn)` using manual `BEGIN` / `COMMIT` / `ROLLBACK` (better-sqlite3's `db.transaction` wrapper is synchronous and can't await; manual control gives true rollback across awaits inside `fn`).

## 2. Eight concrete repositories

- [x] 2.1 `src/db/repositories/messages.ts` — `MessageRow` + `MessagesRepository`. Override softDelete → throws. Add `getNextTurnIndex(session_id)` and `updateEmbedding(id, Float32Array)`.
- [x] 2.2 `src/db/repositories/raw_events.ts` — `RawEventRow` (with `RawEventStatus` union) + `RawEventsRepository`. softDelete → throws. Add `findExpiredPending(timeoutMinutes)`.
- [x] 2.3 `src/db/repositories/capability_registry.ts` — `CapabilityRegistryRow` + class. PK is `name` (TEXT); use the base's `pkColumn` option. softDelete → flip `status='archived'`, stamp `archived_at`.
- [x] 2.4 `src/db/repositories/schema_evolutions.ts` — softDelete → throws (append-only ledger).
- [x] 2.5 `src/db/repositories/reextract_jobs.ts` — softDelete → throws (state machine). Add `increment(id, column, delta?)` for atomic counter updates.
- [x] 2.6 `src/db/repositories/builds.ts` — softDelete → flip `phase='cancelled'`, stamp `completed_at`.
- [x] 2.7 `src/db/repositories/proposals.ts` — softDelete → flip `status='declined'`, stamp `responded_at`.
- [x] 2.8 `src/db/repositories/capability_health.ts` — PK is `capability_name`. softDelete → throws (counter table). Add `incrementWrite(name)`, `incrementRead(name)`, `incrementCorrection(name)` using `INSERT ... ON CONFLICT DO UPDATE` for atomic upsert.

## 3. Barrel

- [x] 3.1 `src/db/repositories/index.ts` re-exports every row type, status union, and repository class.
- [x] 3.2 Re-export the barrel from `src/db/index.ts`.

## 4. Tests

- [x] 4.1 `src/db/repositories/base.test.ts` (11 tests): generic CRUD over a `widgets` table — insert, findById, findMany (filter / order / limit / offset / empty), count, update (happy / empty-patch / unknown-key / missing-row), default-softDelete-throws, transaction (commit / rollback-on-throw).
- [x] 4.2 `src/db/repositories/integration.test.ts` (14 tests): every concrete repository's softDelete branch (5 throw-cases + 3 lifecycle flip-cases) + `getNextTurnIndex` + `findExpiredPending` + `incrementWrite` atomic upsert + multi-counter independence + `ReextractJobsRepository.increment`.

## 5. Integration

- [x] 5.1 Run `npm run typecheck` → clean.
- [x] 5.2 Run `npm test` → all tests pass (95 total).
