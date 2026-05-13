## 1. Session registry

- [x] 1.1 Create `src/build/session_registry.ts` exporting `BuildSessionRegistry`:
  - `register(buildId, controller, sessionId): void`
  - `abort(buildId): { stopped: boolean }` — calls `.abort()`; returns `{ stopped: false }` when the entry is missing
  - `complete(buildId): void` — drops the entry; no-op when absent
  - `get(buildId): RegistryEntry | undefined`, `list(): RegistryEntry[]`, `size(): number`
- [x] 1.2 `src/build/session_registry.test.ts`:
  - register → get returns the entry.
  - abort on registered entry → controller.signal.aborted is true; returns `{ stopped: true }`.
  - abort on missing entry → `{ stopped: false }`; no throw.
  - complete on missing entry → no throw.
  - complete then abort → `{ stopped: false }`.

## 2. Tool

- [x] 2.1 Create `src/tools/stop_build.ts`:
  - `stopBuildSchema` Zod: `{ build_id: number }`.
  - `stopBuildTool(deps: EventToolDeps): AnyAgentTool`. execute:
    - reject when `deps.buildDeps?.buildSessionRegistry` undefined → return `{ status: 'rejected', failureReason: 'buildSessionRegistry not wired' }`.
    - look up build via `deps.buildDeps.buildsRepo.findById(build_id)`. Missing → `{ status: 'not_found' }`.
    - call `registry.abort(build_id)`. `{ stopped: true }` → `{ status: 'stopped', build_id }`. Else `{ status: 'not_running', build_id, phase: row.phase }`.
- [x] 2.2 `src/tools/stop_build.test.ts`:
  - missing buildDeps → rejected.
  - missing build row → not_found.
  - registry has controller → status='stopped', signal.aborted = true.
  - registry has no controller for an existing row → status='not_running', phase reported.

## 3. Run-build wiring

- [x] 3.1 Modify `src/tools/types.ts`: `BuildToolDeps` gains optional `buildSessionRegistry?: BuildSessionRegistry`.
- [x] 3.2 Modify `src/tools/run_build.ts`:
  - Wrap the body in `try { … } finally { registry?.complete(buildId) }`.
  - Create `const controller = new AbortController()` BEFORE calling `runBuildFn`.
  - When `buildDeps.buildSessionRegistry` is present, call `registry.register(buildId, controller, deps.sessionId)` once the build_id is known. The id only exists after `runBuildFn` inserts the row; we tag the registration immediately after we have the `BuildRunResult.build_id`. Since `runBuildFn` returns a result that includes `build_id`, but we want to make stop effective DURING `runBuildFn`, we instead:
    - **revised approach**: hoist the `buildsRepo.insert` to before `runBuildFn` (NOT in scope here — the orchestrator inserts the row). Instead, register inside `runBuildFn` via a callback. We add an optional `onBuildIdAssigned?: (buildId, controller) => void` to `RunBuildOptions`, populated by `strata_run_build` to call `registry.register`. The orchestrator invokes it once it has the inserted row's id.
  - Pass `signal: controller.signal` through to `runBuildFn` and `runIntegrationFn`.
- [x] 3.3 Modify `src/build/orchestrator.ts`:
  - `RunBuildOptions` gains `onBuildIdAssigned?: (buildId: number) => void`.
  - After `buildsRepo.insert(...)` returns `buildRow.id`, invoke `opts.onBuildIdAssigned?.(buildRow.id)` once.
- [x] 3.4 Modify `src/tools/run_build.test.ts`: assert that when a buildSessionRegistry is supplied AND a phaseRunner stub aborts the signal mid-decompose, the result is `status='cancelled'` AND `registry.complete` was called.

## 4. Index + wiring

- [x] 4.1 Modify `src/tools/index.ts`:
  - Import + register `stopBuildTool` in `buildEventTools` → 11 tools.
  - `registerEventTools` populates `buildDeps.buildSessionRegistry` from `runtime.buildSessionRegistry`.
- [x] 4.2 Modify `src/tools/index.test.ts`: tool count 10 → 11; expected sorted list adds `strata_stop_build`.

## 5. Runtime

- [x] 5.1 Modify `src/runtime.ts`: add `buildSessionRegistry: BuildSessionRegistry` to `StrataRuntime`; instantiate once at boot.

## 6. Triage hook

- [x] 6.1 Modify `src/triage/hook.ts`:
  - `STRATA_TOOLS` gains `strata_stop_build`.
  - The `build_request` template gains a line about how to stop a running build later.
- [x] 6.2 Modify `src/triage/hook.test.ts`: static-block assertion adds `strata_stop_build`.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-build-stop --strict`.
