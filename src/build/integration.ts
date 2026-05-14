/**
 * Build Bridge — integration phase.
 *
 * Picks up a `ready_for_integration` BuildRunResult, moves each capability
 * from the workdir into the user data dir, registers it in the DB, and
 * marks the proposal/build as applied/done. Per-capability transactional:
 * a mid-flight DB failure rolls back the FS move. Multi-capability
 * partial success is supported — capabilities that landed stay.
 *
 * See `openspec/changes/add-build-integration/specs/build-integration/spec.md`.
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import type Database from "better-sqlite3";
import JSON5 from "json5";

import { applyCapabilityMigrations } from "../capabilities/migrations.js";
import { CapabilityMetaSchema } from "../capabilities/types.js";
import type { Logger } from "../core/logger.js";
import type { BuildsRepository } from "../db/repositories/builds.js";
import type { CapabilityHealthRepository } from "../db/repositories/capability_health.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { ProposalsRepository } from "../db/repositories/proposals.js";
import type { SchemaEvolutionsRepository } from "../db/repositories/schema_evolutions.js";
import type { BuildRunResult } from "./orchestrator.js";

export interface IntegratedCapability {
  name: string;
  version: number;
  installedPath: string;
  metaPath: string;
}

export interface IntegrationDeps {
  buildsRepo: BuildsRepository;
  proposalsRepo: ProposalsRepository;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  schemaEvolutionsRepo: SchemaEvolutionsRepository;
  db: Database.Database;
  userCapabilitiesDir: string;
  logger: Logger;
}

export interface RunIntegrationOptions {
  buildResult: BuildRunResult & { status: "ready_for_integration" };
  deps: IntegrationDeps;
}

interface IntegrationResultSuccess {
  status: "integrated";
  build_id: number;
  integrated: IntegratedCapability[];
}

interface IntegrationResultFailure {
  status: "failed";
  build_id: number;
  failureReason: string;
  integrated: IntegratedCapability[];
}

export type IntegrationResult =
  | IntegrationResultSuccess
  | IntegrationResultFailure;

function nowIso(): string {
  return new Date().toISOString();
}

interface DiscoveredCapability {
  name: string;
  version: number;
  srcDir: string;
}

/**
 * Walk `<workdir>/capabilities/<name>/` subdirs. For each `<name>/`, pick the
 * highest-numbered `v<N>/` (matching the loader's pick policy when `current/`
 * isn't present). Returns `[]` when no capabilities are present.
 */
function discoverProducedCapabilities(workdir: string): DiscoveredCapability[] {
  const root = path.join(workdir, "capabilities");
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => {
      try {
        return statSync(path.join(root, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const out: DiscoveredCapability[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let versions: Array<{ v: number; p: string }> = [];
    try {
      versions = readdirSync(dir)
        .map((d) => d.match(/^v(\d+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => {
          const v = Number.parseInt(m[1]!, 10);
          const p = path.join(dir, `v${v}`);
          return { v, p };
        })
        .filter(({ p }) => existsSync(path.join(p, "meta.json")));
    } catch {
      continue;
    }
    if (versions.length === 0) continue;
    versions.sort((a, b) => b.v - a.v);
    const top = versions[0]!;
    out.push({ name, version: top.v, srcDir: top.p });
  }
  return out;
}

async function readMeta(metaPath: string): Promise<{ name: string; primary_table: string; version: number }> {
  const raw = await readFile(metaPath, "utf8");
  const parsed = CapabilityMetaSchema.parse(JSON5.parse(raw));
  return { name: parsed.name, primary_table: parsed.primary_table, version: parsed.version };
}

async function integrateOneCapability(
  discovered: DiscoveredCapability,
  deps: IntegrationDeps,
): Promise<IntegratedCapability> {
  const destBase = path.join(deps.userCapabilitiesDir, discovered.name);
  const destDir = path.join(destBase, `v${discovered.version}`);
  if (existsSync(destDir)) {
    throw new Error(
      `version_conflict: ${discovered.name}/v${discovered.version} already exists at ${destDir}`,
    );
  }
  // Step 1: FS copy.
  cpSync(discovered.srcDir, destDir, { recursive: true });

  // Step 2-5: DB writes with FS rollback on failure.
  try {
    const metaPath = path.join(destDir, "meta.json");
    const meta = await readMeta(metaPath);

    const migrationsDir = path.join(destDir, "migrations");
    if (existsSync(migrationsDir)) {
      applyCapabilityMigrations(deps.db, meta.name, migrationsDir);
    }

    const existing = await deps.capabilityRegistryRepo.findById(meta.name);
    if (existing) {
      await deps.capabilityRegistryRepo.update(meta.name, {
        version: meta.version,
        status: "active",
        meta_path: metaPath,
        primary_table: meta.primary_table,
      });
    } else {
      await deps.capabilityRegistryRepo.insert({
        name: meta.name,
        version: meta.version,
        status: "active",
        meta_path: metaPath,
        primary_table: meta.primary_table,
        created_at: nowIso(),
      });
    }

    // capability_health row (only if missing — the FK references registry).
    const existingHealth = await deps.capabilityHealthRepo.findById(meta.name);
    if (!existingHealth) {
      await deps.capabilityHealthRepo.insert({
        capability_name: meta.name,
        total_writes: 0,
        total_reads: 0,
        total_corrections: 0,
        updated_at: nowIso(),
      });
    }

    // schema_evolutions row: capability_create from 0 to version.
    await deps.schemaEvolutionsRepo.insert({
      capability_name: meta.name,
      from_version: 0,
      to_version: meta.version,
      change_type: "capability_create",
      diff: JSON.stringify({ kind: "capability_create" }),
      proposed_at: nowIso(),
      approved_at: nowIso(),
      approved_by: "user",
      applied_at: nowIso(),
      backfill_strategy: "none",
      backfill_status: "not_needed",
    });

    return {
      name: meta.name,
      version: meta.version,
      installedPath: destDir,
      metaPath,
    };
  } catch (e) {
    // Roll back the FS copy.
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch (rmErr) {
      deps.logger.warn("integration rollback failed to remove destDir", {
        destDir,
        rmError: (rmErr as Error).message,
      });
    }
    throw e;
  }
}

export async function runIntegration(
  opts: RunIntegrationOptions,
): Promise<IntegrationResult> {
  const { buildResult, deps } = opts;
  if (buildResult.status !== "ready_for_integration") {
    throw new Error(
      `runIntegration: build is not ready (status='${buildResult.status}')`,
    );
  }
  const log = deps.logger.child({ module: "build.integration" });

  const discovered = discoverProducedCapabilities(buildResult.workdir);
  if (discovered.length === 0) {
    await deps.buildsRepo.update(buildResult.build_id, {
      phase: "failed",
      completed_at: nowIso(),
      last_heartbeat_at: nowIso(),
      failure_reason: "no_capabilities_in_workdir",
    });
    return {
      status: "failed",
      build_id: buildResult.build_id,
      failureReason: "no_capabilities_in_workdir",
      integrated: [],
    };
  }

  const integrated: IntegratedCapability[] = [];
  let failureReason: string | null = null;
  for (const d of discovered) {
    try {
      const result = await integrateOneCapability(d, deps);
      integrated.push(result);
      log.info("capability integrated", {
        name: result.name,
        version: result.version,
        path: result.installedPath,
      });
    } catch (e) {
      failureReason = `${d.name}_failed: ${(e as Error).message}`;
      log.error("capability integration failed", {
        name: d.name,
        error: (e as Error).message,
      });
      break;
    }
  }

  if (failureReason !== null) {
    await deps.buildsRepo.update(buildResult.build_id, {
      phase: "failed",
      completed_at: nowIso(),
      last_heartbeat_at: nowIso(),
      failure_reason: failureReason,
    });
    return {
      status: "failed",
      build_id: buildResult.build_id,
      failureReason,
      integrated,
    };
  }

  // All capabilities integrated cleanly — mark proposal applied + build done.
  const build = await deps.buildsRepo.findById(buildResult.build_id);
  if (build?.trigger_proposal_id) {
    await deps.proposalsRepo.update(build.trigger_proposal_id, {
      status: "applied",
      responded_at: nowIso(),
      resulting_build_id: buildResult.build_id,
    });
  }
  await deps.buildsRepo.update(buildResult.build_id, {
    phase: "done",
    completed_at: nowIso(),
    last_heartbeat_at: nowIso(),
  });

  return {
    status: "integrated",
    build_id: buildResult.build_id,
    integrated,
  };
}
