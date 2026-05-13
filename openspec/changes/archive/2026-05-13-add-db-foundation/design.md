## Context

`STRATA_SPEC.md` §3.3 stipulates that every data access goes through a `Repository<T>` abstraction so SQLite can be swapped for Postgres later. Migrations live in per-capability folders (`capabilities/<name>/v<N>/migrations/`) plus a core folder (`src/db/migrations/`) for system tables. AGENTS.md hard constraint #5 forbids editing an already-applied migration.

This change introduces only the connection setup, the interface, and the runner — no concrete repository implementations and no actual SQL yet. Those land in `add-system-tables` and `add-repositories`.

## Goals / Non-Goals

**Goals:**

- Use `better-sqlite3` (sync). Wrap in `async` so the `Repository<T>` contract matches the spec snippet (§3.3) and future Postgres adapters work without changing call sites.
- Load `sqlite-vec` once at open time. Subsequent code can call `vec_version()`, `vec_distance_*`, etc.
- Apply only filenames matching `NNN_*.sql` (three-digit zero-padded prefix — AGENTS.md naming convention).
- Refuse to re-run an edited migration. Checksum mismatch is loud, not silent.
- Every code path covered by Vitest, using a `mkdtemp`-rooted on-disk SQLite file (sqlite-vec needs a real handle, so `:memory:` is fine but we use disk for realism).

**Non-Goals:**

- No `down`/rollback migrations. Going backwards is handled by issuing a new forward migration (immutable forward history). Mirrors what AGENTS.md prescribes.
- No introspection helpers (`db.tables()` etc.) — repositories don't need them.
- No automatic embedding generation. That's a `core-infrastructure` extension, deferred.
- No connection pooling. SQLite is single-writer; one handle is enough.
- No Postgres adapter. The interface is shaped to allow one, but adding one is out of scope.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/db/connection.ts` | new | `openDatabase()` — pragmas + sqlite-vec load + DatabaseError wrapping |
| `src/db/repository.ts` | new | `Repository<T>` interface + `FindManyOptions` type |
| `src/db/migrations.ts` | new | `applyMigrations(db, dir)` — ledger + checksum + per-file transaction |
| `src/db/index.ts` | new | Barrel re-exports |
| `src/db/connection.test.ts` | new | Pragma values, sqlite-vec load, error wrapping |
| `src/db/migrations.test.ts` | new | Apply / skip / mismatch / filename filter |
| `src/db/repository.test.ts` | new | Type-only test: a stub class implements the interface |

No source file outside `src/db/` is modified.

## Decisions

### D1 — `better-sqlite3` not the async `node:sqlite`

Node 22's built-in `node:sqlite` is async but still experimental and lacks `loadExtension`. `better-sqlite3` is sync, stable, supports extension loading (needed for `sqlite-vec`), and has a Zod-friendly typed wrapper ecosystem. The async cost we lose (event-loop friendliness under heavy load) is not relevant at personal-app volume. We wrap sync calls in `Promise.resolve(...)` to keep the `Repository<T>` API uniform.

### D2 — Checksum SHA-256, not content equality

Hashing decouples the ledger from arbitrary file size and avoids storing every migration body twice. SHA-256 is overkill for collision risk here but matches the broader Strata convention of using stable cryptographic hashes for any "did this thing change?" check.

### D3 — Per-file transaction, not whole-directory transaction

If migration 003 fails, migrations 001 and 002 should remain committed and visible — the ledger reflects what's actually applied. A single big transaction would force a rerun of work that's already correct. `better-sqlite3` `db.transaction(...)` is synchronous and trivial.

### D4 — Ledger table name `_strata_migrations`, not `_migrations`

The spec's system tables include `schema_evolutions` (different concept: tracks user-visible business-table schema changes for re-extraction). The leading `_strata_` underscore prefix makes clear this table is plugin-internal infrastructure, not part of any capability spec.

### D5 — Repository methods all return `Promise<T>` even though we're sync

Yes, there's some friction (you have to `await` a sync result). Reason: the spec's interface snippet explicitly returns `Promise<...>`; cross-DB swap is named as a future possibility; future async writers (e.g., a `node:sqlite` adapter on Node 24+) work without call-site changes. Cost is one microtask per call — negligible.

### D6 — `softDelete` instead of `delete` in the interface

The spec snippet calls it `delete` but the AGENTS.md hard constraint forbids actual deletes ("Delete any data … use soft delete via status field"). Renaming makes the semantic obvious and prevents implementations from being tempted to issue `DELETE FROM`. Concrete implementations decide which column flips (e.g., `status = 'archived'` for capability_registry, `status = 'abandoned'` for raw_events).

## Risks / Trade-offs

- **`sqlite-vec` binary availability**: the npm package ships prebuilt binaries for common platforms. If a user is on a platform without one (uncommon Linux libc, etc.), open will fail with a clear error rather than partially work — that's caught by D1's `loadExtension` call inside `openDatabase`. Documented in the `loadVec: false` escape hatch.
- **Sync wrapped in async**: tooling like async stack traces will be slightly less informative across the wrap. We choose contract uniformity over trace fidelity.
- **Migration filename collision**: two migrations starting with the same `NNN_` prefix would both apply (lexicographic order is stable). We don't actively detect this; the convention is "next sequence number, no duplicates." If dogfood proves this is a foot-gun, P7 can add a duplicate-prefix check.
- **No down migrations**: backing out a botched migration requires writing a forward fix. This matches Strata's philosophy (raw_events are append-only, schema is append-only) and avoids a category of "we ran down accidentally in prod" disasters.
