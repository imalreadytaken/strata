## ADDED Requirements

### Requirement: `scanRawEvents` returns committed events in a time window

The system SHALL export `scanRawEvents(deps, opts?: { sinceDays?: number; now?: () => Date }): Promise<RawEventRow[]>` that:

- Defaults `sinceDays = 90`.
- Returns only rows with `status = 'committed'`.
- Returns only rows with `created_at >= now() - sinceDays * 86400000ms`.

#### Scenario: Excludes non-committed events

- **WHEN** the DB contains `pending` and `committed` rows and `scanRawEvents` runs
- **THEN** only `committed` rows appear in the result

#### Scenario: Respects sinceDays

- **WHEN** `sinceDays = 1` and the DB has a `committed` row 5 days old
- **THEN** the result does not include that row

### Requirement: `detectNewCapabilityEmergence` flags committed-but-unbound event clusters

The system SHALL export `detectNewCapabilityEmergence(deps, opts?): Promise<EmergenceSignal[]>` that:

- Reads committed events whose `capability_name IS NULL` or whose `capability_name` is not currently `'active'` in `capability_registry`.
- Buckets them by `event_type` (or `'unclassified'`).
- Emits one signal per bucket whose `size >= thresholds.emergence.min_cluster_size` AND `spanDays >= thresholds.emergence.min_span_days`.
- `signal_strength = min(size / 30, 0.95)`.
- `suggested_name = slugify(event_type)` by default; when `opts.useLLM === true` AND `deps.llmClient` resolves to a non-heuristic backend, an LLM call upgrades the name + rationale; LLM failures gracefully fall back to the slug.

#### Scenario: A cluster of 12 unclassified events over 10 days emits a signal

- **WHEN** the DB has 12 committed `unclassified` events spanning 10 days
- **THEN** one EmergenceSignal is returned with `suggested_name='unclassified'`, `signal_strength≈12/30`

#### Scenario: A cluster of 5 events is dropped

- **WHEN** the cluster size is below `min_cluster_size`
- **THEN** no signal is returned for that bucket

#### Scenario: Events bound to an active capability are excluded

- **WHEN** a cluster's `capability_name` IS the name of an active registry row
- **THEN** the cluster is excluded from emergence detection

### Requirement: `detectSchemaEvolutionNeed` flags skewed enum-like columns

The system SHALL export `detectSchemaEvolutionNeed(deps, opts?): Promise<EvolutionSignal[]>` that, per active capability:

- Lists TEXT columns of the `primary_table` via `PRAGMA table_info`. Excludes `id`, `raw_event_id`, `currency`, and columns whose names end in `_at`.
- For each TEXT column with `>= thresholds.evolution.min_rows_for_skew_check` non-null rows AND a `max(count)/total >= thresholds.evolution.field_skew_threshold`, emits a signal naming the column + dominant value + ratio.

#### Scenario: Skewed `category` column emits a signal

- **WHEN** `expenses` has 50 rows, 35 of which are `category='dining'`
- **THEN** an EvolutionSignal is returned for `expenses.category` with `dominant_value='dining'` and `ratio≈0.7`

#### Scenario: Uniform distribution emits no signal

- **WHEN** every `category` value has roughly the same count
- **THEN** no signal is returned for that column

### Requirement: `detectArchiveCandidates` flags stale active capabilities

The system SHALL export `detectArchiveCandidates(deps, opts?): Promise<DecaySignal[]>` that:

- Reads each `capability_registry` row with `status='active'`.
- Reads its `capability_health` row.
- Computes `daysSinceWrite` and `daysSinceRead` from `last_write_at` / `last_read_at` (NULL → infinite).
- Emits a signal when both exceed the thresholds (`days_since_last_write` / `days_since_last_read`).
- `signal_strength = min(daysSinceWrite / 180, 0.95)`.

#### Scenario: Stale capability emits a signal

- **WHEN** `last_write_at` is 120 days ago and `last_read_at` is 60 days ago
- **THEN** one DecaySignal is returned with `target_capability` set and `signal_strength ≈ 0.67`

#### Scenario: Recent activity → no signal

- **WHEN** `last_write_at` is 5 days ago
- **THEN** no signal for that capability
