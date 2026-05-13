import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCapabilityMigrations } from "../capabilities/migrations.js";
import { makeHarness, type TestHarness } from "../tools/test_helpers.js";
import { DashboardRegistry } from "./registry.js";
import { renderDashboard, type RenderDashboardDeps } from "./renderer.js";
import type { Dashboard } from "./types.js";

describe("renderDashboard", () => {
  let h: TestHarness;
  let registry: DashboardRegistry;

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

  function deps(): RenderDashboardDeps {
    return {
      db: h.db,
      capabilityRegistryRepo: h.runtimeStub.capabilityRegistryRepo,
      dashboardRegistry: registry,
      logger: h.logger,
    };
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-render" });
    registry = new DashboardRegistry(h.logger);
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("empty registry produces a friendly placeholder", async () => {
    const r = await renderDashboard(deps());
    expect(r.widget_count).toBe(0);
    expect(r.capability_count).toBe(0);
    expect(r.markdown.length).toBeGreaterThan(0);
  });

  it("missing capability_name yields (no widgets configured)", async () => {
    const r = await renderDashboard(deps(), "ghost");
    expect(r.markdown).toContain("no dashboard widgets configured");
    expect(r.widget_count).toBe(0);
  });

  it("KPI sum renders as money with currency suffix", async () => {
    await seedExpenses();
    const dashboard: Dashboard = {
      widgets: [
        {
          kind: "kpi",
          title: "Total",
          format: "money",
          query: { aggregate: { fn: "sum", column: "amount_minor" } },
        },
      ],
    };
    registry.register("expenses", dashboard);
    const r = await renderDashboard(deps(), "expenses");
    // 4500 + 3000 + 5500 = 13000 minor units → 130.00 CNY
    expect(r.markdown).toContain("¥130.00 (CNY)");
    expect(r.widget_count).toBe(1);
  });

  it("KPI count renders an integer", async () => {
    await seedExpenses();
    registry.register("expenses", {
      widgets: [
        {
          kind: "kpi",
          title: "Count",
          format: "count",
          query: { aggregate: { fn: "count", column: "id" } },
        },
      ],
    });
    const r = await renderDashboard(deps(), "expenses");
    expect(r.markdown).toMatch(/Count: 3/);
  });

  it("list widget renders 1-indexed bullets with merchant + money + date", async () => {
    await seedExpenses();
    registry.register("expenses", {
      widgets: [
        {
          kind: "list",
          title: "Top",
          format: "text",
          query: { order_by: "amount_minor", order_direction: "desc", limit: 2 },
        },
      ],
    });
    const r = await renderDashboard(deps(), "expenses");
    expect(r.markdown).toContain("*Top*");
    expect(r.markdown).toContain("1. Sweetgreen");
    expect(r.markdown).toContain("2. Blue Bottle");
    expect(r.markdown).toContain("¥55.00 (CNY)");
    expect(r.markdown).toContain("2026-05-05");
  });

  it("widget failure renders inline ⚠️ without taking down siblings", async () => {
    await seedExpenses();
    registry.register("expenses", {
      widgets: [
        {
          kind: "kpi",
          title: "OK",
          format: "count",
          query: { aggregate: { fn: "count", column: "id" } },
        },
        {
          kind: "kpi",
          title: "Bad",
          format: "money",
          query: {
            aggregate: { fn: "sum", column: "amount_minor" },
            filter: { ghost_column: 1 },
          },
        },
      ],
    });
    const r = await renderDashboard(deps(), "expenses");
    expect(r.markdown).toMatch(/OK: 3/);
    expect(r.markdown).toMatch(/Bad: ⚠️/);
    expect(r.widget_count).toBe(2);
  });

  it("no capability_name iterates the registry alphabetically", async () => {
    await seedExpenses();
    registry.register("zeta", {
      widgets: [
        {
          kind: "kpi",
          title: "Z",
          format: "count",
          query: { aggregate: { fn: "count", column: "id" } },
        },
      ],
    });
    registry.register("expenses", {
      widgets: [
        {
          kind: "kpi",
          title: "E",
          format: "count",
          query: { aggregate: { fn: "count", column: "id" } },
        },
      ],
    });
    const r = await renderDashboard(deps());
    // expenses block must come before zeta block in the output
    const eIdx = r.markdown.indexOf("*expenses*");
    const zIdx = r.markdown.indexOf("*zeta*");
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(zIdx).toBeGreaterThan(eIdx);
    expect(r.capability_count).toBe(2);
    // The zeta block will fail because its capability isn't registered in
    // capability_registry; the failure renders inline, the block still appears.
    expect(r.widget_count).toBe(2);
  });
});
