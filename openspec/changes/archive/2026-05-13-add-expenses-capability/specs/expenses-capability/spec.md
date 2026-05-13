## ADDED Requirements

### Requirement: `expenses` business table satisfies every AGENTS.md business-row contract

The system SHALL ship a capability `expenses/v1/` whose `migrations/001_init.sql` creates an `expenses` table with:

- The AGENTS.md-mandated columns (`id`, `raw_event_id NOT NULL REFERENCES raw_events(id)`, `extraction_version NOT NULL DEFAULT 1`, `extraction_confidence REAL`, `occurred_at TEXT NOT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`).
- Domain columns: `amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0)`, `currency TEXT NOT NULL DEFAULT 'CNY'`, `merchant TEXT`, `category TEXT` with `CHECK (category IS NULL OR category IN ('dining','transport','groceries','entertainment','service','health','other'))`.
- `CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1))`.
- Two indexes: `idx_expenses_occurred ON expenses(occurred_at)` and `idx_expenses_category ON expenses(category)`.

#### Scenario: Migration applies cleanly to a fresh DB

- **WHEN** `applyCapabilityMigrations(db, 'expenses', '<expenses/v1/migrations>')` runs against a freshly migrated system DB
- **THEN** the `expenses` table exists, both indexes exist, and a subsequent `SELECT * FROM expenses` returns 0 rows

#### Scenario: Inserting a negative `amount_minor` is rejected

- **WHEN** an `INSERT INTO expenses (..., amount_minor, ...) VALUES (..., -100, ...)` is attempted
- **THEN** SQLite raises a CHECK constraint failure

#### Scenario: An unknown `category` value is rejected

- **WHEN** an `INSERT INTO expenses` with `category='nightlife'` is attempted (not in the enum)
- **THEN** SQLite raises a CHECK constraint failure

### Requirement: The `expenses` pipeline parses, resolves `occurred_at`, and inserts one row

The system SHALL ship `src/capabilities/expenses/v1/pipeline.ts` exporting `ingest(rawEvent, deps): Promise<{ business_row_id, business_table: 'expenses' }>` that:

1. Parses `rawEvent.extracted_data` with a Zod schema requiring `amount_minor: integer >= 0`, allowing optional `currency` (default `'CNY'`), `merchant`, `category`, `occurred_at`.
2. Resolves the final `occurred_at` in priority order: `rawEvent.event_occurred_at` → `parsed.occurred_at` → `rawEvent.created_at`.
3. INSERTs the row using `deps.db.prepare(...).run(...)` (no nested transaction — `runPipeline` already wraps the call).
4. Returns `{ business_row_id: row.id, business_table: 'expenses' }`.

A Zod parse failure MUST throw — `runPipeline` will catch it and `runPipelineForEvent` will return `{ capability_written: false }` while logging the failure.

#### Scenario: Happy path inserts an expenses row

- **WHEN** `ingest` runs against a `rawEvent` whose `extracted_data = '{"amount_minor":4500,"currency":"CNY","merchant":"Blue Bottle","category":"dining"}'` and `event_occurred_at='2026-05-13T09:00:00+08:00'`
- **THEN** an `expenses` row exists with the same `amount_minor`, `currency`, `merchant`, `category`, and `occurred_at='2026-05-13T09:00:00+08:00'`; the result's `business_row_id` matches the inserted row's id

#### Scenario: occurred_at falls back to extracted.occurred_at when rawEvent.event_occurred_at is null

- **WHEN** `rawEvent.event_occurred_at = null` and `extracted_data.occurred_at = '2026-05-12T12:00:00+08:00'`
- **THEN** the inserted row's `occurred_at = '2026-05-12T12:00:00+08:00'`

#### Scenario: occurred_at falls back to created_at when nothing else is set

- **WHEN** neither `rawEvent.event_occurred_at` nor `extracted_data.occurred_at` is set
- **THEN** the inserted row's `occurred_at` equals `rawEvent.created_at`

#### Scenario: Pipeline rejects missing `amount_minor`

- **WHEN** `extracted_data = '{"merchant":"x"}'` (no `amount_minor`)
- **THEN** `ingest` throws a `ZodError` and no row is inserted

#### Scenario: Pipeline rejects negative `amount_minor`

- **WHEN** `extracted_data = '{"amount_minor":-50}'`
- **THEN** `ingest` throws a `ZodError` and no row is inserted

### Requirement: The `expenses` extract prompt instructs the agent on the JSON schema

The system SHALL ship `src/capabilities/expenses/v1/extract_prompt.md` containing:

- The JSON schema description (fields, types).
- At least 3 worked examples (positive cases with ¥ notation, $ notation, missing merchant).
- A bold-emphasised reminder that `amount_minor` is in MINOR units (CNY fen / USD cents / ...).
- A note that `currency` defaults to `CNY` when omitted.

#### Scenario: Extract prompt has the worked examples

- **WHEN** the file is read
- **THEN** the body contains both `'¥'` and `'$'` somewhere in worked-example blocks, and the phrase `'minor'` appears at least once in bold

### Requirement: `meta.json` is loadable and registered as `'expenses'`

The capability's `meta.json` MUST validate against `CapabilityMetaSchema` and register under name `'expenses'`. After `bootRuntime`, the runtime's `capabilities` map MUST contain `'expenses'` with `meta.primary_table === 'expenses'` and `meta.ingest_event_types` containing `'consumption'`.

#### Scenario: Booting the runtime loads the expenses capability

- **WHEN** `bootRuntime(api)` runs against a fresh DB in a tmp HOME
- **THEN** `runtime.capabilities.has('expenses') === true` and `runtime.capabilities.get('expenses')!.meta.primary_table === 'expenses'`
