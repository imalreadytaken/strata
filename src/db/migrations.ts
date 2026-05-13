/**
 * Migration runner for system tables and capability migrations.
 *
 * Contract: apply every `NNN_*.sql` file in `dir` exactly once, in
 * lexicographic order, tracking applied filenames + their content checksum
 * in a `_strata_migrations` ledger. Refuse to silently re-run an edited
 * migration (checksum mismatch → throw). One transaction per file.
 *
 * See `openspec/changes/add-db-foundation/specs/database-foundation/spec.md`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import type Database from "better-sqlite3";

import { DatabaseError } from "../core/errors.js";

/** Filenames must look like `001_init_messages.sql`. */
export const MIGRATION_FILE_RE = /^\d{3}_.+\.sql$/;

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS _strata_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  )
`;

interface LedgerRow {
  filename: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationSummary {
  applied: string[];
  skipped: string[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Apply every new migration in `dir` to `db`, in filename order.
 *
 * Returns lists of applied and skipped (already-present-and-unchanged) filenames.
 * Throws `DatabaseError('STRATA_E_DB_MIGRATE_FAILED', ...)` on checksum mismatch.
 */
export function applyMigrations(
  db: Database.Database,
  dir: string,
): MigrationSummary {
  db.exec(LEDGER_DDL);

  const applied: string[] = [];
  const skipped: string[] = [];

  const files = readdirSync(dir)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort();

  const findLedgerRow = db.prepare<[string], LedgerRow>(
    "SELECT filename, checksum, applied_at FROM _strata_migrations WHERE filename = ?",
  );
  const insertLedgerRow = db.prepare(
    "INSERT INTO _strata_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)",
  );

  for (const filename of files) {
    const fullPath = path.join(dir, filename);
    const content = readFileSync(fullPath, "utf8");
    const checksum = sha256(content);

    const existing = findLedgerRow.get(filename);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new DatabaseError(
          "STRATA_E_DB_MIGRATE_FAILED",
          `Migration ${filename} was previously applied with checksum ${existing.checksum} but the file on disk now hashes to ${checksum}. Migrations are immutable — add a new NNN_*.sql file instead.`,
        );
      }
      skipped.push(filename);
      continue;
    }

    const applyOne = db.transaction(() => {
      db.exec(content);
      insertLedgerRow.run(filename, checksum, new Date().toISOString());
    });

    try {
      applyOne();
    } catch (err) {
      throw new DatabaseError(
        "STRATA_E_DB_MIGRATE_FAILED",
        `Migration ${filename} failed: ${(err as Error).message}`,
        { cause: err },
      );
    }

    applied.push(filename);
  }

  return { applied, skipped };
}
