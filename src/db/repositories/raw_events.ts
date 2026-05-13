import type Database from "better-sqlite3";

import { StateMachineError } from "../../core/errors.js";
import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export type RawEventStatus =
  | "pending"
  | "committed"
  | "superseded"
  | "abandoned";

export interface RawEventRow {
  id: number;
  session_id: string;
  event_type: string;
  status: RawEventStatus;
  extracted_data: string;        // JSON string
  source_summary: string;
  primary_message_id: number;
  related_message_ids: string;   // JSON array string, default '[]'
  event_occurred_at: string | null;
  committed_at: string | null;
  supersedes_event_id: number | null;
  superseded_by_event_id: number | null;
  abandoned_reason: string | null;
  capability_name: string | null;
  business_row_id: number | null;
  extraction_version: number;
  extraction_confidence: number | null;
  extraction_errors: string | null;
  created_at: string;
  updated_at: string;
}

const RAW_EVENT_COLUMNS = [
  "session_id",
  "event_type",
  "status",
  "extracted_data",
  "source_summary",
  "primary_message_id",
  "related_message_ids",
  "event_occurred_at",
  "committed_at",
  "supersedes_event_id",
  "superseded_by_event_id",
  "abandoned_reason",
  "capability_name",
  "business_row_id",
  "extraction_version",
  "extraction_confidence",
  "extraction_errors",
  "created_at",
  "updated_at",
] as const;

export class RawEventsRepository extends SQLiteRepository<RawEventRow, number> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "raw_events", RAW_EVENT_COLUMNS, opts);
  }

  /**
   * Append-only ledger. AGENTS.md #1: never DELETE or UPDATE rows in
   * raw_events. For corrections, use the `supersedes_event_id` chain via
   * the `strata_supersede_event` tool (P2). For abandons, transition the
   * pending row via `update(id, { status: 'abandoned', abandoned_reason })`.
   */
  override async softDelete(_id: number): Promise<void> {
    throw new StateMachineError(
      "STRATA_E_STATE_TRANSITION",
      "raw_events is append-only (AGENTS.md #1) — use supersedes_event_id for corrections or transition status to 'abandoned' via update()",
    );
  }

  /**
   * Returns all `pending` raw_events whose `created_at` is older than
   * `now - timeoutMinutes`. Used by the pending-buffer timeout loop (P2).
   */
  async findExpiredPending(timeoutMinutes: number): Promise<RawEventRow[]> {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60_000).toISOString();
    const rows = this.db
      .prepare(
        "SELECT * FROM raw_events WHERE status = 'pending' AND created_at < ?",
      )
      .all(cutoff);
    return rows as RawEventRow[];
  }
}
