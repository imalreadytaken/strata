import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCapabilityMigrations } from "../capabilities/migrations.js";
import { makeHarness, type TestHarness } from "../tools/test_helpers.js";
import { executeWidgetQuery, type WidgetQueryDeps } from "./widget_query.js";

describe("executeWidgetQuery", () => {
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
    const rows: Array<[string, number, string, string]> = [
      ["2026-05-01T09:00:00Z", 4500, "Blue Bottle", "dining"],
      ["2026-05-03T13:00:00Z", 3000, "Cab Inc", "transport"],
      ["2026-05-05T12:30:00Z", 5500, "Sweetgreen", "dining"],
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

  function deps(): WidgetQueryDeps {
    return {
      db: h.db,
      capabilityRegistryRepo: h.runtimeStub.capabilityRegistryRepo,
      logger: h.logger,
    };
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-widget" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("aggregate sum returns the total of amount_minor", async () => {
    await seedExpenses();
    const result = await executeWidgetQuery(deps(), "expenses", {
      aggregate: { fn: "sum", column: "amount_minor" },
    });
    expect("aggregate" in result && result.aggregate.value).toBe(4500 + 3000 + 5500);
  });

  it("rows query honours limit", async () => {
    await seedExpenses();
    const result = await executeWidgetQuery(deps(), "expenses", { limit: 2 });
    expect("rows" in result && result.rows.length).toBe(2);
  });

  it("count aggregate skips column validation for count(*)", async () => {
    await seedExpenses();
    const result = await executeWidgetQuery(deps(), "expenses", {
      aggregate: { fn: "count", column: "id" },
    });
    expect("aggregate" in result && result.aggregate.value).toBe(3);
  });

  it("unknown filter column throws", async () => {
    await seedExpenses();
    await expect(
      executeWidgetQuery(deps(), "expenses", { filter: { ghost: 1 } }),
    ).rejects.toThrow(/filter column 'ghost'/);
  });

  it("unknown capability throws", async () => {
    await expect(
      executeWidgetQuery(deps(), "nope", {}),
    ).rejects.toThrow(/not registered/);
  });
});
