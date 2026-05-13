# event-tools Specification

## Purpose

`event-tools` is the LLM-facing write path against the `raw_events` ledger. It ships six agent tools registered via `api.registerTool(factory)` — `strata_create_pending_event`, `strata_update_pending_event`, `strata_commit_event`, `strata_supersede_event`, `strata_abandon_event`, `strata_search_events` — that drive every legal state transition on a `raw_events` row plus a read-only search. Zod 4 schemas define the parameter contract and are converted to JSON Schema at boot for the OpenClaw SDK. The `commit` path exports a `commitEventCore(deps, eventId)` helper so the inline-keyboard callback (next capability) shares the same transition code. Supersede wraps its two writes in a SQLite transaction so a partial failure never leaves an orphan committed row.
## Requirements
### Requirement: `strata_create_pending_event` creates a `pending` raw_events row and tracks it in the buffer

The system SHALL register a `strata_create_pending_event` agent tool whose parameters are validated by a Zod 4 schema with fields:

- `event_type: string` — semantic kind (`consumption` / `mood` / `workout` / `reading` / `unclassified` …)
- `capability_name?: string` — bound capability name when one matches
- `extracted_data: Record<string, unknown>` — structured payload (stringified into `raw_events.extracted_data`)
- `source_summary: string` — one-line, user-facing description
- `event_occurred_at?: string` — ISO 8601 if the user mentioned a specific time
- `primary_message_id: number` — the `messages.id` that triggered this event
- `confidence: number` (0–1) — extraction confidence

On invocation the tool SHALL:

1. INSERT a `raw_events` row with `status='pending'`, the provided fields, `related_message_ids = JSON.stringify([primary_message_id])`, `extraction_confidence = confidence`, and `created_at`/`updated_at` set to `now()`.
2. Await `pendingBuffer.add(session_id, row.id)` where `session_id` is the session captured by the tool factory closure.
3. Return an `AgentToolResult` whose `details` are `{ event_id, status: 'awaiting_confirmation', summary }`.

#### Scenario: Inserts a pending row and registers the buffer

- **WHEN** the tool is invoked with valid params for `session_id='s1'`
- **THEN** a new `raw_events` row exists with `status='pending'`, `extracted_data` parses back to the input object, `pendingBuffer.has('s1', row.id)` returns `true`, and the tool result's `details.event_id` matches `row.id`

#### Scenario: Schema rejects out-of-range confidence

- **WHEN** the tool is invoked with `confidence = 1.5`
- **THEN** the call rejects with a Zod parse error and no row is inserted

#### Scenario: Schema rejects empty `source_summary`

- **WHEN** the tool is invoked with `source_summary = ''`
- **THEN** the call rejects with a Zod parse error and no row is inserted

### Requirement: `strata_update_pending_event` merges a patch into an existing pending row

The system SHALL register a `strata_update_pending_event` agent tool with parameters `{ event_id: number, patch: Record<string, unknown>, new_summary?: string, related_message_id: number }`.

On invocation the tool SHALL:

1. Look up the row by `event_id`. Refuse (throw `Error`) if missing or `status !== 'pending'`.
2. Compute `new_extracted_data = { ...JSON.parse(row.extracted_data), ...patch }`.
3. Compute `new_related = [...JSON.parse(row.related_message_ids), related_message_id]` with duplicates removed (last-write-wins on the id).
4. Update the row with the new fields and, when `new_summary` is supplied, replace `source_summary`.
5. Return `details = { event_id, status: 'updated', summary }`.

#### Scenario: Merges a shallow patch

- **WHEN** the row's `extracted_data = { amount_minor: 4500, merchant: 'Blue Bottle' }` and the tool is called with `patch = { amount_minor: 4800 }`
- **THEN** the row's `extracted_data` parses to `{ amount_minor: 4800, merchant: 'Blue Bottle' }`

#### Scenario: Refuses a non-pending row

- **WHEN** the row's `status = 'committed'`
- **THEN** the tool throws with a message that contains "not in pending state" and the row is not modified

#### Scenario: Appends the follow-up message id without duplicating

- **WHEN** the row's `related_message_ids = '[10]'` and the tool is invoked twice with `related_message_id = 11`
- **THEN** the row's `related_message_ids` parses to `[10, 11]` (the second call does not produce `[10, 11, 11]`)

### Requirement: `strata_commit_event` transitions a pending row to committed and exposes a reusable core helper

The system SHALL register a `strata_commit_event` agent tool with parameters `{ event_id: number }` AND export a `commitEventCore(deps, eventId)` helper used by the inline-keyboard callback in `add-callbacks`.

`commitEventCore` SHALL:

1. Refuse if the row is missing or `status !== 'pending'`.
2. Update the row to `status='committed'`, `committed_at = now()`, `updated_at = now()`.
3. Best-effort remove from the in-memory pending buffer (failures are caught and logged at `warn`, never propagated).
4. If the row has a `capability_name` AND `deps.pipelineDeps` is provided, invoke `runPipelineForEvent({ rawEvent: updated, toolDeps: deps.pipelineDeps })`. The returned `capability_written` flag is reflected in the result. A pipeline failure does NOT propagate to the caller; it is logged at `error` and `capability_written` is `false` (the committed row is preserved either way).
5. Return `{ event_id, status: 'committed', capability_written, summary }`.

#### Scenario: Commits a pending row

- **WHEN** a `pending` row exists for `session_id='s1'` and is in the buffer
- **THEN** after the tool call the row's `status='committed'`, `committed_at` is non-null, and `pendingBuffer.has('s1', event_id)` returns `false`

#### Scenario: Refuses a double-commit

- **WHEN** the row's `status` is already `'committed'`
- **THEN** the tool throws with a message referencing the current status and the row is not modified

#### Scenario: Core helper is callable without the tool wrapper

- **WHEN** `commitEventCore(deps, eventId)` is called directly
- **THEN** the row transitions identically and returns the same `details` payload the tool wrapper produces

#### Scenario: Bound capability writes a business row on commit

- **WHEN** a pending row with `capability_name='expenses'` exists, a registry entry for `expenses` is reachable through `deps.pipelineDeps`, and `commitEventCore` runs
- **THEN** the result's `capability_written` is `true`, `raw_events.business_row_id` is the id of the inserted row, and `capability_health.total_writes` for `'expenses'` increments by 1

#### Scenario: Capability without `pipelineDeps` reports `capability_written: false`

- **WHEN** a pending row with `capability_name='expenses'` is committed and `deps.pipelineDeps` is undefined (e.g. a unit test harness)
- **THEN** the result's `capability_written` is `false` and the underlying row is still `status='committed'`

### Requirement: `strata_supersede_event` atomically replaces a committed row via the supersede chain

The system SHALL register a `strata_supersede_event` agent tool with parameters `{ old_event_id: number, new_extracted_data: Record<string, unknown>, new_summary: string, correction_message_id: number }`.

On invocation the tool SHALL:

1. Look up the old row. Refuse if missing or `status !== 'committed'`.
2. Inside a single SQLite transaction:
   - INSERT a new `raw_events` row with `status='committed'`, `supersedes_event_id = old.id`, `committed_at = now()`, copying `event_type` / `capability_name` / `event_occurred_at` / `extraction_version` from the old row, and `primary_message_id = correction_message_id`, `related_message_ids = JSON.stringify([correction_message_id])`.
   - UPDATE the old row to `status='superseded'`, `superseded_by_event_id = newId`, `updated_at = now()`.
3. If either statement fails, the whole transaction MUST roll back (no orphan new row).
4. Return `{ new_event_id, old_event_id, status: 'superseded' }`.

#### Scenario: Creates a correct correction chain

- **WHEN** an old `committed` row `#10` is superseded with new data and `correction_message_id=42`
- **THEN** a new row `#11` exists with `status='committed'`, `supersedes_event_id=10`, `primary_message_id=42`; the old row `#10` has `status='superseded'`, `superseded_by_event_id=11`

#### Scenario: Refuses a non-committed row

- **WHEN** the old row's `status = 'pending'`
- **THEN** the tool throws with a message that contains "can only supersede committed events" and the database is unchanged

#### Scenario: Rolls back on partial failure

- **WHEN** the INSERT succeeds but the UPDATE on the old row fails
- **THEN** no new row exists in `raw_events` and the old row is unchanged

### Requirement: `strata_abandon_event` transitions a pending row to abandoned

The system SHALL register a `strata_abandon_event` agent tool with parameters `{ event_id: number, reason?: string }` (default reason `'user_declined'`).

On invocation the tool SHALL:

1. Refuse if the row is missing or `status !== 'pending'`.
2. Update the row to `status='abandoned'`, `abandoned_reason = reason ?? 'user_declined'`, `updated_at = now()`.
3. Best-effort remove from the pending buffer.
4. Return `{ event_id, status: 'abandoned', reason }`.

#### Scenario: Abandons with a default reason

- **WHEN** the tool is called without `reason`
- **THEN** the row's `abandoned_reason = 'user_declined'`

#### Scenario: Custom reason is persisted

- **WHEN** the tool is called with `reason = 'duplicate_entry'`
- **THEN** the row's `abandoned_reason = 'duplicate_entry'`

### Requirement: `strata_search_events` returns the latest matching raw_events

The system SHALL register a `strata_search_events` agent tool with parameters `{ query?: string, event_type?: string, status?: string, since?: string, until?: string, limit?: number }` (default `limit=10`, max `50`).

The tool SHALL execute a SQL query:

- Apply `source_summary LIKE '%' || ? || '%'` when `query` is supplied (case-insensitive via `COLLATE NOCASE`).
- Apply equality filters for `event_type` / `status`.
- Apply range filters `created_at >= since` / `created_at <= until` when supplied.
- ORDER BY `committed_at DESC NULLS LAST, created_at DESC`.
- LIMIT to `min(limit, 50)`.

Return `{ count, results: [{ event_id, status, event_type, capability_name, source_summary, event_occurred_at, created_at, extraction_confidence }] }`.

#### Scenario: Returns an empty result on an empty database

- **WHEN** the tool is called against a DB with no raw_events
- **THEN** the result is `{ count: 0, results: [] }`

#### Scenario: Filters by `event_type`

- **WHEN** two `consumption` rows and one `workout` row exist and the tool is called with `event_type='consumption'`
- **THEN** the result's `count = 2` and every result row has `event_type='consumption'`

#### Scenario: Caps the result at `limit`

- **WHEN** 20 rows exist and the tool is called with `limit=5`
- **THEN** the result's `results.length = 5`

#### Scenario: Hard-caps at 50 even when `limit` exceeds it

- **WHEN** the tool is called with `limit=999`
- **THEN** the result's `results.length <= 50`

### Requirement: All six tools are registered through `api.registerTool` at plugin boot

The system SHALL expose `registerEventTools(api: OpenClawPluginApi, runtime: StrataRuntime): void` that calls `api.registerTool(factory)` once. The factory closes over `ctx.sessionId` (defaulting to `'default'` with a `warn` log when missing) and the runtime's `rawEventsRepo`, `proposalsRepo`, `capabilityHealthRepo`, `pendingBuffer`, `logger`, plus the `pipelineDeps` bundle. The factory returns SEVEN tools:

- `strata_create_pending_event`
- `strata_update_pending_event`
- `strata_commit_event`
- `strata_supersede_event`
- `strata_abandon_event`
- `strata_search_events`
- `strata_propose_capability`

The plugin's `register(api)` invokes `registerEventTools` after `startPendingTimeoutLoop`.

#### Scenario: Plugin entry registers all seven tools

- **WHEN** the plugin's `register(api)` runs with a stub `api` that records `registerTool` calls
- **THEN** `registerTool` has been called exactly once with a factory whose returned tools have the seven names above

