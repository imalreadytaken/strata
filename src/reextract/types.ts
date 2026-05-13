/**
 * Re-extraction Worker — types.
 *
 * Each strategy receives a row + the job + deps; returns a tagged
 * `StrategyOutcome` the runner uses to increment per-job counters.
 */
import type Database from "better-sqlite3";

import type { Logger } from "../core/logger.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { ReextractJobRow, ReextractJobsRepository } from "../db/repositories/reextract_jobs.js";
import type { SchemaEvolutionsRepository } from "../db/repositories/schema_evolutions.js";
import type { LLMClient } from "../triage/index.js";

export type StrategyOutcome =
  | { kind: "wrote"; confidence: number; costCents?: number }
  | { kind: "low_confidence"; confidence: number; costCents?: number }
  | { kind: "failed"; error: string }
  | { kind: "skipped"; reason: string };

/** Generic row shape: strategies read columns from the capability's primary table. */
export type ReextractRow = Record<string, unknown> & { id: number };

export interface ReextractRunDeps {
  db: Database.Database;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  reextractJobsRepo: ReextractJobsRepository;
  schemaEvolutionsRepo: SchemaEvolutionsRepository;
  logger: Logger;
  llmClient?: LLMClient;
  now?: () => Date;
  /** How many processed rows between `last_checkpoint_at` updates. Defaults to 20. */
  checkpointEveryRows?: number;
}

export interface ReextractStrategy {
  name: string;
  process(
    row: ReextractRow,
    job: ReextractJobRow,
    deps: ReextractRunDeps,
  ): Promise<StrategyOutcome>;
}

export interface ReextractJobOutcome {
  status: "done" | "failed";
  rows_done: number;
  rows_failed: number;
  rows_low_confidence: number;
  cost_cents: number;
  last_error?: string;
}
