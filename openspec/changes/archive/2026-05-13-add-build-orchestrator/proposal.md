## Why

Every Build Bridge piece is now in place — runner, workspace, phases, validator, progress forwarder — but nothing wires them into "given a pending proposal, drive Claude Code through the full sequence and report the outcome." That's the orchestrator's job.

The orchestrator:

1. Looks up the `proposals` row for the requested `proposal_id`.
2. INSERTs a `builds` row with `phase='plan'`, links back to the proposal.
3. Calls `setupBuildWorkspace`, captures `workdir_path` on the row.
4. Runs `plan_phase`; if it produces a non-empty `PLAN.md`, transitions to `phase='decompose'`.
5. Runs `decompose_phase`; captures `changes_total = changeIds.length`.
6. For each change: spawn `claude` in `mode='apply'`, then run `runValidationChecks(...)`. Update `changes_done` and `current_change_id` between iterations.
7. On any unrecoverable failure, transitions `phase='failed'` with a `failure_reason`.
8. On success of all changes, transitions `phase='integrate'` (the integration phase change does the rest).

The orchestrator does NOT yet do integration — that's the next change. It stops at `phase='integrate'` with a structured `BuildRunResult` the integration code consumes.

References: `STRATA_SPEC.md` §5.8.3 (orchestrator overview), §5.8 (whole Build Bridge flow), `add-build-validator` / `add-build-phases` / `add-build-workspace` (consumed here).

## What Changes

- Add `build-orchestrator` capability covering:
  - **`runBuild(opts: RunBuildOptions): Promise<BuildRunResult>`** — top-level coordinator. Takes a `proposalsRepo` / `buildsRepo` / `setupBuildWorkspace` deps bag, plus a `runClaudeCodeForApply` injectable so tests can stub Claude.
  - **`BuildRunResult`** = `{ build_id, status: 'ready_for_integration' | 'failed' | 'cancelled', workdir, plan, changeIds, validationReports, failureReason? }`.
  - **`PhaseRunner`** — an injectable bag `{ runPlanPhase, runDecomposePhase, runApplyPhase, runValidationChecks, setupBuildWorkspace, progressForwarder }` so tests can substitute mocks for each phase without monkey-patching imports.
  - **`runApplyPhase(opts): Promise<ApplyPhaseResult>`** — new but trivial: `runClaudeCode({ mode: 'apply', prompt: '/opsx:apply <changeId>', workdir, … })` + `{ exitCode, eventCount, sessionId }`.
  - State machine writes: every transition stamps `last_heartbeat_at`; failure stamps `failure_reason`; success of the apply loop transitions to `phase='integrate'`.

## Capabilities

### New Capabilities
- `build-orchestrator`: state-machine coordinator for plan → decompose → apply → validate; persists state in `builds` table.

### Modified Capabilities
*(none — consumes prior Build Bridge capabilities)*

## Impact

- **Files added**:
  - `src/build/orchestrator.ts` — `runBuild`, `runApplyPhase`, `BuildRunResult`, `RunBuildOptions`, `PhaseRunner` types.
  - `src/build/orchestrator.test.ts` — happy-path test with all phase runners stubbed; failure paths (plan empty, decompose empty, validation fails).
- **Files modified**:
  - `src/build/index.ts` — re-export.
- **Non-goals**:
  - No retry-on-validation-failure with feedback. Today: one apply + one validate per change; failure aborts. A future change can re-run apply with validation findings as feedback.
  - No interactive plan iteration. The plan is one-shot; if it's empty we fail. User iteration loops via re-running the orchestrator with `resumeBuildId`.
  - No integration. Stops at `phase='integrate'`.
  - No persistence of validation reports inside the DB. They're returned in `BuildRunResult`; the orchestrator's caller (Telegram side) decides whether to persist or just forward.
  - No `paused`/`cancelled` external signalling. The function takes an `AbortSignal`; aborting transitions to `phase='cancelled'`.
