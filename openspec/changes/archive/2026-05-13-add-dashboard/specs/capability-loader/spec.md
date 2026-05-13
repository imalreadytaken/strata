## MODIFIED Requirements

### Requirement: `loadCapabilities` validates meta, applies migrations, and registers each capability

The system SHALL expose `loadCapabilities(deps): Promise<CapabilityRegistry>` that:

- Discovers capabilities across `[bundledRoot, userRoot]`.
- For each: read+parse `meta.json` (JSON5), validate with `CapabilityMetaSchema`.
- Apply migrations via `applyCapabilityMigrations(db, name, <path>/migrations/)`.
- Upsert `capability_registry`: existing rows get `status='active'` + updated `version`/`meta_path`/`primary_table` (preserving `created_at`); new rows are inserted with `created_at=now()`.
- When `deps.dashboardRegistry` is provided AND `<path>/dashboard.json` exists, parse it with JSON5, validate against `DashboardSchema`, and register the result into the dashboard registry under the capability's name. Missing `dashboard.json` is silently skipped; a malformed file aborts boot with `STRATA_E_CAPABILITY_INVALID`.
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

#### Scenario: Dashboard.json registers when present

- **WHEN** `expenses/v1/dashboard.json` exists alongside `meta.json` and `loadCapabilities` runs with a `dashboardRegistry` in deps
- **THEN** the dashboard registry contains an entry for `'expenses'` whose widgets match the file's parsed widgets

#### Scenario: Missing dashboard.json does not abort boot

- **WHEN** a capability has no `dashboard.json` on disk
- **THEN** `loadCapabilities` completes successfully and the dashboard registry has no entry for that capability
