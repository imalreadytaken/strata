## ADDED Requirements

### Requirement: PendingBuffer tracks pending event IDs per session

The system SHALL ship a `PendingBuffer` class with the following methods (all returning `Promise<void>` or `Promise<T>` so a future async-persistence backend can be slotted in):

- `add(session_id: string, event_id: number): Promise<void>` — adds `event_id` to the session's set; idempotent
- `getAll(session_id: string): Promise<number[]>` — returns the current pending event ids for the session, in insertion order
- `has(session_id: string, event_id: number): Promise<boolean>`
- `remove(session_id: string, event_id: number): Promise<void>` — idempotent
- `clearSession(session_id: string): Promise<void>` — removes every pending event id for a session in one call
- `snapshot(): Promise<Record<string, number[]>>` — full read-only view

The in-memory representation is a `Map<string, Set<number>>` so add/has/remove are O(1). `getAll` returns an array sorted by insertion order (insertion-ordered `Set`).

#### Scenario: Tracks distinct sessions independently

- **WHEN** `add('s1', 1)`, `add('s1', 2)`, `add('s2', 3)` are called
- **THEN** `getAll('s1')` returns `[1, 2]` and `getAll('s2')` returns `[3]`

#### Scenario: add is idempotent

- **WHEN** `add('s1', 1)` is called twice
- **THEN** `getAll('s1')` returns exactly `[1]`

#### Scenario: remove is idempotent

- **WHEN** `remove('s1', 999)` is called on a session that does not contain 999
- **THEN** the call resolves without throwing

### Requirement: PendingBuffer persists to disk after every mutation

The buffer SHALL load its initial state from `<dataDir>/.strata-state/pending_buffer.json` on construction (treating a missing or unparseable file as empty), and SHALL write the full state back after every successful `add`, `remove`, or `clearSession`. The file format is `{ "<session_id>": [eventId, eventId, ...], ... }`.

The persistence write MUST be best-effort: a write failure is logged at `warn` level and does not propagate to the caller.

#### Scenario: A new PendingBuffer instance picks up persisted state

- **WHEN** a `PendingBuffer` with `stateFile=/tmp/x/pending_buffer.json` writes some entries, then a new instance is constructed pointing at the same path
- **THEN** the new instance reports the same `snapshot()`

#### Scenario: A missing state file boots an empty buffer

- **WHEN** `PendingBuffer` is constructed with a `stateFile` pointing at a non-existent path
- **THEN** the buffer is empty and the first `add(...)` creates the file with the right shape

#### Scenario: Persistence failure does not propagate

- **WHEN** `stateFile` points at an unwritable path
- **THEN** `add(...)` still resolves and a `warn`-level log entry records the failure

### Requirement: Timeout loop drains stale pending events

The system SHALL expose `startPendingTimeoutLoop(deps): () => void` that schedules a `setInterval` polling `raw_events` for `status = 'pending'` rows whose `created_at` is older than `config.pending.timeoutMinutes`. The default poll interval is 60 s but a `pollEveryMs` override is accepted for tests.

For each expired row:

- If `extraction_confidence >= 0.7`: transition `status='committed'`, `committed_at = now`, `updated_at = now`, and remove the event from the in-memory buffer
- If `extraction_confidence  < 0.7` (or NULL): transition `status='abandoned'`, `abandoned_reason = 'pending_timeout'`, `updated_at = now`, and remove the event from the in-memory buffer

The function returns a `stop()` handle that clears the interval; calling `stop()` twice is safe.

#### Scenario: Auto-commits a high-confidence expired pending event

- **WHEN** a `pending` raw_event with `extraction_confidence = 0.9` is older than the timeout and the loop ticks
- **THEN** the row's `status` becomes `'committed'`, its `committed_at` is non-null, and the buffer no longer reports it for that session

#### Scenario: Auto-abandons a low-confidence expired pending event

- **WHEN** a `pending` raw_event with `extraction_confidence = 0.2` is older than the timeout and the loop ticks
- **THEN** the row's `status` becomes `'abandoned'` and `abandoned_reason = 'pending_timeout'`

#### Scenario: stop() halts the polling

- **WHEN** `startPendingTimeoutLoop(deps)` returns a `stop` handle and `stop()` is called
- **THEN** no further iterations run, even after `pollEveryMs` elapses
