## Why

Build Bridge has every layer shipped (runner, workspace, phases, validator, orchestrator, integration, progress forwarder) but **no trigger**. The agent can record a build request via `strata_propose_capability`, the Reflect callback can flip the proposal to `'approved'`, but nothing actually calls `runBuild(...)`. The capability is dead code until something drives it.

`strata_run_build({ proposal_id })` is the simplest viable trigger: an agent-callable tool that runs the full chain (`runBuild` → optional `runIntegration`) and returns the outcome. The user — or an `'approved'`-state proposal — can dispatch a build through normal conversation, the same way they confirm a pending event.

References: `STRATA_SPEC.md` §5.8 (Build Bridge overview), `add-build-orchestrator` (provides `runBuild`), `add-build-integration` (provides `runIntegration`), `add-build-skill` (records the user's intent into `proposals`).

## What Changes

- Add `build-trigger` capability covering:
  - **`strata_run_build` agent tool**: parameters `{ proposal_id: number }`. Looks up the proposal; if `status !== 'approved'` AND `status !== 'pending'`, refuses with a clear error. Otherwise calls `runBuild(...)`. If the result's `status === 'ready_for_integration'`, immediately calls `runIntegration(...)`. Returns `{ build_id, status: 'integrated' | 'orchestrator_failed' | 'integration_failed' | 'cancelled', failureReason?, integrated? }`.
  - **`EventToolDeps.buildDeps`** optional field carrying every dep `runBuild` + `runIntegration` need: `buildsRepo`, `capabilityHealthRepo`, `schemaEvolutionsRepo`, `capabilities`, `agentsMdSource` (caller supplies), `buildsDir`, `userCapabilitiesDir`, `maxTurnsPerPhase`, `progressForwarder?`. Optional so unit-test harnesses can omit; production wires from runtime.
  - **`registerEventTools` extension**: the new tool registers alongside the seven existing ones (factory result goes from 7 → 8 tools).
  - **Plugin entry wiring**: `register(api)` populates `runtime.buildToolDeps` (or threads via `registerEventTools`).

## Capabilities

### New Capabilities
- `build-trigger`: agent-callable end-to-end build dispatcher tool.

### Modified Capabilities
- `event-tools`: registers an 8th tool (`strata_run_build`).

## Impact

- **Files added**:
  - `src/tools/run_build.ts` — `runBuildTool(deps)`, schema, `RunBuildToolDetails`.
  - `src/tools/run_build.test.ts` — happy path (orchestrator+integration both succeed); orchestrator failure path; integration failure path; missing proposal; refusing a non-approvable status.
- **Files modified**:
  - `src/tools/types.ts` — `EventToolDeps.buildDeps` optional bag.
  - `src/tools/index.ts` — `buildEventTools` returns 8 tools; `registerEventTools` builds the bag from the runtime.
  - `src/tools/test_helpers.ts` — harness builds an empty `buildDeps` shape; tests that exercise the tool pass their own.
  - `src/tools/index.test.ts` — expected names + count updated.
  - `src/callbacks/index.ts` — `baseDeps` carries `buildDeps` so a future "approve via callback → run build" path can be wired.
- **Non-goals**:
  - No auto-build on Reflect approval. A future tiny change can listen for `proposals.status='approved'` and dispatch; for V1 the user calls the tool explicitly.
  - No build-status query tool. The DB row + `pushed_to_user_at` are queryable manually; a future `strata_query_build` tool can wrap it.
  - No async / queued execution. The tool awaits the full chain (minutes for a real Claude Code run). Acceptable: the agent's normal long-tool-call path handles it.
