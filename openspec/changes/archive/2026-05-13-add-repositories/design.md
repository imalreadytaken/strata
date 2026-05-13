## Context

The previous two changes set up the contract (`Repository<T>`) and the storage (eight SQL tables). This change wires them together with eight typed implementations. The non-trivial design question is how much SQL string-building lives in a shared base and how much is per-table.

## Goals / Non-Goals

**Goals:**

- A single `SQLiteRepository<T>` base does the boring CRUD via parameterised SQL.
- Eight typed subclasses give callers a strongly-typed surface (`messagesRepo.findById(...)` returns `MessageRow | null`).
- Per-table soft-delete semantics are explicit, not inferred — append-only tables throw a `StateMachineError` rather than no-op.
- Helper methods named by the spec (`getNextTurnIndex`, `findExpiredPending`, `incrementWrite`) land on the matching class, not as free-standing functions.
- 100 % `npm run typecheck` + tests covering every CRUD path and every soft-delete branch.

**Non-Goals:**

- No JSON-aware accessors. TEXT columns that contain JSON (e.g. `raw_events.extracted_data`) stay as strings; callers `JSON.parse` themselves. This matches the spec snippets in §5.3 (`JSON.parse(current.extracted_data)`).
- No automatic `updated_at` injection. Callers set timestamps explicitly — keeps the repository pure and matches the spec idiom.
- No business-table repositories. They are emitted per-capability at runtime.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/db/repositories/base.ts` | new | `SQLiteRepository<T>` — CRUD via prepared statements, `RETURNING *` |
| `src/db/repositories/messages.ts` | new | `MessageRow` + `MessagesRepository` (+ `getNextTurnIndex`, `updateEmbedding`) |
| `src/db/repositories/raw_events.ts` | new | `RawEventRow` + `RawEventsRepository` (+ `findExpiredPending`) |
| `src/db/repositories/capability_registry.ts` | new | `CapabilityRegistryRow` + class (softDelete → archived) |
| `src/db/repositories/schema_evolutions.ts` | new | `SchemaEvolutionRow` + class (softDelete throws) |
| `src/db/repositories/reextract_jobs.ts` | new | `ReextractJobRow` + class (softDelete throws) |
| `src/db/repositories/builds.ts` | new | `BuildRow` + class (softDelete → cancelled) |
| `src/db/repositories/proposals.ts` | new | `ProposalRow` + class (softDelete → declined) |
| `src/db/repositories/capability_health.ts` | new | `CapabilityHealthRow` + class (+ `incrementWrite` / `incrementRead`) |
| `src/db/repositories/index.ts` | new | Barrel re-exports |
| `src/db/repositories/base.test.ts` | new | All `SQLiteRepository` behaviour over a throwaway `widgets` table |
| `src/db/repositories/integration.test.ts` | new | Per-table softDelete branch, helper methods, FK chains |

## Decisions

### D1 — `RETURNING *` over a follow-up `SELECT`

SQLite supports `INSERT ... RETURNING *` and `UPDATE ... RETURNING *`. Using it saves one round trip and avoids a race where another transaction updates the row between INSERT and SELECT (better-sqlite3 is single-process but still good hygiene).

### D2 — Patch keys filtered, not silently ignored

If a caller writes `repo.update(id, { extraction_versoin: 2 })` (typo), we want to know. `update()` throws `ValidationError('STRATA_E_VALIDATION', 'unknown column ...')` when any patch key is outside the constructor-declared column list. Silent-ignore is the wrong default — accidental missing fields would never persist.

### D3 — `softDelete` is required, even when it throws

Concrete softDelete-throwing implementations beat optional methods at runtime: a caller that mistakenly tries to soft-delete an append-only row gets a clear `StateMachineError` at runtime, not a `cannot find function 'softDelete' of undefined`. The interface stays uniform.

### D4 — Helper methods on the concrete class, not the base

`getNextTurnIndex` only makes sense on messages; `findExpiredPending` only on raw_events. Putting them on the base would force a `K extends 'messages' | 'raw_events' | ...` discrimination. Easier: declare them as instance methods on the specific class, and let `MessagesRepository extends SQLiteRepository<MessageRow>` simply add the extra surface.

### D5 — Soft-delete timestamps come from the caller, mostly

For consistency with the rest of the codebase, repository constructors take an optional `now: () => string` injection (default: `() => new Date().toISOString()`). Tests pass a fake `now` to assert exact timestamps. The same injection is used by `softDelete` overrides that need to stamp `archived_at` / `completed_at` / `responded_at`.

### D6 — Repositories own a single `Database` handle each, by reference

The plugin entry will instantiate the repositories once at boot with the singleton DB. There is no pooling. Tests instantiate a temp DB per test and pass it to each repository. This means tests can run in parallel.

### D7 — `CapabilityHealthRepository.incrementWrite` is atomic via `INSERT ... ON CONFLICT`

Without it, two concurrent commits racing the same capability could lose an increment. SQLite `INSERT ... ON CONFLICT(capability_name) DO UPDATE SET total_writes = total_writes + 1, ...` keeps the write atomic in a single statement.

## Risks / Trade-offs

- **`RETURNING *` was added to SQLite in 3.35**: shipped in 2021, predates everything we ship. Trivially available via `better-sqlite3`.
- **Column lists hand-maintained**: a new column added to a system table requires bumping the column list in the matching repository. Mitigation: a sanity test asserts every `CREATE TABLE`'s declared columns are a subset of the repository's `columns` array. (See base.test.ts.)
- **`softDelete throws`-default leaves the door open for forgetting an override**: if a future system table adds a status column and we forget to override softDelete, callers get the base StateMachineError. That's a safe default (no data corruption) but might surprise. Documented.
