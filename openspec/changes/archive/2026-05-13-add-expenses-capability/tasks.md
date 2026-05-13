## 1. meta.json

- [x] 1.1 Create `src/capabilities/expenses/v1/meta.json` with the AGENTS.md-mandated shape: `name`, `version`, `description`, `primary_table`, `depends_on_capabilities`, `ingest_event_types: ['consumption']`, `owner_pipeline: 'pipeline.ts'`, `exposed_skills: []`.

## 2. Migration

- [x] 2.1 Create `src/capabilities/expenses/v1/migrations/001_init.sql` with the `expenses` table:
  - Required fields: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `raw_event_id INTEGER NOT NULL REFERENCES raw_events(id)`, `extraction_version INTEGER NOT NULL DEFAULT 1`, `extraction_confidence REAL`, `occurred_at TEXT NOT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
  - Domain fields: `amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0)`, `currency TEXT NOT NULL DEFAULT 'CNY'`, `merchant TEXT`, `category TEXT CHECK (category IS NULL OR category IN ('dining','transport','groceries','entertainment','service','health','other'))`.
  - CHECK on `extraction_confidence` (0–1 or NULL).
  - Indexes: `idx_expenses_occurred ON expenses(occurred_at)`, `idx_expenses_category ON expenses(category)`.

## 3. Pipeline

- [x] 3.1 Create `src/capabilities/expenses/v1/pipeline.ts` exporting `ingest(rawEvent, deps): Promise<PipelineIngestResult>`:
  - Zod schema for `extracted_data`: `{ amount_minor: z.number().int().nonnegative(), currency: z.string().default('CNY'), merchant: z.string().optional(), category: z.enum([...]).optional(), occurred_at: z.string().optional() }`.
  - Resolve `occurred_at` per D3 (event_occurred_at > extracted.occurred_at > created_at).
  - INSERT one `expenses` row with all fields populated; return `{ business_row_id, business_table: 'expenses' }`.
  - Document at the top of the file: "Do NOT wrap writes in a transaction; the runner does that."

## 4. Extract prompt

- [x] 4.1 Create `src/capabilities/expenses/v1/extract_prompt.md`:
  - Title + 1-paragraph description ("You are extracting consumption data...").
  - JSON schema with field types.
  - 3 worked examples covering: CNY in `¥` notation, USD in `$` notation, missing merchant.
  - Money-units-are-minor rule called out in bold.

## 5. Capability tests

- [x] 5.1 Create `src/capabilities/expenses/v1/tests/pipeline.test.ts`:
  - `beforeEach`: open a tmp DB, apply system migrations + the capability migration, insert a messages row + raw_events row.
  - Happy path: `ingest` returns a `business_row_id`, the row exists with correct fields, `amount_minor` is integer, `occurred_at` is set.
  - 3 positive cases: minimal payload (amount only), full payload (all fields), `occurred_at` resolution falling back to `created_at`.
  - Schema rejection: negative `amount_minor` throws.
  - Schema rejection: missing `amount_minor` throws.
  - Category enum: pipeline writes `null` for unknown category (the schema accepts `optional` only — unknown enum values reject).
  - FK enforcement: inserting with `raw_event_id` referencing a missing raw_event throws.

## 6. Runtime test update

- [x] 6.1 Modify `src/runtime.test.ts`:
  - The "fresh DB" test now asserts `runtime.capabilities.has('expenses') === true` and `runtime.capabilities.get('expenses')!.meta.primary_table === 'expenses'`.
  - The `messagesRepo.count()` assertion stays at 0.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` — all tests pass.
- [x] 7.3 `openspec validate add-expenses-capability --strict`.
