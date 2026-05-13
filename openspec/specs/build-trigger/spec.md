# build-trigger Specification

## Purpose

`build-trigger` adds `strata_run_build` — an agent-callable tool that takes a `proposal_id` and dispatches Build Bridge end-to-end. It looks up the proposal (refuses unless `'pending'` or `'approved'`), runs `runBuild`, and on `'ready_for_integration'` runs `runIntegration`. Returns a tagged outcome (`'integrated'` / `'orchestrator_failed'` / `'integration_failed'` / `'cancelled'` / `'rejected'`) the agent can quote back to the user. The Build Bridge stack now has a trigger — code that ran only in tests can finally be dispatched by conversation. The optional `EventToolDeps.buildDeps` carries everything `runBuild` + `runIntegration` need (eight repos + paths + injectable function overrides for testing); when missing, the tool rejects cleanly.

## Requirements
### Requirement: `strata_run_build` dispatches a proposal end-to-end

The system SHALL register a `strata_run_build` agent tool with parameters `{ proposal_id: number }`. On execute the tool MUST:

1. Look up the proposal via `proposalsRepo.findById`. Missing or `status NOT IN { 'pending', 'approved' }` → return `{ status: 'rejected', failureReason: <description> }`.
2. When `deps.buildDeps` is undefined → return `{ status: 'rejected', failureReason: 'buildDeps not wired' }`.
3. Call `runBuild({ proposalId, sessionId: 'tool', deps: { ... } })`. Map outcomes:
   - `'failed'` → `{ status: 'orchestrator_failed', build_id, failureReason }`.
   - `'cancelled'` → `{ status: 'cancelled', build_id }`.
   - `'ready_for_integration'` → proceed to step 4.
4. Call `runIntegration({ buildResult, deps: { ... } })`. Map outcomes:
   - `'integrated'` → `{ status: 'integrated', build_id, integrated: <names> }`.
   - `'failed'` → `{ status: 'integration_failed', build_id, failureReason }`.

#### Scenario: Happy path returns `'integrated'`

- **WHEN** stubbed `runBuild` returns `'ready_for_integration'` AND stubbed `runIntegration` returns `'integrated'`
- **THEN** the tool's result `details.status === 'integrated'` and `details.integrated.length >= 1`

#### Scenario: Orchestrator failure surfaces reason

- **WHEN** stubbed `runBuild` returns `{ status: 'failed', failureReason: 'plan_empty' }`
- **THEN** the tool's result `details.status === 'orchestrator_failed'`, `details.failureReason === 'plan_empty'`

#### Scenario: Integration failure preserves build_id

- **WHEN** `runBuild` ok and `runIntegration` returns `{ status: 'failed', failureReason: 'X_failed' }`
- **THEN** the tool's `details.status === 'integration_failed'`, `details.build_id` matches the orchestrator's build_id

#### Scenario: Cancelled cascade

- **WHEN** `runBuild` returns `{ status: 'cancelled' }`
- **THEN** the tool's `details.status === 'cancelled'`, and `runIntegration` was NOT called

#### Scenario: Refuses a declined proposal

- **WHEN** the proposal's `status='declined'`
- **THEN** the tool's `details.status === 'rejected'`, the failureReason references the status

#### Scenario: Refuses when buildDeps missing

- **WHEN** `EventToolDeps.buildDeps` is undefined
- **THEN** the tool's `details.status === 'rejected'`, failureReason mentions `'buildDeps'`

