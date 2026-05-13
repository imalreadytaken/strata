import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateMachineError, ValidationError } from "../../core/errors.js";
import { openDatabase, type Database } from "../connection.js";
import { SQLiteRepository } from "./base.js";

interface WidgetRow {
  id: number;
  name: string;
  status: "active" | "archived";
  count: number;
}

const WIDGET_COLUMNS = ["name", "status", "count"] as const;

class WidgetsRepo extends SQLiteRepository<WidgetRow> {
  constructor(db: Database) {
    super(db, "widgets", WIDGET_COLUMNS);
  }
}

describe("SQLiteRepository<T> (base behaviour)", () => {
  let tmp: string;
  let db: Database;
  let repo: WidgetsRepo;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-repo-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    db.exec(`
      CREATE TABLE widgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        count INTEGER NOT NULL DEFAULT 0
      );
    `);
    repo = new WidgetsRepo(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("inserts and round-trips", async () => {
    const row = await repo.insert({ name: "first", status: "active", count: 1 });
    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe("first");

    const found = await repo.findById(row.id);
    expect(found).toEqual(row);
  });

  it("findById returns null for missing rows", async () => {
    expect(await repo.findById(999)).toBeNull();
  });

  it("findMany filters, orders, limits, and offsets", async () => {
    await repo.insert({ name: "a", status: "active", count: 3 });
    await repo.insert({ name: "b", status: "active", count: 1 });
    await repo.insert({ name: "c", status: "archived", count: 2 });

    const all = await repo.findMany();
    expect(all).toHaveLength(3);

    const active = await repo.findMany({ status: "active" });
    expect(active).toHaveLength(2);

    const sorted = await repo.findMany({ status: "active" }, {
      orderBy: "count",
      direction: "desc",
    });
    expect(sorted.map((r) => r.name)).toEqual(["a", "b"]);

    const limited = await repo.findMany({}, { limit: 1 });
    expect(limited).toHaveLength(1);

    const offset = await repo.findMany(
      {},
      { orderBy: "name", direction: "asc", offset: 1 },
    );
    expect(offset.map((r) => r.name)).toEqual(["b", "c"]);
  });

  it("count respects the filter", async () => {
    await repo.insert({ name: "a", status: "active", count: 0 });
    await repo.insert({ name: "b", status: "active", count: 0 });
    await repo.insert({ name: "c", status: "archived", count: 0 });
    expect(await repo.count()).toBe(3);
    expect(await repo.count({ status: "active" })).toBe(2);
  });

  it("update applies the patch and returns the new row", async () => {
    const original = await repo.insert({ name: "x", status: "active", count: 0 });
    const updated = await repo.update(original.id, { count: 7 });
    expect(updated.count).toBe(7);
    expect(updated.name).toBe("x");
  });

  it("update with an empty patch returns the existing row without mutation", async () => {
    const original = await repo.insert({ name: "x", status: "active", count: 0 });
    const result = await repo.update(original.id, {});
    expect(result).toEqual(original);
  });

  it("update throws ValidationError on unknown column", async () => {
    const original = await repo.insert({ name: "x", status: "active", count: 0 });
    let caught: unknown;
    try {
      await repo.update(original.id, {
        // @ts-expect-error -- testing runtime validation
        nope: "x",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).code).toBe("STRATA_E_VALIDATION");
  });

  it("update throws ValidationError when the row is missing", async () => {
    await expect(repo.update(9999, { count: 1 })).rejects.toMatchObject({
      code: "STRATA_E_VALIDATION",
    });
  });

  it("base softDelete throws StateMachineError", async () => {
    await expect(repo.softDelete(1)).rejects.toBeInstanceOf(StateMachineError);
  });

  it("transaction commits on success", async () => {
    await repo.transaction(async () => {
      await repo.insert({ name: "tx1", status: "active", count: 0 });
      await repo.insert({ name: "tx2", status: "active", count: 0 });
    });
    expect(await repo.count()).toBe(2);
  });

  it("transaction rolls back on throw", async () => {
    await expect(
      repo.transaction(async () => {
        await repo.insert({ name: "tx-good", status: "active", count: 0 });
        throw new Error("boom");
      }),
    ).rejects.toThrowError("boom");
    expect(await repo.count()).toBe(0);
  });
});
