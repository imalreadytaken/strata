/**
 * Capability pipeline runner.
 *
 * `runPipeline` dynamically imports `<loaded.path>/<owner_pipeline>` and
 * invokes its `ingest(rawEvent, deps)` export inside a SQLite transaction.
 * `runPipelineForEvent` is the higher-level wrapper `commitEventCore` calls:
 * it handles the "is the capability bound?" + "is it loaded?" + "update
 * raw_events.business_row_id + bump capability_health" sequence.
 *
 * Failures are isolated: a pipeline throw rolls back ITS business-table
 * writes but does NOT undo the upstream `raw_events.status='committed'`
 * transition. The user's fact stays preserved; a future re-extraction
 * worker can reconcile the missing business row.
 *
 * See `openspec/changes/add-pipeline-runner/specs/pipeline-runner/spec.md`.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type Database from "better-sqlite3";

import { ValidationError, DatabaseError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { CapabilityHealthRepository } from "../db/repositories/capability_health.js";
import type {
  RawEventRow,
  RawEventsRepository,
} from "../db/repositories/raw_events.js";
import type { CapabilityRegistry, LoadedCapability } from "./types.js";

export interface PipelineDeps {
  db: Database.Database;
  logger: Logger;
  now: () => string;
}

export interface PipelineIngestResult {
  business_row_id: number;
  business_table: string;
}

export interface PipelineModule {
  ingest: (rawEvent: RawEventRow, deps: PipelineDeps) => Promise<PipelineIngestResult>;
}

export interface PipelineToolDeps {
  db: Database.Database;
  registry: CapabilityRegistry;
  rawEventsRepo: RawEventsRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  logger: Logger;
  now?: () => string;
}

/**
 * Low-level runner: import the capability's `pipeline.ts` module, invoke
 * `ingest` inside a transaction, return its result. Throws on contract
 * violations (`STRATA_E_PIPELINE_INVALID`) or pipeline failures
 * (`STRATA_E_PIPELINE_FAILED`, preserving `cause`).
 */
export async function runPipeline(
  loaded: LoadedCapability,
  rawEvent: RawEventRow,
  deps: PipelineDeps,
): Promise<PipelineIngestResult> {
  const pipelinePath = path.join(loaded.path, loaded.meta.owner_pipeline);
  const pipelineUrl = pathToFileURL(pipelinePath).href;

  let mod: Partial<PipelineModule>;
  try {
    mod = (await import(pipelineUrl)) as Partial<PipelineModule>;
  } catch (err) {
    throw new ValidationError(
      "STRATA_E_PIPELINE_INVALID",
      `failed to import ${pipelinePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  if (typeof mod.ingest !== "function") {
    throw new ValidationError(
      "STRATA_E_PIPELINE_INVALID",
      `${pipelinePath} must export an async function 'ingest'`,
    );
  }
  const ingest = mod.ingest;

  // Run inside a transaction so partial pipeline writes roll back on throw.
  // better-sqlite3's sync `db.transaction()` can't await, so we emit
  // BEGIN/COMMIT/ROLLBACK manually (same pattern as the repository base).
  deps.db.exec("BEGIN");
  let result: PipelineIngestResult;
  try {
    result = await ingest(rawEvent, deps);
  } catch (err) {
    deps.db.exec("ROLLBACK");
    throw new DatabaseError(
      "STRATA_E_PIPELINE_FAILED",
      `pipeline for capability '${loaded.meta.name}' threw on raw_event #${rawEvent.id}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  deps.db.exec("COMMIT");
  return result;
}

export interface RunPipelineForEventArgs {
  rawEvent: RawEventRow;
  toolDeps: PipelineToolDeps;
}

export interface RunPipelineForEventResult {
  capability_written: boolean;
  business_row_id?: number;
}

/**
 * High-level wrapper used from `commitEventCore`. Handles unbound /
 * unknown-capability / pipeline-failed cases by logging and returning
 * `{ capability_written: false }` — the caller's commit must NOT fail.
 */
export async function runPipelineForEvent(
  args: RunPipelineForEventArgs,
): Promise<RunPipelineForEventResult> {
  const { rawEvent, toolDeps } = args;
  const log = toolDeps.logger.child({ module: "capabilities.pipeline_runner" });

  if (!rawEvent.capability_name) {
    return { capability_written: false };
  }
  const loaded = toolDeps.registry.get(rawEvent.capability_name);
  if (!loaded) {
    log.warn("raw_event bound to capability not in registry; skipping pipeline", {
      event_id: rawEvent.id,
      capability_name: rawEvent.capability_name,
    });
    return { capability_written: false };
  }

  const deps: PipelineDeps = {
    db: toolDeps.db,
    logger: toolDeps.logger,
    now: toolDeps.now ?? (() => new Date().toISOString()),
  };

  let result: PipelineIngestResult;
  try {
    result = await runPipeline(loaded, rawEvent, deps);
  } catch (err) {
    log.error("pipeline failed; raw_event remains committed without business row", {
      event_id: rawEvent.id,
      capability_name: rawEvent.capability_name,
      error: (err as Error).message,
      code: (err as { code?: string }).code,
    });
    return { capability_written: false };
  }

  await toolDeps.rawEventsRepo.update(rawEvent.id, {
    business_row_id: result.business_row_id,
  });
  await toolDeps.capabilityHealthRepo.incrementWrite(rawEvent.capability_name);

  return {
    capability_written: true,
    business_row_id: result.business_row_id,
  };
}
