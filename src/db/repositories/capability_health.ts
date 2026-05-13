import type Database from "better-sqlite3";

import { StateMachineError } from "../../core/errors.js";
import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export interface CapabilityHealthRow {
  capability_name: string;
  total_writes: number;
  total_reads: number;
  total_corrections: number;
  last_write_at: string | null;
  last_read_at: string | null;
  updated_at: string;
}

const CAPABILITY_HEALTH_COLUMNS = [
  "total_writes",
  "total_reads",
  "total_corrections",
  "last_write_at",
  "last_read_at",
  "updated_at",
] as const;

/**
 * `capability_health` is a pure counter table — no lifecycle. Reflect Agent
 * code reads from it to decide whether to propose an archive; thresholds live
 * in code, not in the schema (§3.1: "this table only does mechanical
 * statistics ... the real judgment logic lives in Reflect Agent code").
 */
export class CapabilityHealthRepository extends SQLiteRepository<
  CapabilityHealthRow,
  string
> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "capability_health", CAPABILITY_HEALTH_COLUMNS, {
      ...opts,
      pkColumn: "capability_name",
    });
  }

  override async softDelete(_name: string): Promise<void> {
    throw new StateMachineError(
      "STRATA_E_STATE_TRANSITION",
      "capability_health is a counter table — counters do not 'soft delete'",
    );
  }

  /** Atomically `total_writes += 1`, set `last_write_at` and `updated_at`. */
  async incrementWrite(name: string): Promise<void> {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO capability_health (capability_name, total_writes, last_write_at, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(capability_name) DO UPDATE SET
           total_writes = total_writes + 1,
           last_write_at = excluded.last_write_at,
           updated_at    = excluded.updated_at`,
      )
      .run(name, now, now);
  }

  /** Atomically `total_reads += 1`, set `last_read_at` and `updated_at`. */
  async incrementRead(name: string): Promise<void> {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO capability_health (capability_name, total_reads, last_read_at, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(capability_name) DO UPDATE SET
           total_reads = total_reads + 1,
           last_read_at = excluded.last_read_at,
           updated_at   = excluded.updated_at`,
      )
      .run(name, now, now);
  }

  /** Atomically `total_corrections += 1`, set `updated_at`. */
  async incrementCorrection(name: string): Promise<void> {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO capability_health (capability_name, total_corrections, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(capability_name) DO UPDATE SET
           total_corrections = total_corrections + 1,
           updated_at        = excluded.updated_at`,
      )
      .run(name, now);
  }
}
