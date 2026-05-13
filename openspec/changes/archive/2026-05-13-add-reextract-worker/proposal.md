## Why

When Build Bridge ships a schema evolution (e.g., adding `subcategory` to `expenses`), the new column lands as NULL on every existing row. The user expects "Strata fills it in automatically" — without that, schema evolution stops working halfway and operators end up writing ad-hoc SQL. The `reextract_jobs` table exists from P1 to track these backfills; this change ships the worker that drains it.

The first strategy `derive_existing` handles the cheapest, no-LLM-needed cases:

- **Copy column** — new `currency` column should be `'CNY'` because that's what every row had implicitly. Take from an existing column (or constant) and broadcast.
- **Constant fill** — new `extraction_version=2` for every old row.
- **Conditional copy** — new `main_category` from old `category` per a small mapping.

Strategies that need an LLM (re-extract from raw_events or from messages) land in the next change.

References: `STRATA_SPEC.md` §5.9 (worker sketch), §3.1 `reextract_jobs` table, §10.1 `config.reextract.*`.

## What Changes

- Add `reextract-worker` capability covering:
  - **`ReextractStrategy`** interface — `{ name: string; process(row, job, deps): Promise<StrategyOutcome> }`. `StrategyOutcome = { kind: 'wrote', confidence: number, costCents?: number } | { kind: 'low_confidence', confidence: number } | { kind: 'failed', error: string } | { kind: 'skipped', reason: string }`.
  - **`ReextractStrategyRegistry`** — a `Map<string, ReextractStrategy>` the worker consults at runtime; tests register a stub strategy and run the worker once.
  - **`runReextractJob(job, deps): Promise<ReextractJobOutcome>`** — picks the strategy, fetches the target rows from the capability's primary table, iterates with per-row try/catch + checkpoint every `checkpoint_every_rows` (default 20), updates the counters. Returns final counts.
  - **`startReextractWorker(deps): () => void`** — `setInterval` (default 30s) that picks one `pending` job, transitions to `running`, calls `runReextractJob`, then transitions to `done` / `failed`. Concurrency cap = 1 (per `config.reextract.max_concurrent_jobs`).
  - **`deriveExistingStrategy`** — concrete implementation reading per-evolution config from `schema_evolutions.diff` (JSON shape `{ kind: 'copy' | 'constant', target_column, source_column?, value? }`). Pure SQL — no LLM.
  - **Plugin entry wiring**: `register(api)` calls `startReextractWorker` after the Reflect cron. The `stop` handle goes on `runtime.stopReextract`.

## Capabilities

### New Capabilities
- `reextract-worker`: scheduled worker + strategy registry + `derive_existing` strategy.

### Modified Capabilities
*(none — uses the existing `reextract_jobs` repo + a new strategy interface)*

## Impact

- **Files added**:
  - `src/reextract/types.ts` — strategy / outcome / job-result types.
  - `src/reextract/registry.ts` — `ReextractStrategyRegistry` + default singleton.
  - `src/reextract/runner.ts` — `runReextractJob(job, deps)`.
  - `src/reextract/worker.ts` — `startReextractWorker(deps)`.
  - `src/reextract/strategies/derive_existing.ts` — first strategy.
  - `src/reextract/index.ts` — barrel.
  - Five `*.test.ts` files with seeded fixtures.
- **Files modified**:
  - `src/runtime.ts` — `StrataRuntime.stopReextract?: () => void`; `bootRuntime` doesn't yet start the worker (plugin entry does).
  - `src/index.ts` — `register(api)` calls `startReextractWorker`.
  - `src/core/config.ts` — add `reextract` config section (`poll_interval_seconds`, `checkpoint_every_rows`, `max_concurrent_jobs`, `enabled`).
- **Non-goals**:
  - No LLM-backed strategies. `reextract_raw_events` and `reextract_messages` ship in the next change.
  - No `paused` UX. The status exists in the schema; pause/resume can land later.
  - No proposal-to-job auto-dispatch. The integration phase (or a manual SQL insert) is what creates the `reextract_jobs` row; the worker doesn't auto-propose.
