/**
 * Strata SQLite connection.
 *
 * Wraps `better-sqlite3` with the pragmas every Strata table assumes
 * (foreign keys on, WAL journal, ms-precision busy timeout), and loads the
 * `sqlite-vec` extension so subsequent code can `SELECT vec_distance_*` etc.
 *
 * See `openspec/changes/add-db-foundation/specs/database-foundation/spec.md`.
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { DatabaseError } from "../core/errors.js";

export type { Database };

export interface OpenDatabaseOptions {
  /** Absolute path to the SQLite file. Parent dirs are created if missing. */
  path: string;
  /** Load the sqlite-vec extension at open time. Default: `true`. */
  loadVec?: boolean;
}

/**
 * Open (and create if needed) a SQLite database configured for Strata.
 *
 * Throws `DatabaseError('STRATA_E_DB_OPEN_FAILED', ...)` if the file cannot
 * be opened or sqlite-vec cannot be loaded.
 */
export function openDatabase(opts: OpenDatabaseOptions): Database.Database {
  try {
    mkdirSync(path.dirname(opts.path), { recursive: true });
  } catch (err) {
    throw new DatabaseError(
      "STRATA_E_DB_OPEN_FAILED",
      `Failed to create parent directory for ${opts.path}`,
      { cause: err },
    );
  }

  let db: Database.Database;
  try {
    db = new Database(opts.path);
  } catch (err) {
    throw new DatabaseError(
      "STRATA_E_DB_OPEN_FAILED",
      `Failed to open SQLite database at ${opts.path}`,
      { cause: err },
    );
  }

  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
  } catch (err) {
    db.close();
    throw new DatabaseError(
      "STRATA_E_DB_OPEN_FAILED",
      `Failed to apply pragmas on ${opts.path}`,
      { cause: err },
    );
  }

  if (opts.loadVec !== false) {
    try {
      sqliteVec.load(db);
      // Sanity-check: confirm the extension is actually present.
      db.prepare("SELECT vec_version() AS v").get();
    } catch (err) {
      db.close();
      throw new DatabaseError(
        "STRATA_E_DB_OPEN_FAILED",
        `Failed to load sqlite-vec extension on ${opts.path}`,
        { cause: err },
      );
    }
  }

  return db;
}
