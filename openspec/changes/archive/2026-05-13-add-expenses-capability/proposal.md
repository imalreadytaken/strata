## Why

The loader + pipeline runner are mechanical; we have not yet proved they hold up against a real capability. `add-expenses-capability` is the **vertical slice that closes the loop**: a user message ("今天买了 Blue Bottle 拿铁 ¥45") flows through Telegram → `messages` → capture skill → `strata_create_pending_event` → `pending` row → user confirms → `strata_commit_event` → expenses pipeline → `expenses` business table.

This is also the validation step for `openspec/AGENTS.md`: the meta.json schema, the business-table required fields, and the money-as-INTEGER-minor-units constraint are tested against an actual capability for the first time. If AGENTS.md is wrong about anything, this change will surface it before Build Bridge produces capabilities Claude-Code-style.

References: `STRATA_SPEC.md` §9 Week 3 ("Manual `expenses` capability"), §3.2 (business-table contract), `openspec/AGENTS.md` (capability layout + field naming conventions).

## What Changes

- Add `expenses-capability` covering the `expenses/v1/` directory:
  - **`meta.json`** — declares `name='expenses'`, `version=1`, `primary_table='expenses'`, `ingest_event_types=['consumption']`, plus the AGENTS.md-mandated metadata.
  - **`migrations/001_init.sql`** — creates the `expenses` business table with every required field from AGENTS.md (`id`, `raw_event_id` FK, `extraction_version`, `extraction_confidence`, `occurred_at`, `created_at`, `updated_at`) plus expenses-specific fields (`amount_minor` INTEGER, `currency` TEXT default `'CNY'`, `merchant` TEXT, `category` TEXT with CHECK enum). Two indexes (`occurred_at`, `category`).
  - **`pipeline.ts`** — `async function ingest(rawEvent, deps)` that parses `rawEvent.extracted_data` against a Zod schema, resolves `occurred_at` (event time > extracted time > created_at), INSERTs one `expenses` row, returns `{ business_row_id, business_table: 'expenses' }`.
  - **`extract_prompt.md`** — the LLM prompt the agent uses to turn a consumption message into structured `extracted_data`. Includes worked examples and the money-units-are-minor rule.
  - **`tests/pipeline.test.ts`** — capability-level tests: clean migration apply, three positive-extraction cases, schema rejection of negative amounts, FK constraint enforcement.
- **Runtime-test update**: `src/runtime.test.ts` now expects `runtime.capabilities` to contain `expenses` (the bundled root now has one capability).

## Capabilities

### New Capabilities
- `expenses-capability`: the `expenses` business table + ingest pipeline + extract prompt; first vertical slice through the loader + pipeline runner.

### Modified Capabilities
*(none — uses `capability-loader` + `pipeline-runner` without changing either)*

## Impact

- **Files added**:
  - `src/capabilities/expenses/v1/meta.json`
  - `src/capabilities/expenses/v1/migrations/001_init.sql`
  - `src/capabilities/expenses/v1/pipeline.ts`
  - `src/capabilities/expenses/v1/extract_prompt.md`
  - `src/capabilities/expenses/v1/tests/pipeline.test.ts`
- **Files modified**:
  - `src/runtime.test.ts` — the "fresh DB has an empty capabilities map" assertion becomes "fresh DB has `expenses` loaded from the bundled root".
- **Non-goals**:
  - No category auto-classification — that's the agent's responsibility (the extract_prompt has the enum; the pipeline just persists what it gets).
  - No dashboard widgets, no cron jobs, no `expenses_*` aggregate tables.
  - No agent skill (`src/capabilities/expenses/v1/skill/SKILL.md`) — the existing capture SKILL.md already routes consumption messages here via `capability_name='expenses'`. A dedicated expenses query skill lands with the global query skill in P6.
  - No re-extraction logic — that's a P6 concern. Schema is V1; later schema evolution will happen via a new migration + reextract job.
