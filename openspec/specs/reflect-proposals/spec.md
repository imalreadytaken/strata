# reflect-proposals Specification

## Purpose

`reflect-proposals` is the middle layer of the Reflect Agent: `generateProposals(signals, deps)` maps `ReflectSignal[]` to `proposals` rows with two skip rules — duplicate-pending (by `(kind, target_capability)` for evolution/decay; by `evidence_event_ids` overlap for emergence) and active cooldown (declined rows whose `cooldown_until > now`). `pushProposalsToUser(rows, deps)` invokes a caller-supplied `notify(row, card)` and unconditionally stamps `pushed_to_user_at` — `notify` failures are warn-logged, not propagated. `renderProposalCard(row)` is a pure template producing a single short string suitable for an IM message.

## Requirements
### Requirement: `generateProposals` writes one proposals row per non-duplicate signal

The system SHALL export `generateProposals(signals: ReflectSignal[], deps): Promise<GenerateProposalsResult>` that, for each signal:

- Computes a deduplication identity:
  - `kind='schema_evolution'` / `kind='capability_archive'` → `target_capability`.
  - `kind='new_capability'` → the sorted list of `evidence_event_ids`.
- Skips when an existing `pending` proposal already matches by `kind` + identity (for evolution/decay) OR has any overlapping `evidence_event_ids` (for emergence).
- Skips when a `declined` proposal matches AND `cooldown_until > now()`.
- Otherwise INSERTs a `proposals` row with `source='reflect_agent'`, `status='pending'`, `kind` from the signal, and the signal's body rendered into `title` / `summary` / `rationale` / `proposed_design` (JSON of the original signal) / `signal_strength` / `evidence_event_ids` / `target_capability`.

Returns `{ inserted: ProposalRow[]; skipped: SkippedReason[] }`.

#### Scenario: An emergence signal inserts one proposal

- **WHEN** `generateProposals([emergenceSignal], deps)` runs against an empty proposals table
- **THEN** `inserted.length === 1`, the row's `kind='new_capability'`, `source='reflect_agent'`, `signal_strength` matches the signal's, `evidence_event_ids` JSON contains the signal's ids

#### Scenario: Duplicate evolution/decay signal is skipped

- **WHEN** a `pending` row already exists with `kind='schema_evolution'` AND `target_capability='expenses'`, and a new matching signal is generated
- **THEN** `inserted.length === 0` and `skipped[0].reason === 'duplicate_pending'`

#### Scenario: Cooldown blocks a previously declined proposal

- **WHEN** a `declined` row exists with `cooldown_until` 7 days in the future, and a new signal matches the same identity
- **THEN** `skipped[0].reason === 'cooldown'`

#### Scenario: Emergence overlap is treated as duplicate

- **WHEN** a `pending` proposal references `evidence_event_ids=[1,2,3]` and a new signal has `[3,4,5]`
- **THEN** `skipped[0].reason === 'duplicate_pending'`

### Requirement: `pushProposalsToUser` invokes notify + stamps `pushed_to_user_at`

The system SHALL export `pushProposalsToUser(rows, deps): Promise<void>` that, for each row:

- Calls `deps.notify(row, renderProposalCard(row))`.
- On `notify` rejection: warn-log, do NOT throw.
- Updates `proposalsRepo` to set `pushed_to_user_at = now()` regardless of notify success.

#### Scenario: Push invokes notify once per row

- **WHEN** `pushProposalsToUser([row1, row2], deps)` runs with a spy `notify`
- **THEN** `notify` is called twice, and both rows have `pushed_to_user_at` set after the call

#### Scenario: Notify rejection is swallowed; pushed_to_user_at is still stamped

- **WHEN** `notify` rejects for `row1` but resolves for `row2`
- **THEN** `pushProposalsToUser` resolves; both rows have `pushed_to_user_at` set; a `warn`-level log records the `row1` failure

### Requirement: `renderProposalCard` returns a short human-readable string

The system SHALL export `renderProposalCard(row): { text: string }` whose `text` includes the proposal id, the kind, and key body fields suitable for an IM message. The card MUST be a single string under ~300 characters.

#### Scenario: Card includes id and kind

- **WHEN** `renderProposalCard({ id: 7, kind: 'schema_evolution', ... })`
- **THEN** the result's `text` contains `'#7'` and `'schema_evolution'`

