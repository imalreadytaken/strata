# repositories Specification

## Purpose

`repositories` ships the eight typed data-access classes Strata's hooks, tools, and background workers use to talk to the system tables. A generic `SQLiteRepository<T, ID>` base implements `Repository<T, ID>` over any table — parameterised `WHERE`, `RETURNING *` on INSERT/UPDATE, manual `BEGIN`/`COMMIT`/`ROLLBACK` so transactions survive `await` boundaries. The eight concrete subclasses bind their `Row` type, declare table-appropriate `softDelete` semantics (lifecycle tables flip a status column; append-only tables throw `StateMachineError`), and expose the few extra helpers the spec already names (`getNextTurnIndex`, `findExpiredPending`, `incrementWrite`, etc.). After this lands, no Strata module outside `src/db/` should execute raw SQL — the AGENTS.md-implicit invariant that keeps a future Postgres adapter possible.

## Requirements
### Requirement: SQLiteRepository<T> base class implements the Repository<T> contract over a single table

The system SHALL ship a `SQLiteRepository<T extends { id: number }>` class that, given a `Database`, a table name, and a list of non-id column names, satisfies every method of `Repository<T>`.

- `findById(id)` SHALL run `SELECT * FROM <table> WHERE id = ? LIMIT 1`.
- `findMany(filter, options)` SHALL build a parameterised `WHERE` from `filter` (each key becomes `col = ?`), apply `ORDER BY <col> <dir>` when `orderBy` is provided, and apply `LIMIT` / `OFFSET` when set. Empty `filter` returns all rows.
- `count(filter)` SHALL run `SELECT COUNT(*) AS c FROM <table>` with the same WHERE shape.
- `insert(data)` SHALL build `INSERT INTO <table> (col1, ...) VALUES (?, ...) RETURNING *` using only the configured columns; rows returned by the driver are the inserted row.
- `update(id, patch)` SHALL build `UPDATE <table> SET col1 = ?, ... WHERE id = ? RETURNING *`. An empty patch SHALL return the existing row without issuing an UPDATE.
- `softDelete(id)` SHALL throw `StateMachineError('STRATA_E_STATE_TRANSITION', ...)` in the base class — concrete subclasses override.
- `transaction(fn)` SHALL run `db.transaction(...)` wrapping a `Promise.resolve(fn())`.

The base class SHALL ignore patch keys that are not in the configured column list — accidental typos fail loudly (an explicit throw) rather than silently writing garbage. Empty filters MUST be handled without producing `WHERE 1=1` artifacts.

#### Scenario: Round-trips an inserted row

- **WHEN** a repository over a test table with columns `(name, status)` is constructed and `insert({ name: 'x', status: 'active' })` is called
- **THEN** the call resolves with a row whose `id` is positive and whose other fields match the input

#### Scenario: findMany applies filter, ordering, and limit

- **WHEN** three rows with mixed `status` are inserted and `findMany({ status: 'active' }, { orderBy: 'name', direction: 'desc', limit: 2 })` is called
- **THEN** only `active` rows are returned, in descending name order, with at most two results

#### Scenario: Update rejects unknown patch keys

- **WHEN** `update(id, { nonexistent_column: 'x' })` is called
- **THEN** the call rejects with `ValidationError` whose code is `STRATA_E_VALIDATION`

#### Scenario: softDelete on the base class throws

- **WHEN** the base class's `softDelete(id)` is called directly
- **THEN** the call rejects with `StateMachineError` whose code is `STRATA_E_STATE_TRANSITION`

### Requirement: Eight per-table repository classes

The system SHALL expose one repository class per system table:

- `MessagesRepository`
- `RawEventsRepository`
- `CapabilityRegistryRepository`
- `SchemaEvolutionsRepository`
- `ReextractJobsRepository`
- `BuildsRepository`
- `ProposalsRepository`
- `CapabilityHealthRepository`

Each class SHALL:

1. Declare a `Row` type matching the columns of its SQL table.
2. Extend `SQLiteRepository<Row>` and bind the constructor table name + column list.
3. Override `softDelete` according to the table's lifecycle semantics (see the proposal's table). Repositories whose backing table is append-only MUST throw `StateMachineError`. Repositories whose backing table has a status column MUST flip it to the documented value and stamp the relevant timestamp.

#### Scenario: capability_registry softDelete sets status and archived_at

- **WHEN** a capability_registry row with `status='active'` is softDeleted
- **THEN** the row's `status` becomes `'archived'`, `archived_at` is a non-null ISO timestamp, and `findById` returns the updated row

#### Scenario: messages softDelete throws

- **WHEN** a messages row is softDeleted
- **THEN** the call rejects with `StateMachineError` whose `code === 'STRATA_E_STATE_TRANSITION'` and whose message identifies the messages table

### Requirement: Repository-specific helper methods

The repositories SHALL expose the helper methods already named by `STRATA_SPEC.md` §5:

- `MessagesRepository.getNextTurnIndex(session_id: string): Promise<number>` — returns `(MAX(turn_index) OR -1) + 1` for the session, so the first message in a session gets `turn_index = 0`.
- `MessagesRepository.updateEmbedding(id: number, embedding: Float32Array): Promise<void>` — convenience for the async embedding worker.
- `RawEventsRepository.findExpiredPending(timeoutMinutes: number): Promise<RawEventRow[]>` — returns `pending` rows whose `created_at` is older than `now - timeout`.
- `CapabilityHealthRepository.incrementWrite(name: string): Promise<void>` — atomically `total_writes = total_writes + 1`, sets `last_write_at = now`, `updated_at = now`. Upserts when the row does not yet exist.
- `CapabilityHealthRepository.incrementRead(name: string): Promise<void>` — symmetric to `incrementWrite`.

#### Scenario: getNextTurnIndex returns the right monotone value

- **WHEN** a session has three messages with `turn_index` 0, 1, 2 and `getNextTurnIndex('that-session')` is called
- **THEN** the call resolves with `3`

#### Scenario: findExpiredPending picks up the right rows

- **WHEN** the table has two `pending` rows — one created 5 minutes ago and one 35 minutes ago — and `findExpiredPending(30)` is called
- **THEN** only the 35-minute row is returned

