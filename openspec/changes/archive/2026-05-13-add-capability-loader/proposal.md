## Why

Strata is a *substrate* — its real value comes from the capabilities (`expenses`, `moods`, `workout`, …) layered on top. Today the plugin can persist messages, drive the `raw_events` state machine, and run a triage classifier; nothing has ever written a business-table row. The block in the way is `src/capabilities/loader.ts` from `STRATA_SPEC.md` §4.2:

> Loads `capabilities/<name>/v<N>/`, applies the capability's migrations, registers it in `capability_registry`, exposes it on the runtime.

Once the loader exists, the next change (`add-pipeline-runner`) can hook `commit_event` so a committed `raw_event` with `capability_name='expenses'` actually drives a row into the `expenses` business table. And the change after that (`add-expenses-capability`) gets to be a *pure data-only* change: just the schema, migration, and pipeline source — no infrastructure work.

References: `STRATA_SPEC.md` §4.1 (`<dataDir>/capabilities/<name>/v<N>/`), §4.2 (`src/capabilities/loader.ts`), `openspec/AGENTS.md` "File structure for a capability" + "meta.json schema".

## What Changes

- Add `capability-loader` capability covering:
  - **`CapabilityMetaSchema`** (Zod) — the `meta.json` shape from `openspec/AGENTS.md` (name / version / description / primary_table / depends_on_capabilities / ingest_event_types / owner_pipeline / exposed_skills).
  - **`discoverCapabilities(roots): Promise<DiscoveredCapability[]>`** — for each root directory:
    1. List `<name>/` subdirs.
    2. For each, resolve the active version — prefer `current/` (symlink) if present, else the highest-numbered `v<N>/`.
    3. Return `{ name, version, path }`. Quietly skips dirs missing a versioned subdir; logs at `warn` for malformed names.
  - **`applyCapabilityMigrations(db, capability_name, migrationsDir)`** — sibling of `applyMigrations` that uses a new ledger table `_strata_capability_migrations` with composite primary key `(capability_name, filename)`. Solves the "two capabilities both have `001_init.sql`" collision the existing ledger can't tolerate.
  - **`loadCapabilities(deps): Promise<CapabilityRegistry>`** — orchestrates the boot path:
    1. Run `discoverCapabilities` against the bundled (`<plugin>/src/capabilities/`) and user (`config.paths.capabilitiesDir`) roots.
    2. User-dir capabilities of the same `name` shadow bundled ones — so a Build-Bridge-emitted v2 overrides the first-party v1.
    3. For each survivor, read+validate `meta.json`, run `applyCapabilityMigrations`, upsert a `capability_registry` row (`status='active'`).
    4. Return a `Map<string, LoadedCapability>` with `{ meta, paths, version }` for the pipeline runner (next change) to consume.
  - **Plugin entry wiring**: `bootRuntime` calls `loadCapabilities` after system migrations apply; the resulting registry is stashed on `StrataRuntime.capabilities`.

## Capabilities

### New Capabilities
- `capability-loader`: discovery + meta validation + per-capability migrations + `capability_registry` upsert at plugin boot.

### Modified Capabilities
*(none — new module; only touches `runtime.ts` boot order)*

## Impact

- **Files added**:
  - `src/capabilities/types.ts` — `CapabilityMetaSchema`, `LoadedCapability` type.
  - `src/capabilities/discover.ts` — `discoverCapabilities(roots)`.
  - `src/capabilities/migrations.ts` — `applyCapabilityMigrations(db, name, dir)`.
  - `src/capabilities/loader.ts` — `loadCapabilities(deps)`.
  - `src/capabilities/index.ts` — barrel.
  - `src/capabilities/discover.test.ts`, `src/capabilities/migrations.test.ts`, `src/capabilities/loader.test.ts`.
- **Files modified**:
  - `src/runtime.ts` — `StrataRuntime` gains a `capabilities: CapabilityRegistry`; `bootRuntime` calls `loadCapabilities` after `applyMigrations`.
- **Non-goals**:
  - No pipeline execution. `LoadedCapability` records `owner_pipeline` (the path to `pipeline.ts`) but the loader does **not** `import()` it — that's the next change so its mistakes don't break boot.
  - No skill registration. `meta.json.exposed_skills` is captured but not yet hooked into the SDK; the future `skill_registrar.ts` consumes the same data.
  - No hot reload. Capabilities are loaded once at boot. Hot reload after a Build Bridge run is a P4 concern (the integration phase can call `loadCapabilities` again to pick up the new directory).
  - No `archived` / `deleted` status transitions during this change. The loader only inserts/updates `status='active'` rows; archiving lives with the Reflect agent (P5).
