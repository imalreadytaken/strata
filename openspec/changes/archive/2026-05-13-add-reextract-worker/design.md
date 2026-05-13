## Context

`reextract_jobs` exists as a state machine row with counters but no code drains it. We ship the worker as three layered pieces:

1. **Strategy** — a single-row processor. Pure async function over `(row, job, deps)`. Each kind of backfill (derive / re-extract / messages) is its own strategy keyed by `job.strategy`.
2. **Runner** — handles one job: looks up its target rows, iterates with checkpoints, accumulates counters, returns an outcome. No timer, no polling — testable as a one-shot.
3. **Worker** — the `setInterval` loop on top. Picks `pending` jobs one at a time, transitions to `running` → `done`/`failed`, lets the runner do the row-by-row work.

The first strategy (`derive_existing`) is the simplest viable backfill: copy / constant-fill / mapping. It pulls its config from `schema_evolutions.diff` (JSON). LLM strategies land next change.

## Goals / Non-Goals

**Goals:**
- Per-row try/catch — one bad row can't fail the whole job.
- Checkpoint every N rows (`checkpoint_every_rows`) — stops can pick up roughly where they left off.
- Pluggable strategy registry — tests register a fake; production registers `derive_existing` (and later the LLM strategies).
- Worker is idempotent across restarts: a `running` row mid-restart is left alone (the next manual transition can move it to `paused` or `pending`).

**Non-Goals:**
- No partial-resume from the last checkpoint. After a crash the job restarts from row 1; idempotency at the row level (`UPDATE WHERE id = ?`) handles double-writes.
- No multi-job concurrency. `max_concurrent_jobs=1` is the spec's V1 cap.
- No actual `pause` from the worker. We respect `paused` status (skip the row), but won't transition `running → paused` mid-loop without an external signal.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/reextract/types.ts` | new | Interfaces: `ReextractStrategy`, `StrategyOutcome`, `ReextractJobOutcome`, `ReextractRunDeps`. |
| `src/reextract/registry.ts` | new | `ReextractStrategyRegistry` class + module-default singleton. |
| `src/reextract/runner.ts` | new | `runReextractJob(job, deps)`. |
| `src/reextract/worker.ts` | new | `startReextractWorker(deps, opts?)`. |
| `src/reextract/strategies/derive_existing.ts` | new | `deriveExistingStrategy`. |
| `src/reextract/index.ts` | new | Barrel. |
| 5 `*.test.ts` files | new | One per file above. |
| `src/runtime.ts` | modified | `stopReextract?: () => void`. |
| `src/index.ts` | modified | Boot the worker. |
| `src/core/config.ts` | modified | `config.reextract.*` schema. |

## Decisions

### D1 — Strategy result is a tagged union, not a number

Returning a number for confidence + side-channel error is fragile. `{ kind: 'wrote' | 'low_confidence' | 'failed' | 'skipped' }` makes the runner's switch on outcome explicit and exhausively-checked. The spec's "0.7 / 0.3 / less" bands collapse into `wrote` / `low_confidence` / `failed` plus a fourth `skipped` for the cases (job already has this row done, target row missing).

### D2 — `derive_existing` reads its config from `schema_evolutions.diff`

The `schema_evolutions` row that triggered this job carries a `diff` JSON. We define a minimal shape:

```json
{
  "kind": "copy",
  "target_column": "main_category",
  "source_column": "category"
}
```

…or

```json
{
  "kind": "constant",
  "target_column": "currency",
  "value": "CNY"
}
```

Unknown `kind` → strategy returns `failed` for the first row, the runner logs and aborts the job.

### D3 — Per-row `UPDATE … SET <target_column> = ? WHERE id = ? AND <target_column> IS NULL`

The `IS NULL` guard makes the strategy idempotent: a re-run after a crash doesn't overwrite rows that already got their backfill. `rows_done` is only incremented when the UPDATE actually changed a row (we read `db.changes` from better-sqlite3).

### D4 — `pendingJobs.findOne()` via raw SQL, not the repo

The repo has `findMany({ status: 'pending' })` but not "one row, ordered by id." We add a small `pickNextPendingJob(repo): Promise<ReextractJobRow | null>` helper. Picks the lowest `id` to ensure FIFO ordering.

### D5 — Worker swallows ALL exceptions inside the tick

A crashing strategy must not take down `setInterval`. The tick's outer try/catch logs at `error` and stamps the job's `last_error`. The next tick continues. Tests verify this.

### D6 — `config.reextract.enabled = false` → worker is a no-op

When the config disables the worker entirely, `startReextractWorker` returns a no-op stop function and never registers a timer. Used for tests + power users who want to drive backfills manually.

## Risks / Trade-offs

- **Job picks single-row at a time** — could batch, but row writes are O(microseconds) and the strategy may need per-row LLM calls in the next change. Single-row keeps the abstraction uniform.
- **Cost accounting is best-effort** — strategies report `costCents` per row; the runner accumulates into `actual_cost_cents`. Reflect's pattern detector pays for itself elsewhere.
- **No retry on transient LLM failure inside `derive_existing`** — irrelevant; this strategy has no LLM. The next change's LLM strategies own that policy.
