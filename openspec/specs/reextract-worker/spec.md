# reextract-worker Specification

## Purpose

`reextract-worker` drains `reextract_jobs`. `startReextractWorker(deps, opts)` ticks every `intervalMs` (default 30s, from `config.reextract.poll_interval_seconds`), picks the lowest-id `pending` job, transitions it `running → done/failed`, calls `runReextractJob` per-row through the strategy registry. Strategies are pluggable via `ReextractStrategyRegistry`; this change ships `deriveExistingStrategy` (no-LLM, SQL-only: copy / constant). The worker is idempotent across crashes — checkpoints stamp `last_checkpoint_at` every `checkpoint_every_rows`. `enabled=false` makes the worker a no-op (no timer registered). LLM-backed strategies (`reextract_raw_events`, `reextract_messages`) land in the next change; this layer is ready for them via the registry.

## Requirements
### Requirement: `ReextractStrategy` is a one-method interface returning a tagged outcome

The system SHALL export `ReextractStrategy = { name: string; process(row, job, deps): Promise<StrategyOutcome> }` where `StrategyOutcome` is the discriminated union:

- `{ kind: 'wrote'; confidence: number; costCents?: number }`
- `{ kind: 'low_confidence'; confidence: number; costCents?: number }`
- `{ kind: 'failed'; error: string }`
- `{ kind: 'skipped'; reason: string }`

The runner maps these outcomes to `rows_done` / `rows_low_confidence` / `rows_failed` increments and accumulates `actual_cost_cents`.

#### Scenario: All four outcome kinds are covered exhaustively

- **WHEN** consuming a `StrategyOutcome` via a `switch (outcome.kind)` block
- **THEN** the four arms (`'wrote'`, `'low_confidence'`, `'failed'`, `'skipped'`) cover every value the strategy may produce

### Requirement: `ReextractStrategyRegistry` keys strategies by name

The system SHALL expose `ReextractStrategyRegistry` with `register(strategy)` / `get(name)` / `list()`. Registering a duplicate name throws `STRATA_E_VALIDATION`. A module-level `defaultRegistry` is exported and pre-populated by the plugin entry with `deriveExistingStrategy`.

#### Scenario: Registering and retrieving a strategy

- **WHEN** `registry.register({ name: 'x', process })` then `registry.get('x')`
- **THEN** the registered strategy is returned

#### Scenario: Duplicate name throws

- **WHEN** the same name is registered twice
- **THEN** the second call throws with code `STRATA_E_VALIDATION`

### Requirement: `runReextractJob` drains a single job with per-row try/catch

The system SHALL export `runReextractJob(job, deps): Promise<ReextractJobOutcome>` that:

- Resolves the strategy by `job.strategy`. Missing → `{ status: 'failed', last_error: 'unknown_strategy:<name>' }` without iterating any rows.
- Looks up the target table's row ids via `SELECT id FROM <capability.primary_table> ORDER BY id`.
- Updates `rows_total` once.
- Iterates row-by-row. Each call is wrapped in try/catch — an exception becomes `rows_failed++` with the error stored in `last_error` (overwritten by each subsequent failure).
- Updates `last_checkpoint_at` every `checkpointEveryRows` (default 20).
- Returns `{ status: 'done', ... }` when the loop completes.

#### Scenario: Mixed outcomes update the right counters

- **WHEN** a stub strategy returns `wrote` for row 1, `low_confidence` for row 2, `failed` for row 3, `skipped` for row 4, then `wrote` for row 5
- **THEN** the outcome is `{ rows_done: 2, rows_failed: 1, rows_low_confidence: 1, status: 'done' }`

#### Scenario: Unknown strategy aborts the job without scanning rows

- **WHEN** `job.strategy === 'mystery'`
- **THEN** the outcome is `{ status: 'failed', last_error: 'unknown_strategy:mystery' }` and the runner did not query the capability's primary table

### Requirement: `startReextractWorker` polls + transitions one job at a time

The system SHALL export `startReextractWorker(deps, opts?): () => void` that returns a `stop` function. When the config's `enabled === false`, no timer is registered and the function is a no-op. Otherwise the worker:

1. `setInterval(tick, intervalMs)` (default 30s).
2. Each tick picks the lowest-id `pending` job. None → no-op.
3. Transitions to `running` with `started_at = now`.
4. Calls `runReextractJob`. Updates the row to `done` / `failed` with the outcome's counters + `completed_at`.
5. All exceptions in step 2–4 are caught + warn-logged + stamp `last_error`; the next tick proceeds.

#### Scenario: Pending job runs and lands at `done`

- **WHEN** a `pending` job exists and a tick fires
- **THEN** the job transitions through `running` to `done` with `started_at` + `completed_at` stamped

#### Scenario: Worker disabled by config produces no-op stop

- **WHEN** `enabled = false`
- **THEN** `startReextractWorker` returns a function that does nothing; no timer is registered

### Requirement: `deriveExistingStrategy` performs SQL-only backfills

The system SHALL ship `deriveExistingStrategy: ReextractStrategy` that reads the `schema_evolutions.diff` JSON (looked up by `job.schema_evolution_id`) and performs one of:

- `{ kind: 'constant', target_column, value }` → `UPDATE <table> SET <target_column> = ? WHERE id = ? AND <target_column> IS NULL`
- `{ kind: 'copy', target_column, source_column }` → `UPDATE <table> SET <target_column> = <source_column> WHERE id = ? AND <target_column> IS NULL`

When `db.changes === 0` → `{ kind: 'skipped', reason: 'already_set' }`. On parse / validation failure of the diff JSON → `{ kind: 'failed', error }`. Otherwise `{ kind: 'wrote', confidence: 1.0 }`.

#### Scenario: Constant fill writes only NULL rows

- **WHEN** the strategy runs against a row whose `currency` is NULL with diff `{kind:'constant', target_column:'currency', value:'CNY'}`
- **THEN** the outcome is `{ kind: 'wrote', confidence: 1.0 }` and the row's `currency='CNY'`

#### Scenario: Already-set row is skipped

- **WHEN** the same diff runs against a row whose `currency='USD'` already
- **THEN** the outcome is `{ kind: 'skipped', reason: 'already_set' }` and the row's `currency='USD'` (unchanged)

#### Scenario: Copy fill mirrors source column

- **WHEN** diff is `{kind:'copy', target_column:'main_category', source_column:'category'}`, row.category='dining'
- **THEN** row.main_category='dining' after the run

#### Scenario: Invalid diff JSON fails the row

- **WHEN** the diff is malformed (missing `target_column`)
- **THEN** the outcome is `{ kind: 'failed', error: <descriptive> }`

