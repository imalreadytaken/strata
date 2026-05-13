## 1. Config

- [x] 1.1 Modify `src/core/config.ts`: add `reextract = z.object({ enabled: z.boolean().default(true), poll_interval_seconds: z.number().int().positive().default(30), checkpoint_every_rows: z.number().int().positive().default(20), max_concurrent_jobs: z.number().int().positive().default(1) }).strict().prefault({})`.

## 2. Types

- [x] 2.1 Create `src/reextract/types.ts` exporting:
  - `StrategyOutcome = { kind: 'wrote'; confidence: number; costCents?: number } | { kind: 'low_confidence'; confidence: number; costCents?: number } | { kind: 'failed'; error: string } | { kind: 'skipped'; reason: string }`.
  - `ReextractStrategy = { name: string; process(row, job, deps): Promise<StrategyOutcome> }`.
  - `ReextractJobOutcome = { status: 'done' | 'failed'; rows_done: number; rows_failed: number; rows_low_confidence: number; cost_cents: number; last_error?: string }`.
  - `ReextractRunDeps = { db, capabilityRegistryRepo, reextractJobsRepo, schemaEvolutionsRepo, logger, llmClient?, now?, checkpointEveryRows? }`.

## 3. Registry

- [x] 3.1 Create `src/reextract/registry.ts` exporting `ReextractStrategyRegistry` class with `register(strategy)`, `get(name)`, `list()`. A module-level `defaultRegistry` is exported for production wiring.

## 4. Runner

- [x] 4.1 Create `src/reextract/runner.ts` exporting `runReextractJob(job, deps): Promise<ReextractJobOutcome>`:
  - Resolve `strategy` via the registry. Missing → return `{ status: 'failed', last_error: 'unknown_strategy:<name>' }`.
  - Look up the target rows from the capability's primary table. `SELECT id FROM <primary_table> ORDER BY id` then read each row separately as needed by the strategy.
  - Update `rows_total` once at the start.
  - For each row: per-row try/catch wraps `strategy.process(...)`. Outcome → counter increments; checkpoint every `checkpointEveryRows`.
  - At the end: return `{ status: 'done' (or 'failed' on aborted run), rows_done, rows_failed, rows_low_confidence, cost_cents }`.

## 5. Worker

- [x] 5.1 Create `src/reextract/worker.ts` exporting `startReextractWorker(deps, opts?: { intervalMs?; now? }): () => void`:
  - When `config.reextract.enabled === false` → return a no-op stop function, never register timer.
  - Else `setInterval(tick, intervalMs)`. `tick`:
    - `pickNextPendingJob(repo)` → returns the lowest-id `pending` job or null.
    - Update to `running`, stamp `started_at`.
    - Call `runReextractJob(job, deps)`. Update with the outcome's counters + `completed_at = now`.
    - All exceptions caught + logged at `error` + `last_error` stamped.
  - Returns stop function; idempotent.

## 6. `derive_existing` strategy

- [x] 6.1 Create `src/reextract/strategies/derive_existing.ts` exporting `deriveExistingStrategy: ReextractStrategy`:
  - Reads `schema_evolutions.diff` (lookup via `deps.schemaEvolutionsRepo.findById(job.schema_evolution_id)`).
  - Parses JSON. Validates with a small Zod schema `{ kind: 'copy' | 'constant', target_column, source_column?, value? }`.
  - For `kind='constant'`: `UPDATE <primary_table> SET <target> = ? WHERE id = ? AND <target> IS NULL` with `value`.
  - For `kind='copy'`: `UPDATE <primary_table> SET <target> = <source> WHERE id = ? AND <target> IS NULL`.
  - Returns `{ kind: 'wrote', confidence: 1.0 }` when `db.changes === 1`; `{ kind: 'skipped', reason: 'already_set' }` when `0`.

## 7. Barrel

- [x] 7.1 `src/reextract/index.ts` re-exports.

## 8. Plugin entry + runtime

- [x] 8.1 Modify `src/runtime.ts`: add `stopReextract?: () => void`.
- [x] 8.2 Modify `src/index.ts`: install a `defaultRegistry` with `deriveExistingStrategy`, call `startReextractWorker(deps, { intervalMs: config.reextract.poll_interval_seconds * 1000 })`. Stow the stop handle.

## 9. Tests

- [x] 9.1 `src/reextract/registry.test.ts`: register/get/list; duplicate name throws.
- [x] 9.2 `src/reextract/runner.test.ts`: stub strategy returns `wrote`/`low_confidence`/`failed`/`skipped` for different rows; runner counts correctly; runner aborts on missing strategy.
- [x] 9.3 `src/reextract/worker.test.ts`: `vi.useFakeTimers`; pending job picked + transitioned to running + done. Two jobs queued → second runs after first. `enabled=false` → no timer.
- [x] 9.4 `src/reextract/strategies/derive_existing.test.ts`: constant fill on NULL rows; copy fill; idempotent re-run (already-filled rows return `skipped`); invalid diff JSON → `failed`.

## 10. Integration

- [x] 10.1 `npm run typecheck` clean.
- [x] 10.2 `npm test` all pass.
- [x] 10.3 `openspec validate add-reextract-worker --strict`.
