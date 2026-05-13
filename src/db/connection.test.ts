import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseError } from "../core/errors.js";
import { openDatabase } from "./connection.js";

describe("openDatabase", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-db-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("opens a fresh file and applies the four pragmas", () => {
    const dbPath = path.join(tmp, "main.db");
    const db = openDatabase({ path: dbPath });
    try {
      const fk = (db.pragma("foreign_keys", { simple: true }) as number) | 0;
      const journal = db.pragma("journal_mode", { simple: true }) as string;
      const sync = db.pragma("synchronous", { simple: true }) as number;
      const busy = db.pragma("busy_timeout", { simple: true }) as number;
      expect(fk).toBe(1);
      expect(journal.toLowerCase()).toBe("wal");
      expect(sync).toBe(1); // NORMAL = 1
      expect(busy).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("creates the parent directory if missing", () => {
    const dbPath = path.join(tmp, "sub", "nested", "main.db");
    const db = openDatabase({ path: dbPath });
    try {
      expect(db.open).toBe(true);
    } finally {
      db.close();
    }
  });

  it("loads sqlite-vec by default", () => {
    const dbPath = path.join(tmp, "main.db");
    const db = openDatabase({ path: dbPath });
    try {
      const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
      expect(typeof row.v).toBe("string");
      expect(row.v.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("skips sqlite-vec when loadVec is false", () => {
    const dbPath = path.join(tmp, "main.db");
    const db = openDatabase({ path: dbPath, loadVec: false });
    try {
      expect(() => db.prepare("SELECT vec_version() AS v").get()).toThrow();
    } finally {
      db.close();
    }
  });

  it("wraps an OS error in DatabaseError when the parent dir cannot be created", () => {
    // /System/strata-test is on a read-only volume on macOS — mkdirSync fails.
    const dbPath = "/System/strata-test-deny/main.db";
    expect(() => openDatabase({ path: dbPath })).toThrowError(DatabaseError);
    try {
      openDatabase({ path: dbPath });
    } catch (err) {
      expect((err as DatabaseError).code).toBe("STRATA_E_DB_OPEN_FAILED");
      expect((err as DatabaseError).cause).toBeDefined();
    }
  });
});
