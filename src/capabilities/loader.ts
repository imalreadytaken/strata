/**
 * Boot-time capability loader.
 *
 * Walks the bundled and user-installed capability roots, validates each
 * `meta.json`, applies the capability's migrations, and upserts a row in
 * `capability_registry`. Returns a `CapabilityRegistry` for the pipeline
 * runner to consume.
 *
 * See `openspec/changes/add-capability-loader/specs/capability-loader/spec.md`.
 */
import { readFile } from "node:fs/promises";

import type Database from "better-sqlite3";
import JSON5 from "json5";

import { ValidationError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { loadCapabilityDashboard } from "../dashboard/loader.js";
import type { DashboardRegistry } from "../dashboard/registry.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import { discoverCapabilities } from "./discover.js";
import { applyCapabilityMigrations } from "./migrations.js";
import {
  CapabilityMetaSchema,
  type CapabilityRegistry,
  type LoadedCapability,
} from "./types.js";

export interface LoadCapabilitiesDeps {
  db: Database.Database;
  repo: CapabilityRegistryRepository;
  /** Path to the plugin's bundled `src/capabilities/` directory. May not exist. */
  bundledRoot: string;
  /** Path to `config.paths.capabilitiesDir`. May not exist on first run. */
  userRoot: string;
  logger: Logger;
  /**
   * Optional dashboard registry. When provided, each capability's
   * `dashboard.json` (if present) is parsed and registered. Tests that don't
   * care about dashboards may omit it.
   */
  dashboardRegistry?: DashboardRegistry;
}

export async function loadCapabilities(
  deps: LoadCapabilitiesDeps,
): Promise<CapabilityRegistry> {
  const log = deps.logger.child({ module: "capabilities.loader" });
  const discovered = await discoverCapabilities(
    [deps.bundledRoot, deps.userRoot],
    deps.logger,
  );

  const registry: CapabilityRegistry = new Map();

  for (const entry of discovered) {
    let rawMeta: string;
    try {
      rawMeta = await readFile(entry.metaPath, "utf8");
    } catch (err) {
      throw new ValidationError(
        "STRATA_E_CAPABILITY_INVALID",
        `failed to read ${entry.metaPath}: ${(err as Error).message}`,
        { cause: err },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON5.parse(rawMeta);
    } catch (err) {
      throw new ValidationError(
        "STRATA_E_CAPABILITY_INVALID",
        `${entry.metaPath} is not valid JSON5: ${(err as Error).message}`,
        { cause: err },
      );
    }

    const result = CapabilityMetaSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(
        "STRATA_E_CAPABILITY_INVALID",
        `${entry.metaPath} failed schema validation: ${result.error.message}`,
        { cause: result.error },
      );
    }
    const meta = result.data;

    if (meta.name !== entry.name) {
      throw new ValidationError(
        "STRATA_E_CAPABILITY_INVALID",
        `${entry.metaPath} has name='${meta.name}' but the directory is '${entry.name}' — these must match`,
      );
    }

    const summary = applyCapabilityMigrations(
      deps.db,
      meta.name,
      entry.migrationsPath,
    );
    if (summary.applied.length > 0) {
      log.info("capability migrations applied", {
        name: meta.name,
        applied: summary.applied,
        skipped_count: summary.skipped.length,
      });
    }

    await upsertRegistryRow(deps, meta, entry.metaPath);

    if (deps.dashboardRegistry) {
      await loadCapabilityDashboard({
        dir: entry.path,
        name: meta.name,
        registry: deps.dashboardRegistry,
        logger: deps.logger,
      });
    }

    const loaded: LoadedCapability = {
      meta,
      path: entry.path,
      metaPath: entry.metaPath,
    };
    registry.set(meta.name, loaded);
    log.debug("capability loaded", {
      name: meta.name,
      version: meta.version,
      path: entry.path,
    });
  }

  return registry;
}

async function upsertRegistryRow(
  deps: LoadCapabilitiesDeps,
  meta: ReturnType<typeof CapabilityMetaSchema.parse>,
  metaPath: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await deps.repo.findById(meta.name);
  if (existing) {
    await deps.repo.update(meta.name, {
      version: meta.version,
      status: "active",
      meta_path: metaPath,
      primary_table: meta.primary_table,
    });
    return;
  }
  await deps.repo.insert({
    name: meta.name,
    version: meta.version,
    status: "active",
    meta_path: metaPath,
    primary_table: meta.primary_table,
    created_at: now,
  });
}
