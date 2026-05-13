## Why

`derive_existing` covers the trivial cases: copy a column, fill a constant. The interesting backfills need to *reason* about the user's data — "given the message that produced this expense, what subcategory would the agent assign now?" That's an LLM job. Two source-of-truth options:

- **`reextract_raw_events`** — read the `raw_events` row that produced the business row; re-prompt with its `extracted_data` + `source_summary`. Faster, cheaper; assumes the raw_event captured enough.
- **`reextract_messages`** — go back to the original `messages` linked through `primary_message_id` + `related_message_ids`. Heaviest, most complete; useful when the new field needs context the raw event didn't preserve.

Both share most of the work (build prompt → call LLM → parse → write). We factor the shared piece into `llm_shared.ts`; each strategy is then a thin "where does the text come from" wrapper.

References: `STRATA_SPEC.md` §5.9 (3-strategy sketch), §3.1 `raw_events` + `messages` schemas.

## What Changes

- Add `reextract-llm-strategies` capability covering:
  - **`reextractRawEventsStrategy`** — for each capability row, look up its `raw_event_id`'s `raw_events` row, build a prompt seeded with `source_summary` + `extracted_data`, ask the LLM for the new field value, write when confidence ≥ threshold.
  - **`reextractMessagesStrategy`** — same shape, but the prompt context is the concatenated `messages.content` for `primary_message_id` + `related_message_ids` of the raw event.
  - **Shared helper `runLlmReextract(deps, ctx, row, job)`** — handles the LLM call + parsing + per-row write. Reads `schema_evolutions.diff` JSON (shape `{ kind: 'llm_field', target_column, extract_prompt, confidence_threshold? }`).
  - **Outcome mapping**: confidence ≥ `confidence_threshold` (default 0.7) → `wrote`; ≥ 0.3 → `low_confidence` (we still write the value, marked); < 0.3 → `failed`. Cost is reported when the deps' `costEstimator` is supplied.
  - **Plugin entry wiring**: both strategies register against `defaultRegistry` at boot.

## Capabilities

### New Capabilities
- `reextract-llm-strategies`: two LLM-backed re-extract strategies + a shared helper.

### Modified Capabilities
*(none — uses `reextract-worker`'s registry pattern unchanged)*

## Impact

- **Files added**:
  - `src/reextract/strategies/llm_shared.ts` — `runLlmReextract`, diff schema (`llm_field`), prompt builders.
  - `src/reextract/strategies/reextract_raw_events.ts` — `reextractRawEventsStrategy`.
  - `src/reextract/strategies/reextract_messages.ts` — `reextractMessagesStrategy`.
  - Three `*.test.ts` files.
- **Files modified**:
  - `src/reextract/index.ts` — re-export.
  - `src/index.ts` — register both strategies at boot (idempotent).
- **Non-goals**:
  - No structured-output enforcement in the LLM call. We ask for `{ value, confidence }` JSON; on parse failure → `failed`. Future change can pass `responseSchema` once we have JSON-mode support.
  - No batching. One row per LLM call; the cost is real but accurately reported.
  - No backfill ordering / batching beyond what the runner already does.
