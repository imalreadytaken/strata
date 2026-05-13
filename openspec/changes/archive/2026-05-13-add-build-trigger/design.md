## Context

Build Bridge's bottom-to-top stack is done. The missing link is "an agent reaches in and says `runBuild(proposal_id)`." Two questions to answer:

1. **Where does the tool fit?** Among the existing `strata_*` tools (which write to `raw_events` + `proposals`). The tool surface stays uniform: `registerEventTools` registers all of them via one factory.
2. **What's a "successful" build from the tool's perspective?** Just running `runBuild` returns `'ready_for_integration'` — but the integration phase is what actually makes the capability live. The tool should run both, with the outcome reflecting the combined state.

We avoid making this a second registration path. The new tool fits naturally next to the other `strata_*` ones; the `buildDeps` bag on `EventToolDeps` is the surface for the build-specific dependencies.

## Goals / Non-Goals

**Goals:**
- One tool. One end-to-end call. Returns a tagged outcome.
- The tool refuses gracefully when the proposal isn't dispatchable (already applied, declined, expired).
- Tests exercise every failure path with stubs — no real Claude.
- `EventToolDeps.buildDeps?` is optional; existing tests that don't care don't break.

**Non-Goals:**
- No async / queued execution. A future "fire and forget + poll" tool can wrap.
- No automatic dispatch when a proposal flips to `'approved'`. The user (or a future tiny change) decides when to run.
- No retry on failure. The user re-invokes the tool if they want.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/tools/run_build.ts` | new | `runBuildTool(deps)`, Zod schema, `RunBuildToolDetails`. |
| `src/tools/run_build.test.ts` | new | Stubbed `runBuild` + `runIntegration` to exercise each outcome. |
| `src/tools/types.ts` | modified | Add `buildDeps?: BuildToolDeps` to `EventToolDeps`. |
| `src/tools/index.ts` | modified | Register the new tool. |
| `src/tools/index.test.ts` | modified | Tool count 7 → 8. |
| `src/tools/test_helpers.ts` | modified | Harness exposes an `attachBuildDeps()` knob. |
| `src/callbacks/index.ts` | modified | Pass `buildDeps` through too (forward-compat). |

## Decisions

### D1 — One tool composes runBuild + runIntegration

A two-tool surface (`strata_run_build_orchestrator` + `strata_run_build_integrate`) is more flexible but vastly more error-prone for the agent. Combining them into one matches user expectations ("run the build") and gives the agent a single success signal.

### D2 — Tool refuses non-dispatchable proposals

Acceptable statuses: `'pending'`, `'approved'`. Anything else (`'applied'`, `'declined'`, `'expired'`) returns an error without spawning. Tests pin this.

### D3 — Failure modes are tagged on `RunBuildToolDetails.status`

`'integrated'` (full success), `'orchestrator_failed'` (runBuild returned `'failed'`), `'integration_failed'` (runBuild ok, integration failed), `'cancelled'` (caller-aborted at orchestrator level). The agent can quote the tag back to the user.

### D4 — Deps bag is injectable; runtime wires defaults

`runBuildTool({ ...eventDeps, buildDeps })` where `buildDeps` is required for the tool but optional on `EventToolDeps`. If the runtime is incomplete (e.g., a unit test that builds an event-tools-only harness), the tool returns a clear error rather than crashing.

### D5 — Progress forwarder is the runtime's job to inject

`buildDeps.progressForwarder` flows from `runtime.progressForwarder` (when set). For V1 the runtime doesn't auto-create one; tests can pass their own.

## Risks / Trade-offs

- **Long-running tool call** — a real Claude Code build is minutes. The agent's framework already supports it; user sees progress via the forwarder.
- **No retry / resume** — if the orchestrator fails mid-way, the user re-invokes the tool. The orchestrator's `builds` row stays as audit trail.
- **buildDeps wiring is verbose** — eight repos + paths. Acceptable cost for the surface clarity.
