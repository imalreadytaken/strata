## 1. Shared helpers

- [x] 1.1 Create `src/tools/zod_to_json_schema.ts` exporting `toJsonSchema(schema: z.ZodType): unknown` that calls `z.toJSONSchema(schema, { target: 'draft-2020-12' })` and casts the result to `unknown` for the SDK's `parameters` slot.
- [x] 1.2 Add a unit test confirming the helper produces a JSON-Schema object with `type: 'object'` and the expected `properties` keys for a small Zod schema.

## 2. `strata_create_pending_event`

- [x] 2.1 Create `src/tools/create_pending_event.ts` exporting:
  - `CreatePendingEventInput` (Zod schema): `event_type` (string), `capability_name?` (string), `extracted_data` (`z.record(z.string(), z.unknown())`), `source_summary` (string), `event_occurred_at?` (string), `primary_message_id` (number), `confidence` (number 0–1).
  - `createPendingEventTool(deps): AnyAgentTool` factory closing over `{ rawEventsRepo, pendingBuffer, sessionId, logger }`.
- [x] 2.2 `execute(...)` parses raw params via the schema, calls `rawEventsRepo.insert({ session_id, event_type, status: 'pending', extracted_data: JSON.stringify(...), source_summary, primary_message_id, related_message_ids: JSON.stringify([primary_message_id]), event_occurred_at, capability_name, extraction_confidence: confidence, created_at, updated_at })`, then awaits `pendingBuffer.add(session_id, row.id)`.
- [x] 2.3 Returns `payloadTextResult({ event_id: row.id, status: 'awaiting_confirmation', summary: row.source_summary })`.
- [x] 2.4 `src/tools/create_pending_event.test.ts` covers: happy-path insert + buffer add, default fields populated, schema rejects negative `confidence`, schema rejects empty `source_summary`.

## 3. `strata_update_pending_event`

- [x] 3.1 Create `src/tools/update_pending_event.ts` with Zod schema `{ event_id, patch (record), new_summary?, related_message_id }`.
- [x] 3.2 `execute(...)` reads the row via `findById`, refuses if missing or `status !== 'pending'` (throw with a clear message — the SDK surfaces this to the LLM), merges `patch` into the JSON-parsed `extracted_data`, appends `related_message_id` to `related_message_ids`, optionally overrides `source_summary`, and writes back via `rawEventsRepo.update(...)`.
- [x] 3.3 Returns `payloadTextResult({ event_id, status: 'updated', summary })`.
- [x] 3.4 Test cases: merges shallow patch, appends unique message ids (no duplicates), refuses non-pending row, refuses missing row, replaces summary when `new_summary` supplied.

## 4. `strata_commit_event`

- [x] 4.1 Create `src/tools/commit_event.ts` exporting `commitEventCore(deps, eventId): Promise<{ event_id, status, capability_written, summary }>` AND `commitEventTool(deps)`.
- [x] 4.2 `commitEventCore`: refuses if row missing or `status !== 'pending'`, calls `rawEventsRepo.update(eventId, { status: 'committed', committed_at: now, updated_at: now })`, then `pendingBuffer.remove(session_id, eventId)` (errors swallowed per D8). `capability_written` is always `false` in this change — pipeline runner is P3 — and the helper notes that on the result for forward compatibility.
- [x] 4.3 `commitEventTool` is a thin wrapper: parse `event_id`, delegate to `commitEventCore`, return `payloadTextResult(...)`.
- [x] 4.4 Test cases: pending row commits cleanly, double-commit refuses with clear error, buffer removal still succeeds even when buffer doesn't contain the id, `capability_written: false` set on result.

## 5. `strata_supersede_event`

- [x] 5.1 Create `src/tools/supersede_event.ts` with Zod schema `{ old_event_id, new_extracted_data, new_summary, correction_message_id }`.
- [x] 5.2 `execute(...)` looks up `old`, refuses if missing or `status !== 'committed'`, then inside `rawEventsRepo.transaction(...)`:
  1. INSERT new row with `status='committed'`, `supersedes_event_id=old.id`, `committed_at=now`, copy `event_type`/`capability_name`/`event_occurred_at`/`extraction_version` from `old`, `related_message_ids=[correction_message_id]`, `primary_message_id=correction_message_id`.
  2. UPDATE `old`: `status='superseded'`, `superseded_by_event_id=newId`, `updated_at=now`.
- [x] 5.3 Returns `payloadTextResult({ new_event_id, old_event_id, status: 'superseded' })`.
- [x] 5.4 Test cases: successful supersede creates correct linkage, non-committed row refuses, transaction rollback on simulated INSERT failure (use a repo spy), `new_summary` lands on the new row, old row's other fields untouched.

## 6. `strata_abandon_event`

- [x] 6.1 Create `src/tools/abandon_event.ts` with Zod schema `{ event_id, reason?: string }` (default reason `'user_declined'`).
- [x] 6.2 `execute(...)` refuses if row missing or `status !== 'pending'`, updates `{ status: 'abandoned', abandoned_reason, updated_at: now }`, calls `pendingBuffer.remove(session_id, event_id)`.
- [x] 6.3 Returns `payloadTextResult({ event_id, status: 'abandoned', reason })`.
- [x] 6.4 Test cases: pending row abandoned with default reason, custom reason persisted, non-pending row refuses.

## 7. `strata_search_events`

- [x] 7.1 Create `src/tools/search_events.ts` with Zod schema:
  - `query?: string` (LIKE on `source_summary`, optional)
  - `event_type?: string`
  - `status?: 'pending' | 'committed' | 'superseded' | 'abandoned'`
  - `since?: string` (ISO 8601 — filter `created_at >= since`)
  - `until?: string` (ISO 8601 — filter `created_at <= until`)
  - `limit?: number` (default 10, max 50)
- [x] 7.2 `execute(...)` builds a parametrised `SELECT ... FROM raw_events WHERE ... ORDER BY committed_at DESC NULLS LAST, created_at DESC LIMIT ?` via the repo (or a tiny private SQL helper inside the tool file — search isn't part of the generic repository contract).
- [x] 7.3 Returns `payloadTextResult({ count, results: [{ event_id, status, event_type, capability_name, source_summary, event_occurred_at, created_at, extraction_confidence }] })`.
- [x] 7.4 Test cases: returns nothing on empty DB, LIKE matches partial summary case-insensitively, `event_type` filter narrows results, `limit` caps results, ORDER BY puts committed rows first, then pending, then older.

## 8. Plugin wiring

- [x] 8.1 Create `src/tools/index.ts` exporting `registerEventTools(api, runtime): void`. Inside, call `api.registerTool(factory)` for each of the six tools — the factory receives `ctx` and returns the `AnyAgentTool` built from `{ ...runtime, sessionId: ctx.sessionId ?? 'default' }`.
- [x] 8.2 Modify `src/index.ts` to call `registerEventTools(api, runtime)` after `startPendingTimeoutLoop`. Update the doc comment about P2 milestones.

## 9. Integration

- [x] 9.1 Run `npm run typecheck` → clean.
- [x] 9.2 Run `npm test` → all tests pass (existing 122 + new ones).
- [x] 9.3 Run `openspec validate add-event-tools --strict` (sanity check before archive).
