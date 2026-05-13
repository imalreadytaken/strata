## ADDED Requirements

### Requirement: `runIntegration` moves each capability + registers it transactionally

The system SHALL export `runIntegration(opts: RunIntegrationOptions): Promise<IntegrationResult>` that:

- Validates `opts.buildResult.status === 'ready_for_integration'`. Otherwise throws.
- For each capability directory under `<workdir>/capabilities/<name>/`:
  1. Locates the highest-numbered `v<N>/` subdir.
  2. Computes `destDir = <userCapabilitiesDir>/<name>/v<N>/`. If `destDir` already exists, fails this capability with `version_conflict`.
  3. Copies the source dir to `destDir` (recursive).
  4. Applies the capability's migrations to `deps.db` via `applyCapabilityMigrations(deps.db, name, destDir/migrations)`.
  5. Inserts (or updates if already present) a `capability_registry` row with `status='active'`, `version=<N>`, `meta_path=destDir/meta.json`, `primary_table` from the meta.
  6. Inserts a `capability_health` row with all counters at 0 and `updated_at=now`.
  7. Inserts a `schema_evolutions` row with `change_type='capability_create'`, `from_version=0`, `to_version=<N>`, `approved_by='user'`, `applied_at=now`.
  8. On any failure between steps 4–7, removes the destination directory (rollback) and surfaces the error.
- If ALL capabilities integrate: marks the originating `proposals` row `status='applied'`, `responded_at=now`, `resulting_build_id=<buildId>`; updates `builds` to `phase='done'`, `completed_at=now`.
- If any capability fails: updates `builds` to `phase='failed'`, `failure_reason=<reason>`, leaves the proposal untouched.

#### Scenario: Happy path single capability

- **WHEN** the workdir contains `capabilities/weight/v1/{meta.json, migrations/001_init.sql, pipeline.ts}` and the user dir is empty
- **THEN** the result is `{ status: 'integrated', integrated: [{ name: 'weight', version: 1, ... }] }`, `<userDir>/weight/v1/meta.json` exists, `capability_registry` has a `weight` row with `status='active'`, `capability_health.weight.total_writes === 0`, `schema_evolutions` has a `weight` row with `from_version=0` `to_version=1`, the originating proposal is `'applied'`, the build is `phase='done'`

#### Scenario: Version conflict short-circuits that capability

- **WHEN** `<userDir>/weight/v1/` already exists before `runIntegration`
- **THEN** the result is `{ status: 'failed', failureReason: <contains 'version_conflict'> }`, the proposal stays `'pending'`, and the build's `phase='failed'`

#### Scenario: DB failure rolls back the FS copy

- **WHEN** a DB write fails mid-integration (e.g., the registry repo throws)
- **THEN** the destination directory no longer exists on disk after `runIntegration` returns

#### Scenario: Multi-capability success

- **WHEN** the workdir contains two valid capability dirs
- **THEN** the result's `integrated.length === 2` and both proposals/builds states reflect success

#### Scenario: Multi-capability partial success

- **WHEN** the first capability integrates cleanly but the second fails (e.g., version_conflict)
- **THEN** the result is `{ status: 'failed', integrated: [<first>], failureReason: <names the second> }`, the first capability is fully integrated (files + DB rows), and the second is not on disk
