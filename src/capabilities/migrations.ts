/**
 * Per-capability migration runner.
 *
 * Mirrors `db/migrations.ts::applyMigrations` but uses a sibling ledger
 * keyed `(capability_name, filename)` so two capabilities can ship
 * `001_init.sql` without colliding.
 *
 * See `openspec/changes/add-capability-loader/design.md` D1.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import type Database from "better-sqlite3";

import { DatabaseError } from "../core/errors.js";
import { MIGRATION_FILE_RE } from "../db/migrations.js";

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS _strata_capability_migrations (
    capability_name TEXT NOT NULL,
    filename        TEXT NOT NULL,
    checksum        TEXT NOT NULL,
    applied_at      TEXT NOT NULL,
    PRIMARY KEY (capability_name, filename)
  )
`;

interface LedgerRow {
  capability_name: string;
  filename: string;
  checksum: string;
  applied_at: string;
}

export interface CapabilityMigrationSummary {
  applied: string[];
  skipped: string[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Apply every new migration in `dir` for capability `capability_name`. The
 * `dir` may not exist — that's a valid empty-migration-set state.
 *
 * Throws `DatabaseError('STRATA_E_CAPABILITY_MIGRATE_FAILED', ...)` on
 * checksum mismatch or SQL failure.
 */
export function applyCapabilityMigrations(
  db: Database.Database,
  capability_name: string,
  dir: string,
): CapabilityMigrationSummary {
  db.exec(LEDGER_DDL);

  if (!existsSync(dir)) {
    return { applied: [], skipped: [] };
  }

  const files = readdirSync(dir)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort();

  const findRow = db.prepare<[string, string], LedgerRow>(
    "SELECT capability_name, filename, checksum, applied_at FROM _strata_capability_migrations WHERE capability_name = ? AND filename = ?",
  );
  const insertRow = db.prepare(
    "INSERT INTO _strata_capability_migrations (capability_name, filename, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    const fullPath = path.join(dir, filename);
    const content = readFileSync(fullPath, "utf8");
    const checksum = sha256(content);

    const existing = findRow.get(capability_name, filename);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new DatabaseError(
          "STRATA_E_CAPABILITY_MIGRATE_FAILED",
          `Capability '${capability_name}' migration ${filename} was applied with checksum ${existing.checksum} but now hashes to ${checksum}. Migrations are immutable — add a new NNN_*.sql file instead.`,
        );
      }
      skipped.push(filename);
      continue;
    }

    const applyOne = db.transaction(() => {
      db.exec(content);
      insertRow.run(
        capability_name,
        filename,
        checksum,
        new Date().toISOString(),
      );
    });

    try {
      applyOne();
    } catch (err) {
      throw new DatabaseError(
        "STRATA_E_CAPABILITY_MIGRATE_FAILED",
        `Capability '${capability_name}' migration ${filename} failed: ${(err as Error).message}`,
        { cause: err },
      );
    }

    applied.push(filename);
  }

  return { applied, skipped };
}
