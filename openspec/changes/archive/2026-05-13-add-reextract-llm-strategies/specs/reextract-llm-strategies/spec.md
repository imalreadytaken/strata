## ADDED Requirements

### Requirement: `runLlmReextract` is the shared LLM-backed re-extract path

The system SHALL export `runLlmReextract(row, job, deps, contextText): Promise<StrategyOutcome>` which:

1. Reads the linked `schema_evolutions.diff` and parses it as `{ kind: 'llm_field', target_column, extract_prompt, confidence_threshold? }`. Malformed → `{ kind: 'failed', error }`.
2. If `row[target_column]` is already non-null → `{ kind: 'skipped', reason: 'already_set' }`.
3. Renders the prompt by substituting `{{context}}` with `contextText`.
4. Calls `deps.llmClient.infer({ system, user })` (rejects when `deps.llmClient` is undefined).
5. Parses the response as `{ value, confidence }` JSON. Parse failure → `failed`.
6. Decides outcome by confidence:
   - `>= confidence_threshold` (default 0.7) → UPDATE the column, return `wrote`.
   - `>= 0.3` → UPDATE the column, return `low_confidence`.
   - `< 0.3` → no UPDATE, return `failed`.

#### Scenario: High-confidence response writes the value

- **WHEN** the LLM returns `{"value":"dining","confidence":0.9}` for an unset row
- **THEN** the outcome is `{ kind: 'wrote', confidence: 0.9 }` and the target column equals `'dining'` afterwards

#### Scenario: Mid-confidence response still writes but marks low_confidence

- **WHEN** confidence is 0.5
- **THEN** the outcome is `{ kind: 'low_confidence', confidence: 0.5 }` and the target column is updated

#### Scenario: Very-low-confidence does not write

- **WHEN** confidence is 0.2
- **THEN** the outcome is `{ kind: 'failed', error }` and the target column stays NULL

#### Scenario: Already-set target is skipped

- **WHEN** the row's target column already has a non-null value
- **THEN** the outcome is `{ kind: 'skipped', reason: 'already_set' }` and the LLM is not called

#### Scenario: Malformed LLM response fails the row

- **WHEN** the LLM returns `not json`
- **THEN** the outcome is `{ kind: 'failed', error }` referencing JSON parsing

### Requirement: `reextractRawEventsStrategy` seeds its context from the linked raw_event

The strategy SHALL look up the `raw_events` row matching `row.raw_event_id`, build `context = source_summary + '\n\nextracted_data: ' + JSON.stringify(extracted_data, null, 2)`, and delegate to `runLlmReextract`. Missing raw_event → `{ kind: 'failed', error }`.

#### Scenario: Context includes source_summary and extracted_data

- **WHEN** the linked raw_event has `source_summary='Blue Bottle 拿铁'` and `extracted_data='{"amount_minor":4500}'`
- **THEN** the stubbed LLM's `infer({ user })` is called with a `user` string containing both `'Blue Bottle 拿铁'` and `'amount_minor'`

#### Scenario: Missing raw_event fails the row

- **WHEN** `row.raw_event_id` references a non-existent raw_event
- **THEN** the outcome is `{ kind: 'failed', error }` mentioning the raw_event id

### Requirement: `reextractMessagesStrategy` seeds context from the full message chain

The strategy SHALL look up the linked `raw_events` row, then the union of `primary_message_id` + JSON-parsed `related_message_ids`. It loads those `messages.content` values (ordered by `received_at` ascending) and joins them with newlines into the context. Missing message ids are silently dropped (no failure).

#### Scenario: Context is chronologically-ordered message content

- **WHEN** the raw_event references three messages with `received_at` t1 < t2 < t3 and contents `'a'`, `'b'`, `'c'`
- **THEN** the stubbed LLM is called with `user` containing `'a'` then `'b'` then `'c'` in that order

#### Scenario: A missing referenced message id is silently dropped

- **WHEN** `related_message_ids = [primary, 9999]` and id 9999 doesn't exist
- **THEN** the context contains the primary message only and the outcome is whatever the LLM produces
