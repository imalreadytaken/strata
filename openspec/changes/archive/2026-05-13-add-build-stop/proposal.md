## Why

`runBuild` already accepts a `signal: AbortSignal` and checks `abortIfNeeded` between every phase (`src/build/orchestrator.ts:277`). What's missing is any way for the agent / user to **get** that signal: `strata_run_build` doesn't create an `AbortController`, no registry tracks running builds, and there's no `strata_stop_build` tool. So a build that mis-runs (wedged validator, runaway claude session, wrong proposal picked) has to be killed by killing the whole OpenClaw process.

`STRATA_SPEC.md` Week 7 lists "添加 stop/resume 完整支持" as the last engineering deliverable before dogfood. Stop is the half we can ship today; resume requires phase-skipping orchestrator changes and is left to a follow-up.

References: `STRATA_SPEC.md` §9 Week 7 (`stop/resume 完整支持`), `src/build/orchestrator.ts` (existing signal plumbing), `add-build-trigger` (the dispatch surface this builds on).

## What Changes

- New `build-stop` capability covering:
  - **`BuildSessionRegistry`** (in-memory `Map<buildId, { controller: AbortController; startedAt: string; sessionId: string }>`):
    - `register(buildId, controller, sessionId): void` — called by `strata_run_build` when dispatching.
    - `abort(buildId): { stopped: boolean }` — calls `controller.abort()`; returns `false` when the build isn't in the registry.
    - `complete(buildId): void` — drops the entry; called on every terminal status (integrated / failed / cancelled / integration_failed).
    - `get(buildId)`, `list()` for diagnostics + tests.
  - **`strata_stop_build` agent tool**: `{ build_id: number }` → `{ status: 'stopped' | 'not_running' | 'not_found' }`. Resolves the build via `buildsRepo.findById` (so `not_found` is distinct from `not_running`), then calls `registry.abort`. The orchestrator's existing `abortIfNeeded` hook does the rest (marks the row `phase='cancelled'`, returns `BuildRunResultCancelled`).
- Modify `strata_run_build`:
  - Create an `AbortController` per dispatch, register it under the freshly-allocated `build_id`, pass `signal` through `runBuild` and `runIntegration`, and `registry.complete(buildId)` in a `finally` so even thrown exceptions deregister.
  - For backwards compat the tool still works when `buildDeps.buildSessionRegistry` is undefined (skips registration; the build is just un-stoppable).
- Modify `triage-hook`:
  - `STRATA_TOOLS` gains `strata_stop_build`.
  - The build-related templates note the stop tool ("if the user later says 'stop the build', call `strata_stop_build({ build_id })`").

## Capabilities

### New Capabilities
- `build-stop`: in-memory build-session registry + `strata_stop_build` tool.

### Modified Capabilities
- `event-tools`: 10 → 11 tools.
- `triage-hook`: surfaces the new tool to the agent.

## Impact

- **Files added**:
  - `src/build/session_registry.ts` — `BuildSessionRegistry`.
  - `src/build/session_registry.test.ts`.
  - `src/tools/stop_build.ts` — `stopBuildTool` + Zod schema.
  - `src/tools/stop_build.test.ts`.
- **Files modified**:
  - `src/runtime.ts` — constructs `buildSessionRegistry`, attaches to `StrataRuntime`.
  - `src/tools/types.ts` — `BuildToolDeps` gains `buildSessionRegistry?`.
  - `src/tools/run_build.ts` — creates AbortController, registers, passes signal, completes in finally.
  - `src/tools/run_build.test.ts` — cover register + complete; cover stop mid-run via injected runBuild stub.
  - `src/tools/index.ts` + `.test.ts` — 10 → 11 tools.
  - `src/triage/hook.ts` + `.test.ts` — name the new tool.
- **Non-goals**:
  - **Resume.** Punted to a later change — requires the orchestrator to know how to skip already-completed phases AND a tool surface to dispatch with `resume_build_id`. The on-disk state (`claude_session_id` in the builds row) is already preserved, so resume is unlocked when that change lands.
  - **External (cross-process) stop.** Registry is in-process. A separate Strata instance can't stop another's build; the same is true of every other in-memory runtime piece (PendingBuffer, etc.).
  - **Force-kill of in-flight Claude Code subprocess.** The `signal` is already plumbed into `runClaudeCode`; this change just makes that signal reachable. Whatever guarantees `runClaudeCode` provides about subprocess teardown are inherited unchanged.
