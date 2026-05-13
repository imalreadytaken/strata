## 1. Types

- [x] 1.1 Modify `src/tools/types.ts`: add `BuildToolDeps` interface and `EventToolDeps.buildDeps?: BuildToolDeps`. `BuildToolDeps` contains `{ buildsRepo, capabilityHealthRepo, schemaEvolutionsRepo, capabilities (CapabilityRegistry), agentsMdSource: string, buildsDir: string, userCapabilitiesDir: string, maxTurnsPerPhase: number, progressForwarder?: BuildProgressForwarder, runBuild?, runIntegration? }` (last two for testability defaults).

## 2. Tool

- [x] 2.1 Create `src/tools/run_build.ts` exporting:
  - `runBuildSchema = z.object({ proposal_id: z.number().int().positive() })`.
  - `RunBuildToolDetails = { build_id?: number; status: 'integrated' | 'orchestrator_failed' | 'integration_failed' | 'cancelled' | 'rejected'; failureReason?: string; integrated?: string[] }`.
  - `runBuildTool(deps: EventToolDeps): AnyAgentTool`. Refuses (returns `status: 'rejected'`) when `deps.buildDeps` is undefined. Otherwise:
    - Look up the proposal; refuse on `status NOT IN { 'pending', 'approved' }`.
    - Resolve `runBuild` + `runIntegration` from `buildDeps` (default to the real implementations).
    - Call `runBuild({ proposalId, sessionId: <stable>, deps: { ... } })`. Map `'failed'` / `'cancelled'` to tool-side status.
    - On `'ready_for_integration'`: call `runIntegration({ buildResult, deps: { ... } })`. Map outcome.
    - Return `payloadTextResult(details)`.

## 3. Wiring

- [x] 3.1 Modify `src/tools/index.ts`: import + register `runBuildTool` in `buildEventTools`. Update `registerEventTools` to populate `buildDeps` from the runtime (`runtime.buildsRepo`, `runtime.capabilityHealthRepo`, `runtime.schemaEvolutionsRepo`, `runtime.capabilities`, `runtime.config.paths.capabilitiesDir`, `runtime.config.paths.buildsDir`, AGENTS.md text via a static import, etc.).
- [x] 3.2 Modify `src/tools/index.test.ts`: expect 8 tools (sorted list includes `strata_run_build`).
- [x] 3.3 Modify `src/callbacks/index.ts`: pass `buildDeps` through `baseDeps` for forward-compat (the callback handler itself doesn't yet use it).

## 4. AGENTS.md text source

- [x] 4.1 `src/tools/index.ts` (or a helper): expose a `loadAgentsMdSource()` that reads `openspec/AGENTS.md` relative to the plugin source root and caches the string. The tool's `buildDeps.agentsMdSource` is whatever the runtime supplies; for tests, callers pass a fixture string.

## 5. Tests

- [x] 5.1 `src/tools/run_build.test.ts`:
  - Happy path: stubbed `runBuild` returns `'ready_for_integration'`, stubbed `runIntegration` returns `'integrated'`. Tool returns `status: 'integrated'` with the build_id + integrated names.
  - Orchestrator failure: stubbed `runBuild` returns `{ status: 'failed', failureReason: 'plan_empty' }`. Tool returns `status: 'orchestrator_failed'`, surfaces the reason.
  - Integration failure: stubbed `runBuild` ok, stubbed `runIntegration` returns `'failed'`. Tool returns `status: 'integration_failed'`.
  - Cancellation: stubbed `runBuild` returns `'cancelled'`. Tool returns `status: 'cancelled'`.
  - Rejected: deps.buildDeps undefined → `status: 'rejected'`, reason names the missing deps.
  - Wrong proposal status: pre-set proposal to `'declined'` → `status: 'rejected'`, reason names the status.
  - Missing proposal id → `status: 'rejected'`, reason references the id.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` all pass.
- [x] 6.3 `openspec validate add-build-trigger --strict`.
