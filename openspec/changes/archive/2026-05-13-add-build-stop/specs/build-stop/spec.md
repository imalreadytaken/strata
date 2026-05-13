## ADDED Requirements

### Requirement: `BuildSessionRegistry` tracks running builds with their AbortControllers

The system SHALL ship `BuildSessionRegistry` exposing:

- `register(buildId: number, controller: AbortController, sessionId: string): void`
- `abort(buildId: number): { stopped: boolean }` — calls `.abort()` on a registered controller and returns `{ stopped: true }`; missing entry returns `{ stopped: false }` and does NOT throw.
- `complete(buildId: number): void` — removes the registered entry; missing entry is a no-op.
- `get(buildId: number): { controller: AbortController; sessionId: string; startedAt: string } | undefined`
- `list(): Array<{ buildId: number; sessionId: string; startedAt: string }>`
- `size(): number`

#### Scenario: register → abort fires the signal

- **WHEN** a controller is registered under build_id 7 and `registry.abort(7)` is called
- **THEN** the result is `{ stopped: true }` and the controller's `signal.aborted` is `true`

#### Scenario: abort on missing id returns stopped:false

- **WHEN** `registry.abort(99)` is called and id 99 was never registered
- **THEN** the result is `{ stopped: false }` and no error is thrown

#### Scenario: complete deregisters

- **WHEN** an entry is registered, then `registry.complete` is called for the same id, then `registry.abort` is called for the same id
- **THEN** the abort result is `{ stopped: false }`

### Requirement: `strata_stop_build` aborts a running build via the registry

The system SHALL register `strata_stop_build` with the Zod schema `{ build_id: number (positive int) }`. On execute the tool MUST:

1. Reject when `deps.buildDeps?.buildSessionRegistry` is undefined, returning `{ status: 'rejected', failureReason: 'buildSessionRegistry not wired' }`.
2. Look up the build row via `buildsRepo.findById(build_id)`. Missing → `{ status: 'not_found' }`.
3. Call `registry.abort(build_id)`. When `stopped===true` → `{ status: 'stopped', build_id }`. Otherwise → `{ status: 'not_running', build_id, phase: row.phase }`.

#### Scenario: Tool aborts a registered build

- **WHEN** a build with id 7 is registered with an AbortController and the tool is called with `{ build_id: 7 }`
- **THEN** the result is `{ status: 'stopped', build_id: 7 }` and the controller's signal is aborted

#### Scenario: Tool reports not_running for an unregistered but existing build

- **WHEN** the build row exists but is not in the registry (already completed) and the tool is called
- **THEN** the result is `{ status: 'not_running', build_id, phase }` where phase matches the row

#### Scenario: Tool reports not_found for an unknown id

- **WHEN** the tool is called with a build_id that has no row
- **THEN** the result is `{ status: 'not_found' }`

### Requirement: `strata_run_build` registers an AbortController and completes the entry on every terminal path

The dispatch tool SHALL, when `buildDeps.buildSessionRegistry` is present:

1. Create a fresh `AbortController` before invoking `runBuild`.
2. Pass `signal: controller.signal` into `runBuild` (and `runIntegration` when reached).
3. Pass a callback `onBuildIdAssigned(buildId)` that the orchestrator invokes once it has the inserted row's id; the callback calls `registry.register(buildId, controller, sessionId)`.
4. Call `registry.complete(buildId)` in a `finally` block so every terminal status — and any thrown exception — deregisters.

When `buildSessionRegistry` is absent, the tool MUST still function (no registration, no signal). This preserves the test surface for existing tests that don't care about stop.

#### Scenario: A registered build is stoppable mid-run

- **WHEN** `strata_run_build` is dispatched with a phaseRunner stub whose decompose phase aborts the signal AND a `BuildSessionRegistry` is wired
- **THEN** the tool returns `{ status: 'cancelled' }`, the registry has no entry for the build, and the build's row has `phase='cancelled'`

#### Scenario: `complete` runs even when the integration phase throws

- **WHEN** the orchestrator returns `ready_for_integration` but `runIntegration` throws
- **THEN** the registry entry for that build_id has been removed
