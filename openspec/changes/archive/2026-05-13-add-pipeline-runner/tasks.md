## 1. Pipeline contract types

- [x] 1.1 Create `src/capabilities/pipeline_runner.ts` exporting:
  - `PipelineDeps = { db: Database, logger: Logger, now: () => string }`.
  - `PipelineIngestResult = { business_row_id: number; business_table: string }`.
  - `PipelineModule = { ingest: (rawEvent: RawEventRow, deps: PipelineDeps) => Promise<PipelineIngestResult> }`.
  - `PipelineToolDeps = { registry: CapabilityRegistry; rawEventsRepo: RawEventsRepository; capabilityHealthRepo: CapabilityHealthRepository; logger: Logger; now?: () => string }`.

## 2. Low-level runner

- [x] 2.1 Export `runPipeline(loaded: LoadedCapability, rawEvent: RawEventRow, deps: PipelineDeps): Promise<PipelineIngestResult>`:
  - Compute `pipelinePath = path.join(loaded.path, loaded.meta.owner_pipeline)`.
  - `import()` the file. On import failure, throw `STRATA_E_PIPELINE_INVALID` with the path.
  - Assert `typeof mod.ingest === 'function'`. Otherwise `STRATA_E_PIPELINE_INVALID`.
  - Wrap `mod.ingest(rawEvent, deps)` in `db.transaction(...)`. Re-throw with `STRATA_E_PIPELINE_FAILED` (keep original `cause`).
  - Return the pipeline's result unchanged.

## 3. High-level runner

- [x] 3.1 Export `runPipelineForEvent(args)`:
  - `args: { rawEvent: RawEventRow; toolDeps: PipelineToolDeps }`.
  - If `rawEvent.capability_name` is null → return `{ capability_written: false }`.
  - Look the capability up in `args.toolDeps.registry`. If missing → log `warn` and return `{ capability_written: false }`.
  - Call `runPipeline(loaded, rawEvent, { db, logger, now })`. Wrap in try/catch: on throw, log at `error`, return `{ capability_written: false }`.
  - On success, `rawEventsRepo.update(rawEvent.id, { business_row_id: result.business_row_id })`.
  - Call `capabilityHealthRepo.incrementWrite(rawEvent.capability_name)`.
  - Return `{ capability_written: true, business_row_id: result.business_row_id }`.

## 4. Wire into `commitEventCore`

- [x] 4.1 Modify `src/tools/types.ts`:
  - Add `pipelineDeps?: PipelineToolDeps` to `EventToolDeps`.
- [x] 4.2 Modify `src/tools/commit_event.ts::commitEventCore`:
  - After the status flip + buffer remove, if `current.capability_name && deps.pipelineDeps`, call `runPipelineForEvent({ rawEvent: updated, toolDeps: deps.pipelineDeps })`.
  - Reflect the result in `CommitEventDetails.capability_written`.
- [x] 4.3 Modify `src/tools/index.ts::registerEventTools`:
  - When building deps for each session, populate `pipelineDeps = { registry: runtime.capabilities, rawEventsRepo: runtime.rawEventsRepo, capabilityHealthRepo: runtime.capabilityHealthRepo, logger: runtime.logger }`.

## 5. Test helpers

- [x] 5.1 Modify `src/tools/test_helpers.ts`:
  - `makeHarness({ sessionId, pipelineDeps? }) → TestHarness` (optional field).
  - When `pipelineDeps` provided, attach to `deps.pipelineDeps`.

## 6. Tests

- [x] 6.1 `src/capabilities/pipeline_runner.test.ts` (≥ 6 cases):
  - **Happy path**: emit a fake capability dir (`meta.json` + `pipeline.ts` that exports `ingest` writing one row to a tmp business table). Call `runPipelineForEvent` against a registry containing that capability + a `capability_name`-bound `rawEvent`. Asserts: business row exists, `raw_events.business_row_id` linked, `capability_health.total_writes` is 1, returned `capability_written: true`.
  - **Missing pipeline.ts**: emit a capability without `pipeline.ts`. `runPipelineForEvent` returns `{ capability_written: false }` and logs at `error`. Does not throw.
  - **Pipeline throws**: emit a `pipeline.ts` whose `ingest` always throws. Returns `{ capability_written: false }`. Business table stays empty. `raw_events.business_row_id` stays null.
  - **Pipeline partial write rolls back**: emit a `pipeline.ts` that inserts two rows where the second one violates a CHECK. The transaction must roll back the first INSERT (assert business-table row count is 0).
  - **No capability_name**: `runPipelineForEvent` on a `raw_event` with `capability_name=null` returns `{ capability_written: false }` immediately (no logs at warn/error).
  - **Bound to a capability not in the registry**: `capability_name='unknown'` → returns `{ capability_written: false }` and logs at `warn`.
- [x] 6.2 Update `src/tools/commit_event.test.ts`:
  - One new case: with a fake pipeline injected via `pipelineDeps`, a committed event surfaces `capability_written: true` and `raw_events.business_row_id` is set.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` — all tests pass.
- [x] 7.3 `openspec validate add-pipeline-runner --strict`.
