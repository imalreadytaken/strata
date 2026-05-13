## ADDED Requirements

### Requirement: `setupBuildWorkspace` materialises the per-build workdir

The system SHALL export `setupBuildWorkspace(opts): Promise<BuildWorkspaceHandle>` that, given a `sessionId`, plan contents, build context, AGENTS.md source text, capability registry, and the relevant repos, creates a fresh directory at `<buildsDir>/<sessionId>-<timestamp>/` containing:

- `AGENTS.md` — verbatim copy of the supplied `agentsMdSource`.
- `PLAN.md` — verbatim write of `planContents`.
- `USER_CONTEXT.md` — output of `renderUserContext(...)`.
- `existing_capabilities/<name>/` per capability in the registry, containing the capability's `meta.json` and the `migrations/` directory (when one exists).
- `.git/` — initialised with one commit `'initial workspace'` whose SHA is returned on the handle.

The handle MUST expose every path the orchestrator subsequently needs (`workdir`, `agentsMdPath`, `planMdPath`, `userContextMdPath`, `existingCapabilitiesDir`, `gitInitialCommit`).

#### Scenario: Happy path produces a populated workdir

- **WHEN** `setupBuildWorkspace` is called with a non-empty plan, a registry containing `expenses` (with `migrations/001_init.sql`), and a non-empty AGENTS.md source
- **THEN** all four documents exist at their expected paths, `existing_capabilities/expenses/meta.json` exists, `existing_capabilities/expenses/migrations/001_init.sql` exists, and the returned `gitInitialCommit` matches `git -C <workdir> rev-parse HEAD`

#### Scenario: Capability without migrations is copied without errors

- **WHEN** the registry contains a capability whose directory has no `migrations/` subdir
- **THEN** `existing_capabilities/<name>/meta.json` is created and no `migrations/` directory appears

#### Scenario: Concurrent calls for the same session land in distinct workdirs

- **WHEN** `setupBuildWorkspace` is called twice for `sessionId='s1'` with `now()` advancing by ≥ 1 ms between calls
- **THEN** the two returned `workdir` paths differ

### Requirement: `renderUserContext` is a pure async function over a deps bag

The system SHALL export `renderUserContext(opts): Promise<string>` that returns a Markdown document with:

- An H1 carrying the ISO timestamp at which the build was triggered.
- A section listing active capabilities (from `capabilityRegistryRepo.findMany({ status: 'active' })`); when empty, the body MUST read `(none yet)`.
- A section listing pending proposals (from `proposalsRepo.findMany({ status: 'pending' })`); when empty, `(none)`.
- A section describing the current build (`requestedTitle` / `requestedSummary` / optional `rationale`).

#### Scenario: Active capability appears in the output

- **WHEN** the registry has an `expenses` row with `primary_table='expenses'`
- **THEN** the returned Markdown contains `'expenses'` and `'expenses'` in the active-capabilities section

#### Scenario: No active capabilities → fallback string

- **WHEN** the registry has zero active rows
- **THEN** the active-capabilities section contains `'(none yet)'`

#### Scenario: Build context is rendered

- **WHEN** `buildContext = { requestedTitle: 'Track weight', requestedSummary: '…', rationale: 'health' }`
- **THEN** the output contains `'Track weight'` and `'health'`

### Requirement: `cleanupBuildWorkspace` is idempotent

The system SHALL export `cleanupBuildWorkspace(handle): Promise<void>` that recursively removes the workdir if it exists. Calling it on an already-removed workdir MUST NOT throw.

#### Scenario: Cleanup removes the workdir

- **WHEN** `cleanupBuildWorkspace(handle)` is called after a setup
- **THEN** the directory `handle.workdir` no longer exists on disk

#### Scenario: Cleanup is idempotent

- **WHEN** `cleanupBuildWorkspace(handle)` is called twice in sequence
- **THEN** the second call resolves without throwing
