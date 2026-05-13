## Context

Two strategies that share 80% of their machinery. The split point is the **input text source**:

- `reextract_raw_events` — read `raw_events.source_summary` + `extracted_data` (already extracted, just one field missing).
- `reextract_messages` — read `messages.content` for the raw event's `primary_message_id` + `related_message_ids` (full conversational context).

Everything else (prompt rendering, LLM call, JSON parse, per-row write) lives in `llm_shared.ts`.

## Goals / Non-Goals

**Goals:**
- One LLM call per row. No batching, no retries — let the worker's per-row try/catch own that.
- Diff schema names the target column and supplies a per-evolution extract prompt. Each row's context fills in via a `{{context}}` placeholder.
- Confidence thresholds are per-evolution overrideable.
- The shared helper is testable with a stubbed `LLMClient` — no real network.

**Non-Goals:**
- No streaming. We use the synchronous `LLMClient.infer({ system, user }): Promise<string>` API.
- No prompt cache. Each row's user message differs; caching is at the model layer if at all.
- No fall-back to derive_existing on LLM failure. Each row is its own outcome.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/reextract/strategies/llm_shared.ts` | new | `runLlmReextract`, diff Zod schema, prompt renderers. |
| `src/reextract/strategies/reextract_raw_events.ts` | new | `reextractRawEventsStrategy` (5-line wrapper). |
| `src/reextract/strategies/reextract_messages.ts` | new | `reextractMessagesStrategy` (10-line wrapper that joins related messages). |
| Three `*.test.ts` files | new | Per-strategy + shared-helper. |
| `src/reextract/index.ts` | modified | Re-exports. |
| `src/index.ts` | modified | Register both strategies at boot. |

## Decisions

### D1 — Diff JSON shape `{ kind: 'llm_field', target_column, extract_prompt, confidence_threshold? }`

Prompt contains `{{context}}`; we substitute the row context before sending. Optional `confidence_threshold` defaults to 0.7. Unknown / malformed shape → `failed` outcome.

### D2 — Expected LLM response is `{ value: <primitive>, confidence: number }` JSON

We parse with `JSON.parse` + a small Zod schema. Anything else → `failed`. The strategy writes `value` as-is into the column (caller's prompt must constrain to the column's type — TEXT-only for V1).

### D3 — `reextract_messages` joins by `primary_message_id` + `related_message_ids`

JSON-parse `raw_events.related_message_ids` (always an array). `SELECT content FROM messages WHERE id IN (...) ORDER BY received_at ASC`. Concatenate with newlines for the prompt context.

### D4 — Cost reporting is best-effort

`StrategyOutcome.costCents` is set when `deps.costEstimator` is supplied. The runtime can pass an estimator based on `pi-ai`'s usage data; V1 plugin entry doesn't yet — strategies omit `costCents` when no estimator.

### D5 — Skip rows that already have the target column set

`SELECT <target_column> FROM <table> WHERE id = ?` first; if non-null → `skipped: 'already_set'`. Same idempotency guarantee as `derive_existing`.

## Risks / Trade-offs

- **Per-row LLM cost** — at 100 rows × a few cents = single-digit dollars per backfill. The estimated_cost_cents column on the job + the worker's actual accumulator make this auditable.
- **Hallucinated `value`** — if the LLM is confident but wrong, the user gets a low-quality backfill. The `low_confidence` band is the explicit hedge; row gets written with a `rows_low_confidence++` marker so the user can review.
- **No prompt versioning yet** — a future change can store the rendered prompt template + model name with each `reextract_jobs.id` for reproducibility.
