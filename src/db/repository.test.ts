/**
 * Type-only test: ensure a concrete class can implement `Repository<T>`.
 *
 * If a later change removes a method from the interface, or changes a signature
 * in a way that breaks downstream impls, this test will fail at typecheck
 * time even though `npm test` itself passes — that's the point.
 */
import { describe, expect, it } from "vitest";

import type { FindManyOptions, Repository } from "./repository.js";

interface MockRow {
  id: number;
  name: string;
  status: "active" | "archived";
}

class MockRepo implements Repository<MockRow> {
  private rows = new Map<number, MockRow>();
  private seq = 0;

  async findById(id: number): Promise<MockRow | null> {
    return this.rows.get(id) ?? null;
  }

  async findMany(
    filter: Partial<MockRow> = {},
    options: FindManyOptions<MockRow> = {},
  ): Promise<MockRow[]> {
    let out = [...this.rows.values()].filter((row) =>
      Object.entries(filter).every(([k, v]) => row[k as keyof MockRow] === v),
    );
    if (options.orderBy) {
      const key = options.orderBy;
      out.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0));
      if (options.direction === "desc") out.reverse();
    }
    if (options.offset) out = out.slice(options.offset);
    if (options.limit !== undefined) out = out.slice(0, options.limit);
    return out;
  }

  async count(filter: Partial<MockRow> = {}): Promise<number> {
    return (await this.findMany(filter)).length;
  }

  async insert(data: Omit<MockRow, "id">): Promise<MockRow> {
    const id = ++this.seq;
    const row: MockRow = { id, ...data };
    this.rows.set(id, row);
    return row;
  }

  async update(
    id: number,
    patch: Partial<Omit<MockRow, "id">>,
  ): Promise<MockRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error("not found");
    const updated = { ...existing, ...patch };
    this.rows.set(id, updated);
    return updated;
  }

  async softDelete(id: number): Promise<void> {
    await this.update(id, { status: "archived" });
  }

  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    return fn();
  }
}

describe("Repository contract", () => {
  it("a class implementing Repository<T> compiles and the methods round-trip", async () => {
    const repo: Repository<MockRow> = new MockRepo();
    const row = await repo.insert({ name: "first", status: "active" });
    expect(row.id).toBe(1);

    const fetched = await repo.findById(1);
    expect(fetched?.name).toBe("first");

    await repo.update(1, { name: "renamed" });
    expect((await repo.findById(1))?.name).toBe("renamed");

    expect(await repo.count()).toBe(1);

    await repo.softDelete(1);
    expect((await repo.findById(1))?.status).toBe("archived");

    const inTx = await repo.transaction(async () => 42);
    expect(inTx).toBe(42);
  });
});
