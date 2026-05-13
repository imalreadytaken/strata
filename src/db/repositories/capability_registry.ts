import type Database from "better-sqlite3";

import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export type CapabilityStatus = "active" | "archived" | "deleted";

export interface CapabilityRegistryRow {
  name: string;
  version: number;
  status: CapabilityStatus;
  meta_path: string;
  primary_table: string;
  created_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  proposal_id: number | null;
  build_id: number | null;
}

const CAPABILITY_COLUMNS = [
  "version",
  "status",
  "meta_path",
  "primary_table",
  "created_at",
  "archived_at",
  "deleted_at",
  "proposal_id",
  "build_id",
] as const;

export class CapabilityRegistryRepository extends SQLiteRepository<
  CapabilityRegistryRow,
  string
> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "capability_registry", CAPABILITY_COLUMNS, {
      ...opts,
      pkColumn: "name",
    });
  }

  /** Flip status to 'archived' and stamp archived_at. */
  override async softDelete(name: string): Promise<void> {
    await this.update(name, {
      status: "archived",
      archived_at: this.now(),
    });
  }
}
