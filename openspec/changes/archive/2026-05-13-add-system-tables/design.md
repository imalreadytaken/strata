## Context

`STRATA_SPEC.md` §3.1 specifies the exact DDL for eight system tables. This change ports that DDL verbatim into `src/db/migrations/`, one file per table (plus the FTS5 virtual table and its triggers, which live in the `messages` migration because they shadow that table's content). It also exports a `SYSTEM_MIGRATIONS_DIR` constant resolved relative to `import.meta.url` so the migration runner is callable without the caller having to know the on-disk path.

## Goals / Non-Goals

**Goals:**

- The DDL on disk MUST match the spec. Any deviation requires a written justification in this design.
- A single integration test applies all eight migrations to a fresh DB and asserts each table exists; targeted tests cover every CHECK constraint mentioned in the requirements.
- `SYSTEM_MIGRATIONS_DIR` resolves correctly when imported from inside the `strata` package and from outside (tests).

**Non-Goals:**

- No business tables. They are emitted per-capability at runtime; the spec is explicit (§3.2).
- No DML / seed data.
- No example schema-evolution migration.
- No repository implementations.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/db/migrations/001_messages.sql` | new | `messages` + indexes + `messages_fts` + triggers |
| `src/db/migrations/002_raw_events.sql` | new | `raw_events` + 5 indexes |
| `src/db/migrations/003_capability_registry.sql` | new | `capability_registry` + status index |
| `src/db/migrations/004_schema_evolutions.sql` | new | `schema_evolutions` + capability index |
| `src/db/migrations/005_reextract_jobs.sql` | new | `reextract_jobs` + status index |
| `src/db/migrations/006_builds.sql` | new | `builds` + phase + session indexes |
| `src/db/migrations/007_proposals.sql` | new | `proposals` + status + partial capability index |
| `src/db/migrations/008_capability_health.sql` | new | `capability_health` (PK by name) |
| `src/db/index.ts` | modified | Add `SYSTEM_MIGRATIONS_DIR` export |
| `src/db/migrations/system-tables.test.ts` | new | Full apply + every CHECK + FTS5 trigger + FK enforcement |

## Decisions

### D1 — DDL essentially verbatim from §3.1, with one documented bug fix (see D6)

We copy the spec's CREATE TABLE / CREATE INDEX / CREATE TRIGGER blocks unchanged (including `IF NOT EXISTS` only where the spec uses it) **except** for the FTS5 update trigger described in D6 below. Reason: this layer's value is being the literal contract, not adding cleverness — but a copy-paste of a broken trigger is worse than a documented fix. The only formatting allowed elsewhere is whitespace.

### D2 — One file per table

The Strata spec implies this (§4.2 lists eight migration filenames). Splitting also makes the `_strata_migrations` ledger more informative: re-running prints which files are new vs skipped.

### D3 — FTS5 virtual table + triggers live with `messages` migration

`messages_fts` is content-tied to `messages`. Splitting them across files would require migration `002` to read `messages_fts` settings created by `001` — not wrong, but offers no value over keeping them together.

### D4 — Forward FK references are fine in SQLite

`messages.raw_event_id REFERENCES raw_events(id)` is declared before `raw_events` is created. SQLite resolves FK reference targets lazily (at first INSERT/UPDATE), so the order does not matter as long as both tables exist by the time we insert data. We verify this in tests.

### D5 — Path resolution via `import.meta.url`

`SYSTEM_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations')`. At test time (`vitest` runs `.ts` directly), this resolves under `src/db/`. After `tsc --build`, the same expression resolves under `dist/db/`. We will add a `prebuild` step in a future change to copy `.sql` files alongside `.js`; for now, the tests cover both directions because they import from `src/db/`.

### D6 — FTS5 update trigger uses delete-then-insert (corrects a bug in §3.1)

The spec at §3.1 contains:

```sql
CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  UPDATE messages_fts SET content = new.content WHERE rowid = new.id;
END;
```

This is incorrect for external-content FTS5 (`content='messages', content_rowid='id'`): the FTS5 table does not store the content itself, so issuing an `UPDATE messages_fts SET content = ...` corrupts the internal `%_data` shadow ("database disk image is malformed" on the next read). The documented FTS5 pattern (sqlite.org/fts5.html §4.4.2) is:

```sql
INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
```

We use this correct form, and add a symmetric `messages_fts_delete` trigger which the spec omits (without it, deleted message rows leave dangling FTS index entries). A test asserts content edits propagate correctly. This is a deliberate spec deviation, surfaced in the migration file's comment and discoverable via the `messages_fts_update` trigger body.

## Risks / Trade-offs

- **`.sql` files not copied to `dist/` by `tsc`**: known limitation. Mitigation: keep using `tsx` / `vitest` (no compiled `dist/` consumed at runtime) until a packaging story matters. Will be addressed when we first package the plugin (`P7-release`).
- **Spec drift**: if `STRATA_SPEC.md` §3.1 is edited after this change is archived, the on-disk DDL no longer matches the spec. Mitigation: the spec is now a docs document and `openspec/AGENTS.md` is the runtime contract; this change's `specs/system-tables/spec.md` becomes the new source of truth.
- **CHECK constraint coverage drift**: if a future migration `ALTER TABLE`s to widen an enum, the original `001_*.sql` checksum still validates but the operational schema differs from what 001 declares. This is the intended Strata workflow (immutable forward migrations + `schema_evolutions` ledger). We accept the divergence; it is documented at the field level in `schema_evolutions.diff`.
