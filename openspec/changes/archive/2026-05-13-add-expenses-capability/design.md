## Context

This is the first time anyone has had to take `openspec/AGENTS.md`'s capability rules at face value. The constitution says:

- `<capability>/<entity_plural>` for business-table names → `expenses`.
- INTEGER minor units for money.
- ISO 8601 with timezone for time.
- Required fields on every business row: `id`, `raw_event_id`, `extraction_version`, `extraction_confidence`, `occurred_at`, `created_at`, `updated_at`.
- Enum fields as `<name>_kind TEXT` + CHECK constraint.

We follow every rule, and the change's tests are written to fail if any rule is later relaxed in this capability.

The migration runs through `applyCapabilityMigrations(db, 'expenses', dir)` which the previous change introduced. The pipeline lives at `pipeline.ts` and is dynamically imported by `runPipeline` at commit time.

## Goals / Non-Goals

**Goals:**
- Schema satisfies every AGENTS.md hard constraint that applies to business tables (#2–#4: money, time, required fields).
- Pipeline parses the raw event's `extracted_data` with a Zod schema; rejects malformed payloads with a helpful error that surfaces back through `runPipeline → STRATA_E_PIPELINE_FAILED`.
- `extract_prompt.md` is short, worked-example-heavy, and self-contained — agent authors should be able to read it once and produce correct `extracted_data`.
- Capability-level tests stand alone — they don't import the loader or runner; they `applyMigrations` then call `ingest` directly. That keeps `expenses` test latency low and the failure mode localised.

**Non-Goals:**
- No money currency conversion. Pipeline trusts the agent's currency. A future capability or proposal could add a normalisation pass.
- No fuzzy matching across messages. One raw_event → one expenses row; consolidation across "买完咖啡 + 早餐" multi-line entries is a P5 concern.
- No income / refunds. `amount_minor` is `>= 0`. Income, refunds, and credits live in a future `transfers` or `income` capability.
- No tagging / labels. `category` is a fixed enum; free-text tags can land later.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/capabilities/expenses/v1/meta.json` | new | Capability manifest. |
| `src/capabilities/expenses/v1/migrations/001_init.sql` | new | DDL for `expenses` business table + two indexes. |
| `src/capabilities/expenses/v1/pipeline.ts` | new | `ingest(rawEvent, deps)` — Zod-validates `extracted_data`, inserts one `expenses` row, returns `{ business_row_id, business_table }`. |
| `src/capabilities/expenses/v1/extract_prompt.md` | new | LLM prompt + 3 worked examples. |
| `src/capabilities/expenses/v1/tests/pipeline.test.ts` | new | Schema/pipeline tests. |
| `src/runtime.test.ts` | modified | Adjusts the "capabilities map" assertion to expect `expenses`. |

## Decisions

### D1 — `category` is an enum + free-text fallback (`other`)

The fixed enum is `dining | transport | groceries | entertainment | service | health | other`. We could permit free-text, but the Reflect agent wants stable buckets to spot patterns. New buckets can be added by a `002_add_<category>.sql` migration; the agent's extract prompt will follow.

### D2 — `currency` defaults to `'CNY'`, accepts any 3-letter code

The user's primary currency is CNY (per the project's research background); the field is still `TEXT` so multi-currency users can have `USD` / `EUR` rows. The pipeline does not normalise — every report query has to be currency-aware.

### D3 — `occurred_at` resolution order: rawEvent.event_occurred_at > extracted_data.occurred_at > rawEvent.created_at

`event_occurred_at` on the raw_event is what the agent decided at capture time. `extracted_data.occurred_at` is the agent's secondary preference (some prompts will only populate one or the other). The created_at fallback is a last resort so `NOT NULL occurred_at` is always satisfied — never a fabricated value, always one the user could trace back.

### D4 — Pipeline is `.ts` not `.mjs`

The rest of the codebase is TypeScript; the bundled root is the plugin's `src/`. Vitest's vite loader handles `.ts` at runtime. Production loading is a separate operational concern (Node ≥ 22's `--experimental-strip-types` works for plain annotations like the ones we use here; alternatives like `tsx` or pre-compilation are also viable). We do NOT block this change on the production-runtime question — the dev/test loop closes today.

### D5 — Pipeline does NOT INSERT inside its own transaction

`runPipeline` already wraps the call in `BEGIN`/`COMMIT`/`ROLLBACK`. A nested `db.transaction(...)` inside the pipeline body would fail at runtime (SQLite refuses nested transactions). Pipelines should make plain `db.prepare(...).run(...)` calls and trust the wrapper. We add a comment to `pipeline.ts` to that effect.

### D6 — Zod parse failures surface through `STRATA_E_PIPELINE_FAILED`

A malformed `extracted_data` (missing `amount_minor`, etc.) throws a `ZodError` from inside `ingest`. `runPipeline` catches that, wraps as `STRATA_E_PIPELINE_FAILED`, and `runPipelineForEvent` swallows the throw and logs at `error`. From the user's perspective, the commit succeeds and the `business_row_id` is null. Operators will see the `error` log with the ZodError detail in `cause`.

## Risks / Trade-offs

- **A poorly-extracted message commits without a business row.** Mitigation: the agent's confidence assessment should keep confidence high when extraction is clean. A re-extraction worker (P6) will sweep `committed` events whose `business_row_id IS NULL` for the bound capability.
- **Migration is immutable; schema evolution requires a new migration.** Accepted. The `002_add_subcategory.sql` pattern in AGENTS.md is exactly how this stays sane.
- **No multi-currency normalisation.** Documented in D2. A `currency_rates` capability can sit on top.
