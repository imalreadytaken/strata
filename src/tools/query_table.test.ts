import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCapabilityMigrations } from "../capabilities/migrations.js";
import { queryTableTool } from "./query_table.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";
import type { QueryToolDeps } from "./types.js";

describe("strata_query_table", () => {
  let h: TestHarness;

  async function seedExpenses(): Promise<void> {
    const dir = `${h.tmp}/migrations`;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/001_init.sql`,
      `CREATE TABLE expenses (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
         extraction_version INTEGER NOT NULL DEFAULT 1,
         occurred_at TEXT NOT NULL,
         amount_minor INTEGER NOT NULL,
         currency TEXT NOT NULL DEFAULT 'CNY',
         merchant TEXT,
         category TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    applyCapabilityMigrations(h.db, "expenses", dir);
    // Need a parent raw_event so the FK on expenses.raw_event_id is satisfied.
    const msgId = await h.insertMessage();
    const re = await h.rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "committed",
      extracted_data: "{}",
      source_summary: "seed",
      primary_message_id: msgId,
      related_message_ids: JSON.stringify([msgId]),
      extraction_version: 1,
      created_at: "2026-05-13T00:00:00Z",
      updated_at: "2026-05-13T00:00:00Z",
    });
    await h.proposalsRepo; // touch (no-op for ts)
    void re;
    const rows = [
      ["2026-05-01T09:00:00Z", 4500, "Blue Bottle", "dining"],
      ["2026-05-03T13:00:00Z", 3000, "Cab Inc", "transport"],
      ["2026-05-05T12:30:00Z", 5500, "Sweetgreen", "dining"],
      ["2026-05-09T20:00:00Z", 12000, "Apple", "service"],
      ["2026-05-12T08:00:00Z", 4500, "Blue Bottle", "dining"],
    ];
    for (const [occurred_at, amount, merchant, category] of rows) {
      h.db
        .prepare(
          `INSERT INTO expenses (raw_event_id, occurred_at, amount_minor, merchant, category, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(re.id, occurred_at, amount, merchant, category, occurred_at, occurred_at);
    }
    await h.runtimeStub.capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "expenses",
      created_at: "2026-05-13T00:00:00Z",
    });
  }

  function makeQueryDeps(): QueryToolDeps {
    return {
      db: h.db,
      capabilityRegistryRepo: h.runtimeStub.capabilityRegistryRepo,
      logger: h.logger,
    };
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-query" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("filter+limit returns matching rows", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    const res = await tool.execute("c1", {
      capability_name: "expenses",
      filter: { category: "dining" },
      limit: 5,
    });
    const d = res.details as { rows: Array<{ category: string }>; count: number };
    expect(d.rows.every((r) => r.category === "dining")).toBe(true);
    expect(d.count).toBe(3);
  });

  it("sum aggregate returns a number", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    const res = await tool.execute("c2", {
      capability_name: "expenses",
      aggregate: { fn: "sum", column: "amount_minor" },
    });
    const d = res.details as { aggregate: { value: number } };
    expect(d.aggregate.value).toBe(4500 + 3000 + 5500 + 12000 + 4500);
  });

  it("count ignores aggregate.column", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    const res = await tool.execute("c3", {
      capability_name: "expenses",
      filter: { category: "dining" },
      aggregate: { fn: "count", column: "merchant" },
    });
    expect((res.details as { aggregate: { value: number } }).aggregate.value).toBe(3);
  });

  it("since/until filter on occurred_at", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    const res = await tool.execute("c4", {
      capability_name: "expenses",
      since: "2026-05-05T00:00:00Z",
    });
    const d = res.details as { rows: Array<{ occurred_at: string }> };
    expect(d.rows.every((r) => r.occurred_at >= "2026-05-05T00:00:00Z")).toBe(true);
  });

  it("unknown capability throws", async () => {
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    await expect(
      tool.execute("c5", { capability_name: "no-such-cap" }),
    ).rejects.toThrow(/not registered/);
  });

  it("unknown filter column throws", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    await expect(
      tool.execute("c6", {
        capability_name: "expenses",
        filter: { not_a_column: "x" },
      }),
    ).rejects.toThrow(/filter column 'not_a_column'/);
  });

  it("limit > 100 is capped at 100", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    await expect(
      tool.execute("c7", { capability_name: "expenses", limit: 999 }),
    ).rejects.toThrow(); // zod max(100) rejects
  });

  it("select narrows the returned columns", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    const res = await tool.execute("c8", {
      capability_name: "expenses",
      select: ["merchant", "amount_minor"],
      limit: 2,
    });
    const d = res.details as { rows: Array<Record<string, unknown>> };
    expect(Object.keys(d.rows[0] ?? {}).sort()).toEqual(["amount_minor", "merchant"]);
  });

  it("rejects when queryDeps is missing", async () => {
    await seedExpenses();
    const tool = queryTableTool(h.deps);
    await expect(
      tool.execute("c9", { capability_name: "expenses" }),
    ).rejects.toThrow(/queryDeps/);
  });

  it("order_by + order_direction respected", async () => {
    await seedExpenses();
    h.deps.queryDeps = makeQueryDeps();
    const tool = queryTableTool(h.deps);
    const res = await tool.execute("c10", {
      capability_name: "expenses",
      order_by: "amount_minor",
      order_direction: "desc",
      limit: 1,
    });
    const d = res.details as { rows: Array<{ amount_minor: number }> };
    expect(d.rows[0]?.amount_minor).toBe(12000);
  });
});
