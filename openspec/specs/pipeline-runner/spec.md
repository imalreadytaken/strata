# pipeline-runner Specification

## Purpose

`pipeline-runner` is the bridge between a committed `raw_event` row and its capability's business table. `runPipeline(loaded, rawEvent, deps)` dynamically imports `<loaded.path>/<owner_pipeline>` and invokes its `ingest` export inside a SQLite transaction so a mid-flight throw rolls back partial writes. `runPipelineForEvent({ rawEvent, toolDeps })` is the wrapper `commitEventCore` calls: it handles unbound events (`capability_name=null`), unknown capabilities (warn + skip), and pipeline failures (error log + skip) by returning `{ capability_written: false }` — the underlying commit always succeeds, preserving the user's fact even when the business-table side-effect fails. On success, the runner links `raw_events.business_row_id` and bumps `capability_health.total_writes`.

## Requirements
### Requirement: Pipeline module contract

Each capability that owns a business table SHALL ship a `pipeline.ts` (or other module named by `meta.owner_pipeline`) exporting an async function:

```ts
export async function ingest(
  rawEvent: RawEventRow,
  deps: { db: Database; logger: Logger; now: () => string },
): Promise<{ business_row_id: number; business_table: string }>;
```

The `ingest` function reads the raw event's `extracted_data` JSON, writes one or more rows into the capability's business table (honoring AGENTS.md hard constraints #2–#4 — money in minor units, ISO 8601 with timezone, required `raw_event_id` / `extraction_version` / etc.), and returns the inserted **primary** business row's id plus the table name.

#### Scenario: A valid pipeline returns a business_row_id and a table name

- **WHEN** `runPipeline(loaded, rawEvent, deps)` is called against a capability whose `pipeline.ts` writes one row and returns `{ business_row_id: 7, business_table: 'expenses' }`
- **THEN** the result is `{ business_row_id: 7, business_table: 'expenses' }` and the corresponding row exists in `expenses`

### Requirement: `runPipeline` resolves and invokes the pipeline inside a transaction

The system SHALL export `runPipeline(loaded: LoadedCapability, rawEvent: RawEventRow, deps: PipelineDeps): Promise<PipelineIngestResult>` that:

1. Resolves `pipelinePath = path.join(loaded.path, loaded.meta.owner_pipeline)`.
2. `import()`s the module. On import failure, throws `STRATA_E_PIPELINE_INVALID` referencing the path.
3. Verifies `typeof mod.ingest === 'function'`; otherwise throws `STRATA_E_PIPELINE_INVALID`.
4. Wraps `mod.ingest(rawEvent, deps)` in a `db.transaction(...)`. Any throw inside `ingest` rolls back its DB mutations and is rethrown as `STRATA_E_PIPELINE_FAILED` (preserving `cause`).
5. Returns the pipeline's `PipelineIngestResult` on success.

#### Scenario: Pipeline write inside the transaction commits atomically

- **WHEN** a pipeline `INSERT`s two rows that both succeed
- **THEN** both rows are visible after `runPipeline` resolves

#### Scenario: Pipeline throw rolls back partial writes

- **WHEN** a pipeline `INSERT`s one valid row then throws before the second
- **THEN** the first row is rolled back (the business table is empty) and the error is rethrown as `STRATA_E_PIPELINE_FAILED`

#### Scenario: Missing `pipeline.ts` throws STRATA_E_PIPELINE_INVALID

- **WHEN** `runPipeline` runs against a capability whose `path/pipeline.ts` does not exist
- **THEN** it throws an error with code `STRATA_E_PIPELINE_INVALID` and the message references the path

#### Scenario: Module without an `ingest` export throws STRATA_E_PIPELINE_INVALID

- **WHEN** the resolved `pipeline.ts` does not export a function named `ingest`
- **THEN** it throws `STRATA_E_PIPELINE_INVALID`

### Requirement: `runPipelineForEvent` reconciles raw_events + capability_health

The system SHALL export `runPipelineForEvent(args: { rawEvent, toolDeps: PipelineToolDeps }): Promise<{ capability_written: boolean; business_row_id?: number }>` that:

- Returns `{ capability_written: false }` immediately when `rawEvent.capability_name` is null.
- Returns `{ capability_written: false }` with a `warn` log when the registry does not contain the bound capability.
- On a successful `runPipeline` call:
  - Calls `rawEventsRepo.update(rawEvent.id, { business_row_id })`.
  - Calls `capabilityHealthRepo.incrementWrite(rawEvent.capability_name)`.
  - Returns `{ capability_written: true, business_row_id }`.
- On a `runPipeline` throw, catches the error, logs at `error`, and returns `{ capability_written: false }` (the committed raw_event remains; the operator/re-extraction worker reconciles later).

#### Scenario: Unbound raw_event short-circuits

- **WHEN** `runPipelineForEvent` runs against a raw_event with `capability_name=null`
- **THEN** the result is `{ capability_written: false }` and neither warn nor error logs are recorded

#### Scenario: Bound but unknown capability logs warn and short-circuits

- **WHEN** `rawEvent.capability_name = 'unknown_thing'` and the registry is empty
- **THEN** the result is `{ capability_written: false }`, a `warn` log records the missing capability, and no transaction runs

#### Scenario: Pipeline success links raw_event and bumps capability_health

- **WHEN** a happy-path pipeline writes a row with `business_row_id=7`
- **THEN** `raw_events.business_row_id=7`, `capability_health.total_writes=1`, and the result is `{ capability_written: true, business_row_id: 7 }`

#### Scenario: Pipeline failure does NOT propagate to commit

- **WHEN** the pipeline throws
- **THEN** `runPipelineForEvent` returns `{ capability_written: false }`, a `error`-level log records the failure, and the underlying `raw_events` row remains `status='committed'`

