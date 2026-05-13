## Why

`add-db-foundation` defined a `Repository<T>` contract; `add-system-tables` created the eight SQL tables; this change supplies the eight typed TypeScript classes that satisfy the contract for each table. After this lands, no Strata module outside `src/db/repositories/` should ever execute raw SQL — that's the AGENTS.md-implicit invariant that lets us swap SQLite for Postgres later (`STRATA_SPEC.md` §3.3).

References: `STRATA_SPEC.md` §3.3 (Repository abstraction), §3.1 (column lists), §5.3.1–§5.3.4 (call sites that already assume `rawEventsRepo.insert(...)`, `rawEventsRepo.update(...)`, etc.).

## What Changes

- Add `repositories` capability covering:
  - A generic `SQLiteRepository<T>` base class that satisfies `Repository<T>` for any table whose primary key is `id INTEGER`. Builds `INSERT` / `UPDATE` / `SELECT` SQL from a constructor-provided list of column names; returns typed rows. Methods are `Promise`-returning even though `better-sqlite3` is sync (D5 of `add-db-foundation`).
  - Eight per-table repository classes that bind the base to their `Row` type and column list, plus override `softDelete` with table-appropriate semantics:

    | Table                  | softDelete semantics                                       |
    |---|---|
    | `messages`             | throws — append-only (AGENTS.md hard constraint #1)        |
    | `raw_events`           | throws — append-only; use `supersedes_event_id` chain      |
    | `capability_registry`  | sets `status='archived'`, `archived_at = now`              |
    | `schema_evolutions`    | throws — append-only ledger                                |
    | `reextract_jobs`       | throws — state machine; use `update(id, { status: 'failed', last_error })` |
    | `builds`               | sets `phase='cancelled'`, `completed_at = now`             |
    | `proposals`            | sets `status='declined'`, `responded_at = now`             |
    | `capability_health`    | throws — counter table; no lifecycle                       |

  - Each repository also exposes one or two narrow helpers the spec's call sites already use (`messagesRepo.getNextTurnIndex(session_id)`, `rawEventsRepo.findExpiredPending(minutes)`, `capabilityHealthRepo.incrementWrite(name)`).

## Capabilities

### New Capabilities
- `repositories`: a generic SQLite repository base + eight typed implementations covering every system table.

### Modified Capabilities
*(none — uses `database-foundation` and `system-tables`)*

## Impact

- **Files added**: `src/db/repositories/{base,messages,raw_events,capability_registry,schema_evolutions,reextract_jobs,builds,proposals,capability_health,index}.ts` + co-located `*.test.ts`
- **Dependencies**: none new
- **Public surface**: each repository class is exported from `src/db/repositories/index.ts`. The plugin entry will wire singletons later (P2).
- **Non-goals**: no business-table repositories (those are emitted per-capability); no embedding-aware query helpers (`search_events` lives in tools and queries through the repository); no Postgres adapter; no automatic JSON column parsing — TEXT-stored JSON columns stay as strings, callers `JSON.parse` themselves (matches `STRATA_SPEC.md` §5.3 call-site idiom).
