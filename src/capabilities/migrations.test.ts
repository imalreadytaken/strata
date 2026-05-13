import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { applyCapabilityMigrations } from "./migrations.js";

function writeMigration(dir: string, filename: string, sql: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), sql);
}

describe("applyCapabilityMigrations", () => {
  let tmp: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-cap-mig-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("applies migrations and records ledger rows", async () => {
    const dir = path.join(tmp, "expenses-migrations");
    writeMigration(
      dir,
      "001_init.sql",
      "CREATE TABLE expenses (id INTEGER PRIMARY KEY);",
    );
    const summary = applyCapabilityMigrations(db, "expenses", dir);
    expect(summary.applied).toEqual(["001_init.sql"]);
    expect(summary.skipped).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'")
      .all();
    expect(tables).toHaveLength(1);

    const ledger = db
      .prepare(
        "SELECT capability_name, filename FROM _strata_capability_migrations",
      )
      .all() as Array<{ capability_name: string; filename: string }>;
    expect(ledger).toEqual([
      { capability_name: "expenses", filename: "001_init.sql" },
    ]);
  });

  it("two capabilities with 001_init.sql both apply cleanly", async () => {
    const eDir = path.join(tmp, "e-mig");
    const mDir = path.join(tmp, "m-mig");
    writeMigration(
      eDir,
      "001_init.sql",
      "CREATE TABLE expenses (id INTEGER PRIMARY KEY);",
    );
    writeMigration(
      mDir,
      "001_init.sql",
      "CREATE TABLE moods (id INTEGER PRIMARY KEY);",
    );
    expect(applyCapabilityMigrations(db, "expenses", eDir).applied).toEqual([
      "001_init.sql",
    ]);
    expect(applyCapabilityMigrations(db, "moods", mDir).applied).toEqual([
      "001_init.sql",
    ]);
    const ledger = db
      .prepare("SELECT capability_name FROM _strata_capability_migrations")
      .all() as Array<{ capability_name: string }>;
    expect(ledger.map((r) => r.capability_name).sort()).toEqual([
      "expenses",
      "moods",
    ]);
  });

  it("idempotent re-run skips applied migrations", async () => {
    const dir = path.join(tmp, "mig");
    writeMigration(
      dir,
      "001_init.sql",
      "CREATE TABLE expenses (id INTEGER PRIMARY KEY);",
    );
    applyCapabilityMigrations(db, "expenses", dir);
    const second = applyCapabilityMigrations(db, "expenses", dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001_init.sql"]);
  });

  it("checksum mismatch throws", async () => {
    const dir = path.join(tmp, "mig");
    writeMigration(
      dir,
      "001_init.sql",
      "CREATE TABLE expenses (id INTEGER PRIMARY KEY);",
    );
    applyCapabilityMigrations(db, "expenses", dir);
    // Edit on disk.
    writeFileSync(
      path.join(dir, "001_init.sql"),
      "CREATE TABLE expenses (id INTEGER PRIMARY KEY, note TEXT);",
    );
    expect(() => applyCapabilityMigrations(db, "expenses", dir)).toThrow(
      /checksum/,
    );
  });

  it("returns empty for missing migrations dir", async () => {
    const summary = applyCapabilityMigrations(
      db,
      "no-mig",
      path.join(tmp, "does-not-exist"),
    );
    expect(summary).toEqual({ applied: [], skipped: [] });
  });
});
