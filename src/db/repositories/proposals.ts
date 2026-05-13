import type Database from "better-sqlite3";

import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export type ProposalSource = "reflect_agent" | "user_request";
export type ProposalKind =
  | "new_capability"
  | "schema_evolution"
  | "capability_archive"
  | "capability_demote";
export type ProposalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "expired"
  | "applied";

export interface ProposalRow {
  id: number;
  source: ProposalSource;
  kind: ProposalKind;
  target_capability: string | null;
  title: string;
  summary: string;
  rationale: string;
  proposed_design: string | null;       // JSON string
  signal_strength: number | null;
  evidence_event_ids: string | null;    // JSON array string
  estimated_cost_cents: number | null;
  estimated_time_minutes: number | null;
  status: ProposalStatus;
  created_at: string;
  pushed_to_user_at: string | null;
  responded_at: string | null;
  expires_at: string | null;
  cooldown_until: string | null;
  resulting_build_id: number | null;
}

const PROPOSAL_COLUMNS = [
  "source",
  "kind",
  "target_capability",
  "title",
  "summary",
  "rationale",
  "proposed_design",
  "signal_strength",
  "evidence_event_ids",
  "estimated_cost_cents",
  "estimated_time_minutes",
  "status",
  "created_at",
  "pushed_to_user_at",
  "responded_at",
  "expires_at",
  "cooldown_until",
  "resulting_build_id",
] as const;

export class ProposalsRepository extends SQLiteRepository<ProposalRow, number> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "proposals", PROPOSAL_COLUMNS, opts);
  }

  /** Decline the proposal: status='declined', responded_at = now. */
  override async softDelete(id: number): Promise<void> {
    await this.update(id, {
      status: "declined",
      responded_at: this.now(),
    });
  }
}
