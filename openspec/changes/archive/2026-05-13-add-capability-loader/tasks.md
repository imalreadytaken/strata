## 1. Types

- [x] 1.1 Create `src/capabilities/types.ts` exporting:
  - `CapabilityMetaSchema` (Zod) — `{ name (kebab/snake), version (positive integer), description (non-empty), primary_table (snake_case), depends_on_capabilities (string[] default []), ingest_event_types (string[] default []), owner_pipeline (string, default 'pipeline.ts'), exposed_skills (string[] default []) }`.
  - `CapabilityMeta` (type alias).
  - `DiscoveredCapability = { name: string; version: number; path: string; metaPath: string; migrationsPath: string }`.
  - `LoadedCapability = { meta: CapabilityMeta; version: number; path: string; metaPath: string }`.
  - `CapabilityRegistry = Map<string, LoadedCapability>`.

## 2. Discovery

- [x] 2.1 Create `src/capabilities/discover.ts` exporting `discoverCapabilities(roots: string[], logger): Promise<DiscoveredCapability[]>`:
  - Each `root`: missing → log `debug` and skip. Present → list immediate subdirs.
  - For each `<name>/`: prefer `current/` if it resolves to a real dir with `meta.json`; else pick `v<N>/` with the highest integer N.
  - If no versioned dir found, log `warn` and skip.
- [x] 2.2 Across roots, later roots shadow earlier ones on name collision (per D4).
- [x] 2.3 Validate dir name as `^[a-z][a-z0-9_-]*$`; log `warn` and skip otherwise.

## 3. Per-capability migrations

- [x] 3.1 Create `src/capabilities/migrations.ts` exporting `applyCapabilityMigrations(db, capability_name, dir): MigrationSummary`:
  - `CREATE TABLE IF NOT EXISTS _strata_capability_migrations (capability_name TEXT, filename TEXT, checksum TEXT, applied_at TEXT, PRIMARY KEY(capability_name, filename))`.
  - Reads the dir, filters `MIGRATION_FILE_RE` from `db/migrations.ts`, applies in lexicographic order.
  - Per-file: SHA-256 checksum, lookup by `(capability_name, filename)`, refuse on checksum mismatch with `STRATA_E_CAPABILITY_MIGRATE_FAILED`, apply inside `db.transaction(...)`.
  - Missing `dir` → return `{ applied: [], skipped: [] }` (no migrations is a valid state — meta-only capabilities exist as a future option).

## 4. Loader

- [x] 4.1 Create `src/capabilities/loader.ts` exporting `loadCapabilities(deps): Promise<CapabilityRegistry>` where `deps = { db, repo: CapabilityRegistryRepository, bundledRoot: string, userRoot: string, logger }`.
- [x] 4.2 Walk `discoverCapabilities([bundledRoot, userRoot])`. For each:
  - Read+parse `meta.json` with JSON5 (matches `core/config.ts` convention).
  - Validate via `CapabilityMetaSchema.parse`. On failure → throw `STRATA_E_CAPABILITY_INVALID` referencing the file path.
  - Run `applyCapabilityMigrations(db, meta.name, <path>/migrations/)`.
  - Upsert `capability_registry`: if `repo.findById(name)` exists, `repo.update(name, { version, status: 'active', meta_path, primary_table })`; else `repo.insert({ name, version, status: 'active', meta_path, primary_table, created_at: now })`.
  - Build `LoadedCapability` and add to the registry map.
- [x] 4.3 Return the populated registry. Order: bundled first, user last (so user shadows wins).

## 5. Runtime wiring

- [x] 5.1 Modify `src/runtime.ts`:
  - Compute `bundledCapabilitiesRoot = fileURLToPath(new URL('./capabilities/', import.meta.url))`.
  - After `applyMigrations(db, SYSTEM_MIGRATIONS_DIR)` in `bootRuntime`, call `loadCapabilities({ db, repo: capabilityRegistryRepo, bundledRoot, userRoot: config.paths.capabilitiesDir, logger })`.
  - Add `capabilities: CapabilityRegistry` to `StrataRuntime`.
- [x] 5.2 `src/runtime.test.ts`: one assertion that `runtime.capabilities` is an empty `Map` for a fresh DB with no capabilities on disk.

## 6. Barrel

- [x] 6.1 Create `src/capabilities/index.ts` re-exporting the four public surfaces (`types`, `discoverCapabilities`, `applyCapabilityMigrations`, `loadCapabilities`).

## 7. Tests

- [x] 7.1 `src/capabilities/discover.test.ts` (≥ 6 cases):
  - Empty roots → `[]`.
  - One `<name>/v1/meta.json` → discovered.
  - `<name>/v1/` and `<name>/v2/` → picks `v2`.
  - `<name>/current/` symlinked to `v1/` → picks `current` (records `path = .../current`).
  - Malformed dir name (`Camel`) → warned and skipped.
  - Two roots with the same `<name>/` → user-root wins on `path`.
- [x] 7.2 `src/capabilities/migrations.test.ts` (≥ 4 cases):
  - Two capabilities both with `001_init.sql` apply cleanly.
  - Re-running the same migration is skipped (idempotent).
  - Checksum mismatch throws `STRATA_E_CAPABILITY_MIGRATE_FAILED`.
  - Missing `migrations/` dir returns `{ applied: [], skipped: [] }`.
- [x] 7.3 `src/capabilities/loader.test.ts` (≥ 5 cases):
  - Happy path: meta + migration → registry row inserted, `LoadedCapability` returned.
  - Idempotent re-boot: second call doesn't change `created_at`, status stays `active`.
  - Missing `meta.json` → throws `STRATA_E_CAPABILITY_INVALID`.
  - Malformed `meta.json` (missing `primary_table`) → throws with the Zod error.
  - User root shadows bundled root: `meta_path` reflects the user dir.

## 8. Integration

- [x] 8.1 `npm run typecheck` clean.
- [x] 8.2 `npm test` — all tests pass.
- [x] 8.3 `openspec validate add-capability-loader --strict`.
