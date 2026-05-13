import type Database from "better-sqlite3";

import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export type BuildPhase =
  | "plan"
  | "decompose"
  | "build"
  | "integrate"
  | "post_deploy"
  | "done"
  | "failed"
  | "cancelled"
  | "paused";

export type BuildTriggerKind = "user_request" | "reflect_proposal";
export type BuildTargetAction = "create" | "evolve" | "archive";

export interface BuildRow {
  id: number;
  session_id: string;
  trigger_kind: BuildTriggerKind;
  trigger_proposal_id: number | null;
  target_capability: string;
  target_action: BuildTargetAction;
  phase: BuildPhase;
  plan_path: string | null;
  workdir_path: string | null;
  claude_session_id: string | null;
  changes_total: number | null;
  changes_done: number;
  current_change_id: string | null;
  created_at: string;
  paused_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  failure_reason: string | null;
}

const BUILD_COLUMNS = [
  "session_id",
  "trigger_kind",
  "trigger_proposal_id",
  "target_capability",
  "target_action",
  "phase",
  "plan_path",
  "workdir_path",
  "claude_session_id",
  "changes_total",
  "changes_done",
  "current_change_id",
  "created_at",
  "paused_at",
  "completed_at",
  "last_heartbeat_at",
  "failure_reason",
] as const;

export class BuildsRepository extends SQLiteRepository<BuildRow, number> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "builds", BUILD_COLUMNS, opts);
  }

  /** Cancel the build: phase='cancelled', completed_at = now. */
  override async softDelete(id: number): Promise<void> {
    await this.update(id, {
      phase: "cancelled",
      completed_at: this.now(),
    });
  }
}
