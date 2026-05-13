## Context

`STRATA_SPEC.md` §4.1 + §4.2 describes the on-disk shape of a capability. `openspec/AGENTS.md` "File structure for a capability" + "meta.json schema" pin the validation contract. The implementation gap is:

1. **Discovery**: a directory scanner that walks `capabilities/<name>/v<N>/`, resolves `current` symlinks, sorts versions numerically.
2. **Migrations**: per-capability migrations need their own ledger because `_strata_migrations` uses `filename` as PK — two capabilities both shipping `001_init.sql` would collide.
3. **Validation**: `meta.json` is read at boot and validated against the AGENTS.md schema. A malformed `meta.json` is a fatal boot error; we'd rather refuse to load than register a half-broken capability.
4. **Registry write**: a row in `capability_registry` per loaded capability, idempotent across re-boots.

We carve all four into one module (`src/capabilities/`) so the next change (pipeline runner) gets a clean `runtime.capabilities` registry to consume.

## Goals / Non-Goals

**Goals:**
- Discovery is **filesystem-only and synchronous** at boot. No glob libraries, no async stat parades — directory listings are tiny (≤ tens of entries) and the cost is one-time.
- The migrations ledger is a **separate table** (`_strata_capability_migrations`) keyed `(capability_name, filename)`. Backward-compatible with the existing `_strata_migrations` table — system migrations stay in their lane.
- `loadCapabilities` is **idempotent**: a re-boot on the same DB skips already-applied migrations, upserts the same `capability_registry` row to `status='active'`, and never duplicates anything.
- Bundled first-party capabilities live at **`src/capabilities/<name>/v<N>/`** (resolved via `import.meta.url`-relative paths so they're found whether the plugin runs from source, dist, or a node_modules install).
- User-installed capabilities live at **`config.paths.capabilitiesDir`** (default `~/.strata/capabilities/`). On name collision, **user wins** (so a Build Bridge override of a first-party capability takes effect).
- Returns a typed `CapabilityRegistry = Map<string, LoadedCapability>` exposed on `StrataRuntime.capabilities`.

**Non-Goals:**
- No `import('pipeline.ts')` from the loader. Keeping side-effects to "read JSON + apply SQL + write registry" means a buggy pipeline can't crash the boot. The pipeline runner change owns dynamic imports.
- No watchers / hot reload. Capabilities load once; the Build Bridge integration phase will explicitly call the loader again on freshly-emitted code.
- No skill registration. `meta.json.exposed_skills` is captured into `LoadedCapability.meta` for future use; we don't yet hand it to `api.registerSkill` (no such SDK surface anyway).
- No dependency resolution. `depends_on_capabilities` is captured for forward compatibility; the loader currently ignores cycles and ordering (no capability depends on another in P3).
- No "remove a capability" path. Once registered, a capability stays `active` until the Reflect agent archives it.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/capabilities/types.ts` | new | `CapabilityMetaSchema` (Zod), `CapabilityMeta` (type), `LoadedCapability`, `CapabilityRegistry` (=`Map<string, LoadedCapability>`). |
| `src/capabilities/discover.ts` | new | `discoverCapabilities(roots: string[]): Promise<DiscoveredCapability[]>` — version selection + `current` symlink resolution + warn-and-skip on malformed dirs. |
| `src/capabilities/migrations.ts` | new | `applyCapabilityMigrations(db, capability_name, dir)` — sibling of system `applyMigrations`, uses `_strata_capability_migrations` ledger. |
| `src/capabilities/loader.ts` | new | `loadCapabilities(deps): Promise<CapabilityRegistry>` — discovery → validate → migrate → register. |
| `src/capabilities/index.ts` | new | Barrel: re-exports the four public surfaces above. |
| `src/capabilities/discover.test.ts` | new | Fixtures: empty roots, `vN`-only, `current`-symlink wins, multi-`vN` picks highest, malformed dirs skipped with `warn`, user-root shadows bundled-root. |
| `src/capabilities/migrations.test.ts` | new | Per-capability ledger isolation (two capabilities with `001_init.sql` both apply); checksum-mismatch detection; idempotent re-run. |
| `src/capabilities/loader.test.ts` | new | End-to-end: a `meta.json` + one migration → `capability_registry` row inserted, `LoadedCapability` returned; second boot finds the same row, status stays `active`. |
| `src/runtime.ts` | modified | `StrataRuntime.capabilities: CapabilityRegistry`; boot calls `loadCapabilities(...)` after `applyMigrations(...)`. |
| `src/runtime.test.ts` | modified | One new assertion: the runtime's `capabilities` map exists and is empty when no capabilities are on disk. |

## Decisions

### D1 — Two ledger tables, not one

The existing `_strata_migrations` table uses `filename` as primary key. Two capabilities both shipping `001_init.sql` would collide. Three options:

- (a) Add a `scope` column to `_strata_migrations` and re-key it. Forces a migration of an existing user database; not free.
- (b) Force capability migration files to be globally unique (e.g., `expenses_001_init.sql`). Pushes a naming constraint onto every future first-party + Claude-Code-generated capability; brittle.
- (c) Ship a sibling table `_strata_capability_migrations(capability_name TEXT, filename TEXT, checksum TEXT, applied_at TEXT, PRIMARY KEY(capability_name, filename))`. Zero changes to existing system migrations; sibling logic mirrors `applyMigrations` for one new function.

We pick (c). It's the smallest, most contained change. The ledger table is created via `CREATE TABLE IF NOT EXISTS` inside `applyCapabilityMigrations`, the same shape `applyMigrations` uses, so there's no separate system migration to add.

### D2 — `current` symlink, then highest-`vN`, otherwise skip

Discovery for a single `<name>/` directory:

1. If `<name>/current/` exists (symlink or directory) AND has a readable `meta.json`, use it.
2. Else, list `<name>/v*` entries; pick the one with the highest integer suffix (`v3` > `v2` > `v1`). Lexicographic sort would order `v10` before `v2`; we strip the `v` and parse as int.
3. If no versioned dir is found, log at `warn` and skip the capability (don't throw — one broken capability shouldn't block boot).

### D3 — Bundled root is resolved via `import.meta.url`

The plugin can run from source (`./src/`), from `dist/` after `tsc`, or from `node_modules/strata/`. Hardcoding a path won't work. The loader resolves the bundled root as `fileURLToPath(new URL('./capabilities/', import.meta.url))`. When this change lands, the directory may not exist yet (no first-party capability ships in this change); `discoverCapabilities` gracefully treats a missing root as empty.

### D4 — User root shadows bundled root on name collision

`loadCapabilities([bundled, user])` walks `user` last. The discovery routine collapses by `name`, last-write-wins. This lets a user (or a Build Bridge run) override a first-party `expenses/v1/` with their own `expenses/v2/` simply by dropping it into `<dataDir>/capabilities/expenses/v2/`. Audit-friendly: the `meta_path` written to `capability_registry` records exactly which directory's code is active.

### D5 — Malformed `meta.json` is fatal; missing `meta.json` is fatal; missing capability dir is silent

The distinction:

- A capability dir with no `meta.json` is a packaging mistake — refuse to boot with a clear `STRATA_E_CAPABILITY_INVALID` error pointing at the bad path.
- An empty `<name>/` (no `current/`, no `v*/`) was probably half-deleted by hand — log `warn` and skip.
- A missing `meta.json` field (e.g., no `primary_table`) → throw `STRATA_E_CAPABILITY_INVALID` with the Zod error message.

A fatal load failure aborts boot. Better to flag it loudly than to silently miss writes to a business table.

### D6 — `capability_registry` upsert keeps `created_at` stable

On idempotent re-boot we don't want `created_at` to bounce. The upsert checks `findById(name)`: if a row exists, `update(...)` with the new `version` / `meta_path` / `status='active'` (no `created_at`); else `insert(...)` with `created_at=now()`. Tests pin this behaviour explicitly so a future refactor can't accidentally clobber it.

### D7 — Skip dynamic `import()` until the next change

`LoadedCapability.meta.owner_pipeline` is the relative path `pipeline.ts`. The pipeline runner (next change) is what `import()`s that file and calls its `ingest(rawEvent, deps)` export. Keeping `import()` out of the loader means:

- Boot is deterministic — no module side-effects from a buggy capability blow up registration.
- The loader is fully testable with `meta.json` + SQL files alone — no need to write a TS pipeline just to unit-test the loader.

### D8 — `dependsOn` is recorded but not enforced

`meta.json.depends_on_capabilities: string[]` is parsed into `LoadedCapability.meta.depends_on_capabilities`. The loader does NOT topologically sort or fail on missing deps. P3 has no capability that depends on another; when one shows up we add `validateDependencyGraph(registry)` as a separate function. Captured here so we don't paint ourselves into a corner: the data is already in the registry the day we need it.

## Risks / Trade-offs

- **Capability migration checksum mismatch on disk edit.** Same protection the system ledger gets: if a user edits an applied SQL file, the next boot throws `STRATA_E_CAPABILITY_MIGRATE_FAILED`. AGENTS.md hard constraint #5 ("migrations are immutable") applies in spirit to capability migrations too.
- **One slow capability's migrations block boot.** Acceptable: capabilities are tiny SQLite migrations; the realistic upper bound is single-digit-millisecond per file. If this ever bites, the loader can apply migrations concurrently across capabilities — but they need to stay sequential within a capability.
- **Bundled root might not exist** during this change because no first-party capability ships yet. `discoverCapabilities` treats a missing root as empty so this is a non-issue.
