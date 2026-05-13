## Context

`STRATA_SPEC.md` §5.3.3 shows the commit-time logic that should run a pipeline:

```ts
if (event.capability_name) {
  const { runPipeline } = await import('../capabilities/pipeline_runner');
  await runPipeline(event.capability_name, event);
}
```

The hand-wave there hides three real decisions: where the pipeline module comes from on disk, what surface it exports, and how its work interacts with the just-committed `raw_events` row. The fourth concern — what to do when the pipeline throws — is the most important: the commit must still succeed (the user's fact is preserved) but the business-table row must not exist (no partial writes).

`add-capability-loader` already gave us `LoadedCapability { meta, path, metaPath }`. The runner takes that record + a `RawEventRow` + minimal deps, dynamically imports `<path>/<meta.owner_pipeline>`, and calls its `ingest` export.

## Goals / Non-Goals

**Goals:**
- The pipeline contract is **one function**: `export async function ingest(rawEvent, deps): Promise<{ business_row_id, business_table }>`. Anything beyond that is overfit.
- The entire pipeline runs inside `db.transaction(...)`. If the pipeline throws, the raw_event's `committed` status flip is **separate** (it happened before the pipeline) so it does NOT roll back — but the partial business-table write does.
- A failed pipeline does **not** propagate up to the agent. We log at `error`, leave `business_row_id` null, and return `capability_written: false`. The user gets a successful commit; an operator can reconcile later.
- Module cache is keyed on the capability's `path` (e.g. `~/.strata/capabilities/expenses/v2`). Two pipeline runs for the same capability share one module instance. A version bump (new directory) is a new cache key.
- Tests use a real on-disk fake capability emitted into a tmp dir — exercises the dynamic-import path end-to-end rather than monkey-patching imports.

**Non-Goals:**
- No batch / streaming pipelines. One `ingest` per `raw_event`.
- No tool/skill access from inside a pipeline. The deps bag is `{ db, logger }`. Pipelines write to one business table (the owner-pipeline rule); they don't call the model, send messages, or schedule jobs.
- No async dispatch. The pipeline runs synchronously inside `commitEventCore`. If it takes more than a few hundred ms, that's the capability author's problem — for V1 we treat pipelines as fast database transforms.
- No hot reload of `pipeline.ts` after a Build Bridge run. The Integration phase (P4) will explicitly call a `forgetCapability(name)` followed by a fresh `loadCapabilities` — out of scope here.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/capabilities/pipeline_runner.ts` | new | `PipelineDeps`, `PipelineIngestResult`, `PipelineModule` types; `runPipeline(loaded, rawEvent, deps)` (low-level: import + invoke + transaction); `runPipelineForEvent(args)` (high-level: takes registry + event id, does the lookup + side effects on `raw_events` + `capability_health`). |
| `src/capabilities/pipeline_runner.test.ts` | new | Uses `fs` to emit a tmp capability whose `pipeline.ts` exports a deterministic `ingest`. Covers happy path, missing pipeline file, throw-rolls-back-business-write, unbound event (no capability_name), bound-but-not-loaded event. |
| `src/capabilities/index.ts` | modified | Re-export the new public surfaces. |
| `src/tools/types.ts` | modified | Adds `pipelineDeps?: PipelineToolDeps` to `EventToolDeps`. |
| `src/tools/commit_event.ts` | modified | After the status flip, when `pipelineDeps` is present and `event.capability_name` is set, call `runPipelineForEvent`. Surface `capability_written` honestly. |
| `src/tools/index.ts` | modified | `registerEventTools` constructs `pipelineDeps` from the runtime (registry + capabilityHealthRepo + a closure binding `runPipelineForEvent`). |
| `src/tools/test_helpers.ts` | modified | `makeHarness` accepts an optional `pipelineDeps` arg; defaults to `undefined` so existing tests still pass. |
| `src/tools/commit_event.test.ts` | modified | New case: with a fake pipeline injected, `capability_written` is `true` and the business row links back via `raw_events.business_row_id`. |

## Decisions

### D1 — Pipeline runs **after** the status flip; failure does not roll back the commit

Sequence inside `commitEventCore`:

1. `update(eventId, { status: 'committed', committed_at })` ← always.
2. `pendingBuffer.remove` ← best-effort.
3. If `event.capability_name` & `pipelineDeps`: `runPipelineForEvent(...)`.
4. Return.

Step 3 may throw. The throw is caught, logged at `error`, and the result reports `capability_written: false`. The committed row remains — the user's fact is preserved even when the business-table write fails. This matches the spec's "raw_events is append-only, business tables are downstream views" philosophy.

If we put step 3 inside a single transaction with step 1, a buggy pipeline would force the user to re-confirm the same event after we fix the bug. That's worse UX than "commit is permanent; business row is reconciled later by the re-extraction worker."

### D2 — Pipeline body runs in a `db.transaction(...)` so its OWN writes are atomic

The pipeline can do multiple `INSERT`s (some business tables have child rows). We wrap `pipeline.ingest(...)` in `db.transaction(...)` so a mid-run throw rolls back its partial writes. The transaction does NOT include the `raw_events.business_row_id` update — that happens after the pipeline returns its `business_row_id`, in a separate statement.

### D3 — `import()` cache key is the capability's resolved path

We compute `pipelinePath = path.join(loaded.path, loaded.meta.owner_pipeline)`. The dynamic `import(pipelinePath)` is naturally cached by Node's module loader. If the same capability is requested again, Node returns the same module instance. For a version bump, `loaded.path` changes (e.g. `.../expenses/v1` → `.../expenses/v2`), so the cache key changes — fresh module.

We do **not** maintain our own cache map. Node's loader is the source of truth.

### D4 — Pipeline file must export `ingest` (function); anything else throws

The runner does:

```ts
const mod = (await import(pipelinePath)) as Partial<PipelineModule>;
if (typeof mod.ingest !== "function") {
  throw new ValidationError(
    "STRATA_E_PIPELINE_INVALID",
    `${pipelinePath} must export an async function 'ingest'`,
  );
}
```

A capability that ships without a usable `pipeline.ts` is a packaging bug — surfacing it as `STRATA_E_PIPELINE_INVALID` at first invocation (with the full path) is more debuggable than a generic `is not a function` from inside `mod.ingest(...)`. The loader doesn't pre-validate this because not all capabilities will have pipelines (a "skill-only" capability is conceivable in the future); we only check when we're about to actually run one.

### D5 — `runPipelineForEvent` is the one `commit_event.ts` calls

`commit_event.ts` should not see `import()` at all. The high-level wrapper:

```ts
async function runPipelineForEvent(args: {
  rawEvent: RawEventRow;
  registry: CapabilityRegistry;
  rawEventsRepo: RawEventsRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  logger: Logger;
}): Promise<{ capability_written: boolean; business_row_id?: number }>
```

handles the "is it bound?" + "is it loaded?" + "run + update raw_events + bump health" sequence. Returns `capability_written: false` on any miss (logged, not thrown). Tests can substitute a mock runner via the `pipelineDeps.runForEvent` indirection, but the default constructor wires the real one.

### D6 — Skipped: `strata_supersede_event` pipeline re-run

When a committed event gets superseded, the *new* committed row could in principle also run the pipeline (updating the existing business row, or inserting a "correction" row). The mapping is genuinely subtle (does the pipeline check `supersedes_event_id` and update vs insert?). We leave this to a follow-up change. `strata_supersede_event` continues to write the new raw_event without invoking the pipeline. The supersede chain is preserved; reconciliation logic is the next vertical decision.

### D7 — Pipeline deps include `now()` for testability

`PipelineDeps = { db, logger, now: () => string }`. Default `now` is `() => new Date().toISOString()`. Capability authors who want deterministic timestamps for tests can pass their own. Mirrors `SQLiteRepositoryOptions.now`.

## Risks / Trade-offs

- **Pipeline runs synchronously inside the tool execute.** If a pipeline is slow (network calls, big writes), every commit waits. Reasonable as a V1 constraint; if it bites we add an async-queue mode behind an opt-in `meta.json` flag.
- **Module caching means a pipeline that mutates module-level state across calls will leak.** Pipelines should be functional in style; if one needs per-process state it should live in `globalThis.<unique-key>` and the pipeline author owns the lifecycle. We document this in the pipeline contract section of `AGENTS.md` in a future change.
- **A failed pipeline silently leaves `business_row_id IS NULL`.** Operators learn about this via logs + the planned re-extraction worker. We don't surface it to the agent because there's no useful action the agent can take.
