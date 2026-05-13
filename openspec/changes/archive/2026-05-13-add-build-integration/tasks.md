## 1. Types

- [x] 1.1 Create `src/build/integration.ts` exporting:
  - `IntegratedCapability` = `{ name: string; version: number; installedPath: string; metaPath: string }`.
  - `RunIntegrationOptions` = `{ buildResult: BuildRunResult & { status: 'ready_for_integration' }; deps: IntegrationDeps }`.
  - `IntegrationDeps` = `{ buildsRepo, proposalsRepo, capabilityRegistryRepo, capabilityHealthRepo, schemaEvolutionsRepo, db (better-sqlite3), userCapabilitiesDir: string, logger }`.
  - `IntegrationResult` discriminated union:
    - `{ status: 'integrated', build_id, integrated: IntegratedCapability[] }`
    - `{ status: 'failed', build_id, failureReason, integrated: IntegratedCapability[] }`.

## 2. Per-capability integrator

- [x] 2.1 Helper `integrateOneCapability(workdir, name, deps): Promise<IntegratedCapability>`:
  - Locate `<workdir>/capabilities/<name>/v<N>/` (highest N).
  - Compute `destDir = <userCapabilitiesDir>/<name>/v<N>/`.
  - If `destDir` exists → throw `Error('version_conflict')`.
  - `fs.cp(srcDir, destDir, { recursive: true })`.
  - try { apply migrations via `applyCapabilityMigrations(db, name, destDir/migrations)`; INSERT `capability_registry` (or update); INSERT `capability_health` (zero counters); INSERT `schema_evolutions` row } catch { fs.rm(destDir, recursive); rethrow }
  - Returns the IntegratedCapability shape.

## 3. `runIntegration`

- [x] 3.1 Validate inputs: `buildResult.status === 'ready_for_integration'`. Otherwise throw (programmer error).
- [x] 3.2 Discover capability names by scanning `buildResult.workdir/capabilities/` (immediate subdirs).
- [x] 3.3 For each name: call `integrateOneCapability`. On success push to `integrated[]`. On failure capture `failureReason='<capName>_failed: <message>'` and short-circuit further capabilities.
- [x] 3.4 If all capabilities integrate: look up `proposal_id` from `builds.trigger_proposal_id`, update `proposals` to `{ status: 'applied', responded_at: now, resulting_build_id }`. Update `builds` to `{ phase: 'done', completed_at: now, last_heartbeat_at: now }`. Return `{ status: 'integrated', integrated }`.
- [x] 3.5 If any failed: update `builds` to `{ phase: 'failed', failure_reason, completed_at: now, last_heartbeat_at: now }`. Leave proposal untouched. Return `{ status: 'failed', integrated, failureReason }`.

## 4. Barrel

- [x] 4.1 `src/build/index.ts`: re-export `runIntegration`, `IntegrationResult`, `RunIntegrationOptions`, `IntegratedCapability`.

## 5. Tests

- [x] 5.1 `src/build/integration.test.ts`:
  - Happy path (single capability): given a fixture workdir with `capabilities/weight/v1/{meta.json, migrations/001_init.sql, pipeline.ts}` and a non-existent user dir, `runIntegration` returns `{ status: 'integrated', integrated: [{ name: 'weight', version: 1, ... }] }`. Files exist at `<userDir>/weight/v1/`. `capability_registry` has the row. `capability_health` has the row (zero counters). `schema_evolutions` has `change_type='capability_create'` `from_version=0` `to_version=1`. Proposal status flipped to `'applied'`. Build phase `'done'`.
  - Happy path (multi-capability): two capabilities both integrate; `integrated.length === 2`.
  - Version conflict: pre-create `<userDir>/<name>/v1/` so the integration fails. Result `{ status: 'failed', failureReason: contains 'version_conflict' }`. The proposal stays `'pending'`. The build's `phase='failed'`.
  - Rollback on DB failure: stub `capabilityRegistryRepo.insert` to throw on the second capability. The first capability stays integrated; the second's FS dir is removed (assert with `existsSync`). Build's `phase='failed'`.
  - Build not in `ready_for_integration` throws.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` all pass.
- [x] 6.3 `openspec validate add-build-integration --strict`.
