## 1. Types

- [x] 1.1 Create `src/build/workspace.ts` exporting:
  - `BuildWorkspaceHandle = { workdir, agentsMdPath, planMdPath, userContextMdPath, existingCapabilitiesDir, gitInitialCommit }`.
  - `SetupBuildWorkspaceOptions = { sessionId, planContents, buildContext: { requestedTitle, requestedSummary, rationale? }, agentsMdSource: string, buildsDir: string, capabilities: CapabilityRegistry, proposalsRepo: ProposalsRepository, capabilityRegistryRepo: CapabilityRegistryRepository, logger: Logger, now?: () => Date }`.
  - `RenderUserContextOptions`.

## 2. `renderUserContext`

- [x] 2.1 Export `renderUserContext(opts): Promise<string>` that produces a Markdown document with:
  - H1: `Strata user context (build triggered <ISO timestamp>)`.
  - Section "Active capabilities" — table of `{ name, version, primary_table }` from `capabilityRegistryRepo.findMany({ status: 'active' })`. Empty case: "(none yet)".
  - Section "Pending proposals" — list of `{ id, kind, title, source }` from `proposalsRepo.findMany({ status: 'pending' })`. Empty case: "(none)".
  - Section "This build" — `requestedTitle` / `requestedSummary` / `rationale` (if any) from `buildContext`.
- [x] 2.2 Time goes through an injectable `now()` so tests can pin.

## 3. `setupBuildWorkspace`

- [x] 3.1 Resolve `workdir = path.join(buildsDir, '<sessionId>-<timestamp>')` where timestamp is `now().toISOString().replace(/[:.]/g, '-')`.
- [x] 3.2 `mkdir -p workdir`.
- [x] 3.3 Copy `agentsMdSource` → `<workdir>/AGENTS.md`.
- [x] 3.4 Write `planContents` → `<workdir>/PLAN.md`.
- [x] 3.5 Call `renderUserContext(...)` → `<workdir>/USER_CONTEXT.md`.
- [x] 3.6 For each `LoadedCapability` in the registry, copy `<capPath>/meta.json` and `<capPath>/migrations/` (if exists) into `<workdir>/existing_capabilities/<name>/`.
- [x] 3.7 Run `git init` + `git add .` + `git commit -m 'initial workspace'` (with `GIT_AUTHOR_NAME=Strata`, `GIT_AUTHOR_EMAIL=strata@local`, `GIT_COMMITTER_NAME=Strata`, `GIT_COMMITTER_EMAIL=strata@local` so the commit succeeds even with no global config). Capture the commit SHA via `git rev-parse HEAD`.
- [x] 3.8 Return the `BuildWorkspaceHandle`.

## 4. `cleanupBuildWorkspace`

- [x] 4.1 Export `cleanupBuildWorkspace(handle): Promise<void>` that runs `fs.rm(handle.workdir, { recursive: true, force: true })`. Idempotent (no throw on missing).

## 5. Barrel

- [x] 5.1 Create `src/build/index.ts` re-exporting both `claude_code_runner` and `workspace` public surfaces.

## 6. Tests

- [x] 6.1 `src/build/workspace.test.ts` (≥ 6 cases):
  - Happy path: full setup → returns a handle with non-empty `gitInitialCommit`; all 4 files exist; `existing_capabilities/expenses/{meta.json, migrations/001_init.sql}` materialised when registry contains a capability with migrations.
  - `USER_CONTEXT.md` content: contains the active capability names, the proposal title, and the build context fields.
  - `existing_capabilities` handles capabilities WITHOUT migration dirs (copies only `meta.json`).
  - `git init` ran: `<workdir>/.git/` directory exists; `git -C <workdir> rev-parse HEAD` resolves to the returned SHA.
  - Two concurrent calls for the same `sessionId` (advancing the injected `now()`) produce distinct workdirs.
  - `cleanupBuildWorkspace`: removes the workdir; calling it twice is safe.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-build-workspace --strict`.
