import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseError } from "../core/errors.js";
import { openDatabase, type Database } from "./connection.js";
import { applyMigrations, MIGRATION_FILE_RE } from "./migrations.js";

describe("MIGRATION_FILE_RE", () => {
  it("matches NNN_*.sql filenames", () => {
    expect(MIGRATION_FILE_RE.test("001_init.sql")).toBe(true);
    expect(MIGRATION_FILE_RE.test("999_anything-here.sql")).toBe(true);
  });

  it("rejects non-conforming names", () => {
    expect(MIGRATION_FILE_RE.test("foo.sql")).toBe(false);
    expect(MIGRATION_FILE_RE.test("1_init.sql")).toBe(false);
    expect(MIGRATION_FILE_RE.test("0001_init.sql")).toBe(false);
    expect(MIGRATION_FILE_RE.test("001_init.txt")).toBe(false);
    expect(MIGRATION_FILE_RE.test("001-init.sql")).toBe(false);
  });
});

describe("applyMigrations", () => {
  let tmp: string;
  let migrationsDir: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-mig-"));
    migrationsDir = path.join(tmp, "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const write = (name: string, sql: string): void => {
    writeFileSync(path.join(migrationsDir, name), sql, "utf8");
  };

  it("applies every migration in order on a fresh DB", () => {
    write("001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    write("002_b.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    const summary = applyMigrations(db, migrationsDir);
    expect(summary.applied).toEqual(["001_a.sql", "002_b.sql"]);
    expect(summary.skipped).toEqual([]);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["_strata_migrations", "a", "b"]),
    );
  });

  it("skips already-applied migrations on a second call", () => {
    write("001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    applyMigrations(db, migrationsDir);
    const summary = applyMigrations(db, migrationsDir);
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toEqual(["001_a.sql"]);
  });

  it("rejects an edited migration with STRATA_E_DB_MIGRATE_FAILED", () => {
    write("001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    applyMigrations(db, migrationsDir);
    write("001_a.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);");
    expect(() => applyMigrations(db, migrationsDir)).toThrowError(DatabaseError);
    try {
      applyMigrations(db, migrationsDir);
    } catch (err) {
      const e = err as DatabaseError;
      expect(e.code).toBe("STRATA_E_DB_MIGRATE_FAILED");
      expect(e.message).toContain("001_a.sql");
    }
  });

  it("ignores non-matching filenames", () => {
    write("foo.sql", "CREATE TABLE foo (id INTEGER PRIMARY KEY);");
    write("001_real.sql", "CREATE TABLE real_t (id INTEGER PRIMARY KEY);");
    const summary = applyMigrations(db, migrationsDir);
    expect(summary.applied).toEqual(["001_real.sql"]);
    const fooExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'foo'")
      .get();
    expect(fooExists).toBeUndefined();
  });

  it("wraps a SQL failure in DatabaseError without poisoning the ledger", () => {
    write("001_broken.sql", "CREATE TABLE WHAT THE HECK;");
    expect(() => applyMigrations(db, migrationsDir)).toThrowError(DatabaseError);
    // Re-running with the same broken file should still throw (not skip).
    expect(() => applyMigrations(db, migrationsDir)).toThrowError(DatabaseError);
    // After fixing, it should apply.
    write("001_broken.sql", "CREATE TABLE ok_t (id INTEGER PRIMARY KEY);");
    const summary = applyMigrations(db, migrationsDir);
    expect(summary.applied).toEqual(["001_broken.sql"]);
  });
});
