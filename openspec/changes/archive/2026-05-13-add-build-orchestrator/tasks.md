## 1. Types

- [x] 1.1 Create `src/build/orchestrator.ts` exporting:
  - `RunBuildOptions` = `{ proposalId: number; sessionId: string; deps: BuildOrchestratorDeps; signal?: AbortSignal }`.
  - `BuildOrchestratorDeps` = `{ buildsRepo, proposalsRepo, capabilities (CapabilityRegistry), capabilityRegistryRepo, agentsMdSource: string, buildsDir: string, maxTurnsPerPhase: number, logger: Logger, progressForwarder?: BuildProgressForwarder, phaseRunner?: PhaseRunner }`.
  - `PhaseRunner` = `{ setupBuildWorkspace, runPlanPhase, runDecomposePhase, runApplyPhase, runValidationChecks }` (each defaults to the real impl).
  - `ApplyPhaseResult` = `{ exitCode, eventCount, sessionId: string | null, stderr }`.
  - `BuildRunResult` discriminated union:
    - `{ status: 'ready_for_integration', build_id, workdir, plan: string, changeIds: string[], validationReports: Record<string, ValidationReport> }`
    - `{ status: 'failed', build_id, failureReason: string, validationReports: Record<string, ValidationReport>, partial: Partial<{ workdir, plan, changeIds }> }`
    - `{ status: 'cancelled', build_id, partial: Partial<...> }`.

## 2. `runApplyPhase`

- [x] 2.1 Export `runApplyPhase(opts: RunApplyPhaseOptions): Promise<ApplyPhaseResult>` calling `runClaudeCode({ mode: 'apply', prompt: '/opsx:apply <changeId>', workdir, maxTurns, onEvent, signal, spawn })`. Captures `sessionId` from first `system` event same as plan_phase.

## 3. `runBuild`

- [x] 3.1 Look up the proposal via `deps.proposalsRepo.findById(opts.proposalId)`. If missing → throw (programmer error).
- [x] 3.2 INSERT a `builds` row: `{ session_id: opts.sessionId, trigger_kind: 'user_request', trigger_proposal_id: proposalId, target_capability: proposal.target_capability ?? '<inferred>', target_action: 'create', phase: 'plan', created_at: now, last_heartbeat_at: now }`.
- [x] 3.3 Call `setupBuildWorkspace(...)`. Update `builds.workdir_path`.
- [x] 3.4 Call `runPlanPhase(...)`. If `planMd === ''` → fail with `'plan_empty'`. Else update `plan_path`, `claude_session_id`, advance `phase='decompose'`.
- [x] 3.5 Call `runDecomposePhase(...)`. If `changeIds.length === 0` → fail with `'decompose_empty'`. Else update `changes_total`, advance `phase='build'`.
- [x] 3.6 For each changeId:
  - Update `current_change_id`.
  - Call `runApplyPhase`. Non-zero exit → fail with `'apply_failed_<changeId>'`.
  - Compute `capabilityName` from `workdir/openspec/changes/<id>/specs/*/spec.md` or by scanning `workdir/capabilities/`; pass to validator.
  - Call `runValidationChecks(...)`. `!ok` → fail with `'validation_failed_<changeId>'`. Else `changes_done++`.
- [x] 3.7 On all changes ok → `phase='integrate'`, `last_heartbeat_at=now`, return `{ status: 'ready_for_integration', ... }`.
- [x] 3.8 On AbortSignal at any point → mark `phase='cancelled'`, return `{ status: 'cancelled', ... }`.

## 4. Progress forwarder hooks

- [x] 4.1 Modify `src/build/progress_forwarder.ts`: add optional `onPhase(name: string): void` method on `BuildProgressForwarder` that enqueues `'📍 phase: <name>'`. Existing tests unaffected.
- [x] 4.2 In `runBuild`, call `deps.progressForwarder?.onPhase('plan' | 'decompose' | 'apply' | 'validate' | 'integrate')` at each transition.

## 5. Tests

- [x] 5.1 `src/build/orchestrator.test.ts`:
  - Happy path: stub `PhaseRunner` so plan returns a non-empty md, decompose returns `['a']`, apply succeeds, validation `ok: true`. Result has `status='ready_for_integration'`. `builds` row ends at `phase='integrate'`, `changes_done=1`.
  - Empty plan: stub plan to return `planMd=''`. Result `status='failed'`, `failureReason='plan_empty'`. Row at `phase='failed'`.
  - Empty decompose: stub decompose to return `changeIds=[]`. `failureReason='decompose_empty'`.
  - Apply failure: stub apply to return `exitCode: 1`. `failureReason='apply_failed_a'`. Validation NOT called.
  - Validation failure: stub validation to return `{ ok: false, findings: [{...}] }`. `failureReason='validation_failed_a'`.
  - AbortSignal: signal aborted before plan phase. Result `status='cancelled'`. Row `phase='cancelled'`.
  - Multi-change happy path: decompose returns `['a','b','c']`; all three pass apply + validate. `changes_done=3`, row at `integrate`.
  - `onPhase` callbacks: verify the orchestrator calls a stub forwarder's `onPhase` for each transition.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` all pass.
- [x] 6.3 `openspec validate add-build-orchestrator --strict`.
