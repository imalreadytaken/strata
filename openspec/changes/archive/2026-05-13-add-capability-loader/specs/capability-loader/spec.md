## ADDED Requirements

### Requirement: `meta.json` schema

The system SHALL export `CapabilityMetaSchema` validating a capability's `meta.json` with these fields:

- `name: string` matching `^[a-z][a-z0-9_-]*$`
- `version: number` positive integer
- `description: string` non-empty
- `primary_table: string` matching `^[a-z][a-z0-9_]*$`
- `depends_on_capabilities: string[]` default `[]`
- `ingest_event_types: string[]` default `[]`
- `owner_pipeline: string` default `'pipeline.ts'`
- `exposed_skills: string[]` default `[]`

#### Scenario: A valid meta.json parses

- **WHEN** `CapabilityMetaSchema.parse(...)` is called on `{ name: 'expenses', version: 1, description: 'x', primary_table: 'expenses' }`
- **THEN** the result has the four fields plus the four defaulted arrays

#### Scenario: A name with capital letters is rejected

- **WHEN** `CapabilityMetaSchema.parse(...)` is called with `name='Expenses'`
- **THEN** a ZodError is thrown

#### Scenario: A missing `primary_table` is rejected

- **WHEN** `CapabilityMetaSchema.parse(...)` is called without `primary_table`
- **THEN** a ZodError is thrown

### Requirement: `discoverCapabilities` resolves versioned directories across roots

The system SHALL expose `discoverCapabilities(roots: string[], logger): Promise<DiscoveredCapability[]>` that:

- Treats a missing root as empty (`debug` log).
- For each `<name>/` subdir under a root, picks the active version:
  - If `<name>/current/meta.json` is readable, use `<name>/current/`.
  - Else pick the highest-`<N>` from `<name>/v<N>/` entries (`v10 > v2 > v1`).
  - If neither exists, log `warn` and skip the capability.
- Validates dir names against `^[a-z][a-z0-9_-]*$`; logs `warn` and skips otherwise.
- On `<name>` collision across roots, the **later** root wins (user-root last → user-root shadows bundled-root).

#### Scenario: No roots produces no capabilities

- **WHEN** `discoverCapabilities([], logger)` is called
- **THEN** the result is `[]`

#### Scenario: Picks the highest numeric version

- **WHEN** a root contains `expenses/v1/meta.json` and `expenses/v2/meta.json`
- **THEN** the discovered entry's `path` ends in `expenses/v2`

#### Scenario: `current/` symlink wins over `vN/`

- **WHEN** a root contains `expenses/v1/`, `expenses/v2/`, and a `expenses/current` symlink pointing at `v1`
- **THEN** the discovered entry's `path` ends in `expenses/current`

#### Scenario: User root shadows bundled root

- **WHEN** the bundled root contains `expenses/v1/` and the user root contains `expenses/v2/`, and `discoverCapabilities([bundled, user], logger)` is called
- **THEN** exactly one entry for `expenses` is returned with `version === 2` and its `path` in the user root

#### Scenario: Malformed dir name is skipped with a warn

- **WHEN** a root contains a subdir named `Expenses`
- **THEN** no entry is returned for it and a `warn`-level log records the skip

### Requirement: Per-capability migrations use an isolated ledger

The system SHALL expose `applyCapabilityMigrations(db, capability_name, dir): MigrationSummary` that uses a `_strata_capability_migrations(capability_name TEXT, filename TEXT, checksum TEXT, applied_at TEXT, PRIMARY KEY(capability_name, filename))` ledger.

The function MUST:

- `CREATE TABLE IF NOT EXISTS` the ledger if missing.
- Apply every `NNN_*.sql` file in `dir` in lexicographic order inside a per-file `db.transaction(...)`.
- Refuse to re-run an applied file whose content has changed, throwing `STRATA_E_CAPABILITY_MIGRATE_FAILED`.
- Treat a missing `dir` as an empty migration set (return `{ applied: [], skipped: [] }`).

#### Scenario: Two capabilities with `001_init.sql` both apply cleanly

- **WHEN** `applyCapabilityMigrations(db, 'expenses', e/migrations)` is called, then `applyCapabilityMigrations(db, 'moods', m/migrations)` where both dirs have `001_init.sql`
- **THEN** both files apply (their `CREATE TABLE` statements succeed) and the ledger records both rows

#### Scenario: Idempotent re-run

- **WHEN** `applyCapabilityMigrations(db, 'expenses', dir)` is called twice in sequence
- **THEN** the second call's result has `applied=[]` and the file in `skipped[]`

#### Scenario: Edited migration is refused

- **WHEN** an applied migration file is edited on disk and `applyCapabilityMigrations` runs again
- **THEN** an error is thrown whose message contains the filename and the words "checksum"

#### Scenario: Missing migrations dir returns empty

- **WHEN** `applyCapabilityMigrations(db, 'no_migrations_cap', '/does/not/exist')` is called
- **THEN** the result is `{ applied: [], skipped: [] }` and no error is thrown

### Requirement: `loadCapabilities` validates meta, applies migrations, and registers each capability

The system SHALL expose `loadCapabilities(deps): Promise<CapabilityRegistry>` that:

- Discovers capabilities across `[bundledRoot, userRoot]`.
- For each: read+parse `meta.json` (JSON5), validate with `CapabilityMetaSchema`.
- Apply migrations via `applyCapabilityMigrations(db, name, <path>/migrations/)`.
- Upsert `capability_registry`: existing rows get `status='active'` + updated `version`/`meta_path`/`primary_table` (preserving `created_at`); new rows are inserted with `created_at=now()`.
- Return a `Map<string, LoadedCapability>` keyed by capability name.

An invalid `meta.json` (parse error or schema mismatch) MUST throw `STRATA_E_CAPABILITY_INVALID` and abort boot.

#### Scenario: Happy path registers a capability

- **WHEN** a valid `expenses/v1/{meta.json, migrations/001_init.sql}` lives at the user root, and `loadCapabilities(deps)` runs
- **THEN** the returned registry contains `'expenses'`, the migration is applied, and a row in `capability_registry` has `name='expenses'`, `status='active'`, `version=1`

#### Scenario: Idempotent re-boot preserves `created_at`

- **WHEN** `loadCapabilities` runs twice in sequence
- **THEN** the `capability_registry` row's `created_at` is unchanged between the two runs

#### Scenario: Malformed `meta.json` aborts boot

- **WHEN** `expenses/v1/meta.json` is missing `primary_table`
- **THEN** `loadCapabilities` rejects with `STRATA_E_CAPABILITY_INVALID` referencing the file path

#### Scenario: User root shadows bundled root in the registry

- **WHEN** bundled has `expenses/v1/`, user has `expenses/v2/`, and `loadCapabilities` runs
- **THEN** the resulting registry's `expenses` entry has `version=2` and its `meta_path` resolves into the user root

### Requirement: `StrataRuntime` exposes the loaded registry

The plugin runtime's `bootRuntime` SHALL call `loadCapabilities` immediately after the system migrations apply, and SHALL expose the resulting registry as `StrataRuntime.capabilities`.

#### Scenario: A fresh runtime exposes an empty capabilities map

- **WHEN** `bootRuntime(api)` runs against a fresh DB with no capabilities on disk
- **THEN** `runtime.capabilities` is a `Map` with `size === 0`
