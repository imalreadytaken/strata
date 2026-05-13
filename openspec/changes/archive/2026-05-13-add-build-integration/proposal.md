## Why

`runBuild` leaves a build at `phase='integrate'` with a workdir containing one or more freshly-validated capability directories. None of that is **live** yet — the runtime's `CapabilityRegistry` doesn't see the new capability, the user's `~/.strata/capabilities/` doesn't contain it, and the originating proposal still reads `status='pending'`.

`runIntegration(buildResult, deps)` closes the loop:

1. Moves each `workdir/capabilities/<name>/v<N>/` directory into the user's `<dataDir>/capabilities/<name>/v<N>/`.
2. Applies the capability's migrations to the main DB (idempotent via the existing `_strata_capability_migrations` ledger).
3. Inserts a `capability_registry` row (`status='active'`).
4. Inserts a zero-count `capability_health` row.
5. Inserts a `schema_evolutions` row recording `change_type='capability_create'`, `from_version=0`, `to_version=<N>`.
6. Updates the originating `proposals` row to `status='applied'`, `resulting_build_id=<buildId>`.
7. Updates the `builds` row to `phase='done'`, `completed_at=now()`.

On any failure mid-flight, the moved directory is rolled back. Subsequent boots will pick the new capability up via the existing capability loader — no plugin restart required (the loader walks the user dir on every boot; for in-process hot-pickup, a follow-up change can wire a `refreshCapabilities()` hook).

References: `STRATA_SPEC.md` §5.8.5 (integration sketch), §3.1 (`capability_registry` / `capability_health` / `schema_evolutions` / `proposals` / `builds` tables).

## What Changes

- Add `build-integration` capability covering:
  - **`runIntegration(opts: RunIntegrationOptions): Promise<IntegrationResult>`** — accepts a `ready_for_integration` `BuildRunResult` plus a deps bag of repositories + paths. Returns `IntegrationResult` with `installedCapabilities: { name, version, path }[]` and the final `build_id`.
  - **`IntegrationResult`** discriminated union: `{ status: 'integrated', ... } | { status: 'failed', failureReason, partial }`.
  - **Per-capability transactional integration** — each capability moves + registers as one unit. A mid-flight failure rolls back THAT capability's FS + DB state; previously-integrated capabilities in the same build stay.
  - **No skill / cron / dashboard registration** — these subsystems don't exist yet. Hooks are reserved in the function signature for the follow-ups.
- **Tests** drive integration against a temp workdir + a temp user data dir. Validate: files moved; migrations applied; registry / health / schema_evolutions rows present; proposal + build status flipped.

## Capabilities

### New Capabilities
- `build-integration`: workdir-to-userdir mover + DB registrar for completed builds.

### Modified Capabilities
*(none — uses `capability-loader::applyCapabilityMigrations` and all five repos)*

## Impact

- **Files added**:
  - `src/build/integration.ts` — `runIntegration`, `IntegrationResult`, `RunIntegrationOptions`.
  - `src/build/integration.test.ts` — happy path, partial-failure rollback, idempotent re-run.
- **Files modified**:
  - `src/build/index.ts` — re-export.
- **Non-goals**:
  - No git commit on the user's main repo. The plugin doesn't manage their git.
  - No automatic plugin restart / runtime registry refresh. The loader picks new capabilities up on next boot; we leave the in-process refresh story for later.
  - No skill registration. Skill router lives in P5.
  - No `cron.json` / `dashboard.json` registration. Both wait for their respective subsystems.
  - No pre-existing-version handling — if `<userDir>/<name>/v<N>/` already exists, integration fails with `version_conflict`. Upgrades (v1 → v2) work because they ship under `vN+1/`; same-version overwrites aren't allowed.
