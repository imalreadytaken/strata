/**
 * Re-extraction job runner — processes a single `reextract_jobs` row.
 *
 * Looks up the strategy by name, walks the capability's primary table
 * row-by-row, dispatches each through the strategy, accumulates counters,
 * checkpoints every N rows. Per-row try/catch isolates failures.
 */
import type { ReextractJobRow } from "../db/repositories/reextract_jobs.js";
import { defaultRegistry, type ReextractStrategyRegistry } from "./registry.js";
import type {
  ReextractJobOutcome,
  ReextractRow,
  ReextractRunDeps,
} from "./types.js";

const DEFAULT_CHECKPOINT_EVERY_ROWS = 20;

export async function runReextractJob(
  job: ReextractJobRow,
  deps: ReextractRunDeps,
  registry: ReextractStrategyRegistry = defaultRegistry,
): Promise<ReextractJobOutcome> {
  const log = deps.logger.child({ module: "reextract.runner" });
  const checkpointEvery =
    deps.checkpointEveryRows ?? DEFAULT_CHECKPOINT_EVERY_ROWS;

  const strategy = registry.get(job.strategy);
  if (!strategy) {
    return {
      status: "failed",
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
      cost_cents: 0,
      last_error: `unknown_strategy:${job.strategy}`,
    };
  }

  const cap = await deps.capabilityRegistryRepo.findById(job.capability_name);
  if (!cap) {
    return {
      status: "failed",
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
      cost_cents: 0,
      last_error: `capability_not_found:${job.capability_name}`,
    };
  }

  // Fetch row ids first; iterate one at a time.
  let allRows: ReextractRow[];
  try {
    allRows = deps.db
      .prepare(`SELECT * FROM ${cap.primary_table} ORDER BY id ASC`)
      .all() as ReextractRow[];
  } catch (err) {
    return {
      status: "failed",
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
      cost_cents: 0,
      last_error: `select_failed:${(err as Error).message}`,
    };
  }

  await deps.reextractJobsRepo.update(job.id, { rows_total: allRows.length });
  log.info("reextract job starting", {
    job_id: job.id,
    strategy: job.strategy,
    capability: job.capability_name,
    rows_total: allRows.length,
  });

  let rows_done = 0;
  let rows_failed = 0;
  let rows_low_confidence = 0;
  let cost_cents = 0;
  let last_error: string | undefined;
  let processedCount = 0;
  const now = deps.now ?? (() => new Date());

  for (const row of allRows) {
    processedCount++;
    try {
      const outcome = await strategy.process(row, job, deps);
      switch (outcome.kind) {
        case "wrote":
          rows_done++;
          if (outcome.costCents) cost_cents += outcome.costCents;
          break;
        case "low_confidence":
          rows_low_confidence++;
          if (outcome.costCents) cost_cents += outcome.costCents;
          break;
        case "failed":
          rows_failed++;
          last_error = outcome.error;
          break;
        case "skipped":
          // Counts neither — already covered.
          break;
      }
    } catch (err) {
      rows_failed++;
      last_error = (err as Error).message;
      log.warn("reextract row failed", {
        job_id: job.id,
        row_id: row.id,
        error: last_error,
      });
    }

    if (processedCount % checkpointEvery === 0) {
      await deps.reextractJobsRepo.update(job.id, {
        rows_done,
        rows_failed,
        rows_low_confidence,
        actual_cost_cents: cost_cents,
        last_checkpoint_at: now().toISOString(),
      });
    }
  }

  const result: ReextractJobOutcome = {
    status: "done",
    rows_done,
    rows_failed,
    rows_low_confidence,
    cost_cents,
  };
  if (last_error !== undefined) result.last_error = last_error;
  return result;
}
