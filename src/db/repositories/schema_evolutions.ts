import type Database from "better-sqlite3";

import { StateMachineError } from "../../core/errors.js";
import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export type SchemaEvolutionChangeType =
  | "capability_create"
  | "add_column"
  | "modify_column"
  | "remove_column"
  | "rename_column"
  | "add_constraint"
  | "capability_archive"
  | "capability_restore";

export type BackfillStatus =
  | "not_needed"
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "partial";

export interface SchemaEvolutionRow {
  id: number;
  capability_name: string;
  from_version: number;
  to_version: number;
  change_type: SchemaEvolutionChangeType;
  diff: string;                       // JSON string
  openspec_change_id: string | null;
  proposed_at: string;
  approved_at: string | null;
  approved_by: string | null;
  applied_at: string | null;
  backfill_strategy: string | null;
  backfill_status: BackfillStatus | null;
  backfill_job_id: number | null;
}

const SCHEMA_EVOLUTION_COLUMNS = [
  "capability_name",
  "from_version",
  "to_version",
  "change_type",
  "diff",
  "openspec_change_id",
  "proposed_at",
  "approved_at",
  "approved_by",
  "applied_at",
  "backfill_strategy",
  "backfill_status",
  "backfill_job_id",
] as const;

export class SchemaEvolutionsRepository extends SQLiteRepository<
  SchemaEvolutionRow,
  number
> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "schema_evolutions", SCHEMA_EVOLUTION_COLUMNS, opts);
  }

  /** Append-only ledger: history of every schema change. */
  override async softDelete(_id: number): Promise<void> {
    throw new StateMachineError(
      "STRATA_E_STATE_TRANSITION",
      "schema_evolutions is an append-only ledger — history must remain intact for re-extraction to be reproducible",
    );
  }
}
