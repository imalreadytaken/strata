## Why

`add-capability-loader` made capabilities **known** to the runtime; nothing has yet **executed** one. The path between "a `raw_event` row just transitioned to `committed`" and "a row appears in the bound capability's business table" is the pipeline runner — `STRATA_SPEC.md` §5.3.3 sketches it inline inside `commitEventCore`, but the actual code path doesn't exist.

Without this change, `strata_commit_event` flips the status flag and stops; the per-capability business tables stay empty forever. Once this change lands, the next change can ship the `expenses` capability and the loop closes end-to-end: user message → triage → capture → tool → `pending` row → user confirms → `committed` row → pipeline → business row.

References: `STRATA_SPEC.md` §5.3.3 (commit flow), §3.2 (business-table contract), §5.7 + §3.1 (`capability_health` writes), `AGENTS.md` "owner pipeline rule" + business-table required fields.

## What Changes

- Add `pipeline-runner` capability covering:
  - **`PipelineModule`** contract: a capability's `pipeline.ts` MUST export `async function ingest(rawEvent: RawEventRow, deps: PipelineDeps): Promise<PipelineIngestResult>`. `PipelineDeps = { db, logger }`; `PipelineIngestResult = { business_row_id: number; business_table: string }`. We keep the surface minimal so pipelines stay test-isolated.
  - **`runPipeline(loaded, rawEvent, deps): Promise<PipelineIngestResult>`** — resolves `<loaded.path>/<loaded.meta.owner_pipeline>`, `import()`s it with a cache key keyed on `loaded.path` so two boots of the same capability share one module instance, asserts it exports `ingest`, calls it inside a `db.transaction(...)`. On any throw, the transaction rolls back and the error is rewrapped as `STRATA_E_PIPELINE_FAILED`.
  - **`runPipelineForEvent(args): Promise<{ business_row_id: number; capability_written: boolean }>`** — higher-level wrapper that `commitEventCore` calls: looks the capability up in the registry, runs the pipeline, then `rawEventsRepo.update(eventId, { business_row_id, capability_name })` and `capabilityHealthRepo.incrementWrite(name)`. Returns `capability_written: false` and logs (does not throw) when no capability is bound or no pipeline is registered — committing the raw_event is still a valid outcome.
- **Wire into `commitEventCore`**: extend `EventToolDeps` with optional `pipelineDeps` (registry + capabilityHealthRepo + the `runPipelineForEvent` function). When present and the event has a `capability_name`, run the pipeline after the status flip; reflect the result via `CommitEventDetails.capability_written`.

## Capabilities

### New Capabilities
- `pipeline-runner`: imports + executes a capability's `pipeline.ts`, writes the business-table row, links the raw_event to it, bumps capability_health.

### Modified Capabilities
- `event-tools`: `commitEventCore` now runs the bound capability's pipeline after a successful pending → committed transition.

## Impact

- **Files added**:
  - `src/capabilities/pipeline_runner.ts` — `runPipeline` + `runPipelineForEvent` + `PipelineDeps` / `PipelineIngestResult` types.
  - `src/capabilities/pipeline_runner.test.ts` — uses a fake capability emitted into a tmp dir whose `pipeline.ts` exports a deterministic `ingest`. Covers success, missing-pipeline.ts, throw-rolls-back-transaction, unbound-event, idempotent re-commit-on-superseded.
- **Files modified**:
  - `src/tools/types.ts` — `EventToolDeps.pipelineDeps?: PipelineToolDeps`.
  - `src/tools/commit_event.ts` — call `runPipelineForEvent` when deps present; surface `capability_written` honestly.
  - `src/tools/index.ts` — `registerEventTools` builds `pipelineDeps` from the runtime.
  - `src/tools/test_helpers.ts` — accept an optional `pipelineDeps` overrider so tests still pass without a real capability.
  - `src/tools/commit_event.test.ts` — new test: with a fake pipeline injected, a committed event surfaces `capability_written: true` and writes `raw_events.business_row_id`.
- **Non-goals**:
  - No hot reload of pipeline modules. Once `import()`-ed, the same module instance is reused. A future change can add a `forgetCapability(name)` that clears the cache key after a Build Bridge replaces a version.
  - No multi-pipeline-per-event dispatch. The owner-pipeline rule means exactly one pipeline writes per business table; the event's `capability_name` picks it.
  - No retry on transient failure. A failed pipeline leaves the raw_event committed (the user's fact is preserved) but `business_row_id IS NULL`; a future re-extraction worker (P6) can sweep these.
  - No `strata_supersede_event` integration here. Supersede already mutates the new committed row but does not yet re-run pipelines; that's a P3 follow-up if needed.
