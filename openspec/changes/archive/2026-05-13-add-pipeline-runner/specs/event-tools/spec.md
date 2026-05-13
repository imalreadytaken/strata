## MODIFIED Requirements

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
