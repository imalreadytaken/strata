## ADDED Requirements

### Requirement: `runBuild` coordinates plan → decompose → apply → validate phases

The system SHALL export `runBuild(opts: RunBuildOptions): Promise<BuildRunResult>` that:

1. Looks up the proposal by `opts.proposalId`. Missing proposal → throws (programmer error).
2. INSERTs a `builds` row with `phase='plan'`, `trigger_kind='user_request'`, `trigger_proposal_id=proposalId`, `created_at=now`.
3. Calls `setupBuildWorkspace(...)` and stores `workdir_path` on the row.
4. Calls `runPlanPhase(...)`. On `planMd === ''` → fail; else store `plan_path`, `claude_session_id`, advance to `phase='decompose'`.
5. Calls `runDecomposePhase(...)`. On `changeIds.length === 0` → fail; else store `changes_total`, advance to `phase='build'`.
6. For each changeId: store `current_change_id`, call `runApplyPhase(...)` (fail on non-zero exit), call `runValidationChecks(...)` (fail when `ok: false`), increment `changes_done`.
7. After all changes pass → `phase='integrate'`, return `{ status: 'ready_for_integration', ... }`.

The function MUST update `last_heartbeat_at` on every phase transition. The function MUST NOT throw on phase failures — it transitions to `phase='failed'` with a `failure_reason` and returns `{ status: 'failed', failureReason, ... }`.

`failureReason` values: `'plan_empty'`, `'decompose_empty'`, `'apply_failed_<changeId>'`, `'validation_failed_<changeId>'`, `'aborted'`.

#### Scenario: Happy path leaves the build at phase='integrate'

- **WHEN** stubbed phase runners return `planMd='# Plan'`, `changeIds=['a']`, `apply exitCode=0`, `validation { ok: true }`
- **THEN** the result is `{ status: 'ready_for_integration', build_id, workdir, plan: '# Plan', changeIds: ['a'], validationReports: { a: { ok: true, ... } } }` and the `builds` row has `phase='integrate'`, `changes_done=1`, `changes_total=1`

#### Scenario: Empty plan transitions to failed

- **WHEN** the plan phase returns `planMd=''`
- **THEN** the result is `{ status: 'failed', failureReason: 'plan_empty', ... }` and the `builds` row has `phase='failed'`

#### Scenario: Empty decompose transitions to failed

- **WHEN** decompose returns `changeIds: []`
- **THEN** `failureReason='decompose_empty'`

#### Scenario: Apply failure short-circuits validation

- **WHEN** `runApplyPhase` returns `exitCode: 1` for change `'a'`
- **THEN** `failureReason='apply_failed_a'`, the validator is NOT called for `'a'`, and `changes_done=0`

#### Scenario: Validation failure stops further apply iterations

- **WHEN** validation for change `'a'` returns `{ ok: false, findings: [...] }`
- **THEN** `failureReason='validation_failed_a'`, the validator's report appears in `validationReports['a']`, and any later changes are NOT applied

#### Scenario: AbortSignal cancels the build

- **WHEN** `opts.signal` is aborted before the plan phase
- **THEN** the result is `{ status: 'cancelled', build_id, ... }` and the `builds` row has `phase='cancelled'`

#### Scenario: Multi-change happy path

- **WHEN** decompose returns `['a', 'b', 'c']` and every apply + validate succeeds
- **THEN** `changes_done=3`, the `builds` row has `phase='integrate'`, and `validationReports` contains all three change ids

### Requirement: `runApplyPhase` is a thin wrapper around the runner

The system SHALL export `runApplyPhase(opts: RunApplyPhaseOptions): Promise<ApplyPhaseResult>` that invokes `runClaudeCode({ mode: 'apply', prompt: '/opsx:apply <changeId>', … })` and captures `session_id` from the first `system` event.

#### Scenario: Apply forwards prompt with /opsx:apply

- **WHEN** `runApplyPhase({ changeId: 'add-foo', ... })` runs against a recording fake spawn
- **THEN** the spawned args include `'-p'` and `'/opsx:apply add-foo'`
