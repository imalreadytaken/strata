import type Database from "better-sqlite3";

import { StateMachineError } from "../../core/errors.js";
import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export type ReextractJobStatus =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed";

export interface ReextractJobRow {
  id: number;
  schema_evolution_id: number;
  capability_name: string;
  strategy: string;
  status: ReextractJobStatus;
  rows_total: number;
  rows_done: number;
  rows_failed: number;
  rows_low_confidence: number;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  started_at: string | null;
  completed_at: string | null;
  last_checkpoint_at: string | null;
  last_error: string | null;
}

const REEXTRACT_JOB_COLUMNS = [
  "schema_evolution_id",
  "capability_name",
  "strategy",
  "status",
  "rows_total",
  "rows_done",
  "rows_failed",
  "rows_low_confidence",
  "estimated_cost_cents",
  "actual_cost_cents",
  "started_at",
  "completed_at",
  "last_checkpoint_at",
  "last_error",
] as const;

export class ReextractJobsRepository extends SQLiteRepository<
  ReextractJobRow,
  number
> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "reextract_jobs", REEXTRACT_JOB_COLUMNS, opts);
  }

  /** State machine: use update() with status='failed' (or 'paused'). */
  override async softDelete(_id: number): Promise<void> {
    throw new StateMachineError(
      "STRATA_E_STATE_TRANSITION",
      "reextract_jobs is a state machine — use update(id, { status: 'failed', last_error }) or 'paused' explicitly",
    );
  }

  /**
   * Atomically increment one of the counter columns by `delta` (default 1).
   * Used by the re-extract worker (P6) to update progress.
   */
  async increment(
    id: number,
    column: "rows_done" | "rows_failed" | "rows_low_confidence",
    delta: number = 1,
  ): Promise<void> {
    this.db
      .prepare(`UPDATE reextract_jobs SET ${column} = ${column} + ? WHERE id = ?`)
      .run(delta, id);
  }
}
