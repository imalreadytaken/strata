## 1. Shared helper

- [x] 1.1 Create `src/reextract/strategies/llm_shared.ts` exporting:
  - `LlmFieldDiffSchema = z.object({ kind: z.literal('llm_field'), target_column, extract_prompt, confidence_threshold: z.number().min(0).max(1).default(0.7) })`.
  - `LlmInferResponseSchema = z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]), confidence: z.number().min(0).max(1) })`.
  - `renderLlmPrompt(extractPromptTemplate, context): string` — substitutes `{{context}}`.
  - `runLlmReextract(row, job, deps, contextText): Promise<StrategyOutcome>` — looks up `schema_evolutions.diff`, parses, checks if target is already set, calls `deps.llmClient.infer`, parses response, writes value if confidence ≥ threshold.

## 2. `reextract_raw_events` strategy

- [x] 2.1 Create `src/reextract/strategies/reextract_raw_events.ts` exporting `reextractRawEventsStrategy: ReextractStrategy`. The `process` impl:
  - Read the linked `raw_events` row by `row.raw_event_id`.
  - Build context = `source_summary\n\nextracted_data: <JSON pretty-print>`.
  - Delegate to `runLlmReextract`.

## 3. `reextract_messages` strategy

- [x] 3.1 Create `src/reextract/strategies/reextract_messages.ts` exporting `reextractMessagesStrategy: ReextractStrategy`. The `process` impl:
  - Read the linked `raw_events` row by `row.raw_event_id`.
  - Read `messages` for `primary_message_id` ∪ JSON.parse(`related_message_ids`), sorted by `received_at`.
  - Build context = concatenated message contents.
  - Delegate to `runLlmReextract`.

## 4. Barrel + plugin entry

- [x] 4.1 Modify `src/reextract/index.ts`: re-export both strategies.
- [x] 4.2 Modify `src/index.ts`: register both strategies at boot (try/catch the duplicate-name throw so re-boots stay clean).

## 5. Tests

- [x] 5.1 `src/reextract/strategies/llm_shared.test.ts`:
  - Malformed diff → `failed`.
  - Already-set target → `skipped`.
  - LLM returns non-JSON → `failed`.
  - LLM returns valid JSON with confidence ≥ 0.7 → `wrote` + UPDATE happens.
  - confidence in [0.3, 0.7) → `low_confidence` + UPDATE still happens (marked).
  - confidence < 0.3 → `failed`, NO update.
- [x] 5.2 `src/reextract/strategies/reextract_raw_events.test.ts`:
  - Stubbed LLM gets a prompt containing `source_summary` + extracted_data JSON.
  - Missing `raw_events` row → `failed`.
- [x] 5.3 `src/reextract/strategies/reextract_messages.test.ts`:
  - Stubbed LLM gets a prompt with concatenated message contents in chronological order.
  - Single-message raw_event (no related ids) still produces a usable context.
  - Missing referenced message ids are skipped silently.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` all pass.
- [x] 6.3 `openspec validate add-reextract-llm-strategies --strict`.
