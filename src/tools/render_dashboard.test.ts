import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCapabilityMigrations } from "../capabilities/migrations.js";
import { DashboardRegistry } from "../dashboard/registry.js";
import { renderDashboardTool } from "./render_dashboard.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";
import type { DashboardToolDeps } from "./types.js";

describe("strata_render_dashboard", () => {
  let h: TestHarness;
  let registry: DashboardRegistry;

  async function seed(): Promise<void> {
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
    h.db
      .prepare(
        `INSERT INTO expenses (raw_event_id, occurred_at, amount_minor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .run(re.id, "2026-05-01T00:00:00Z", 1000, "2026-05-01", "2026-05-01");
    await h.runtimeStub.capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "expenses",
      created_at: "2026-05-13T00:00:00Z",
    });
    registry.register("expenses", {
      widgets: [
        {
          kind: "kpi",
          title: "Total",
          format: "money",
          query: { aggregate: { fn: "sum", column: "amount_minor" } },
        },
      ],
    });
  }

  function makeDashboardDeps(): DashboardToolDeps {
    return {
      db: h.db,
      capabilityRegistryRepo: h.runtimeStub.capabilityRegistryRepo,
      dashboardRegistry: registry,
      logger: h.logger,
    };
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-render-tool" });
    registry = new DashboardRegistry(h.logger);
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("returns markdown for the requested capability", async () => {
    await seed();
    h.deps.dashboardDeps = makeDashboardDeps();
    const tool = renderDashboardTool(h.deps);
    const res = await tool.execute("c1", { capability_name: "expenses" });
    const d = res.details as {
      markdown: string;
      capability_count: number;
      widget_count: number;
    };
    expect(d.capability_count).toBe(1);
    expect(d.widget_count).toBe(1);
    expect(d.markdown).toContain("¥10.00 (CNY)");
  });

  it("renders every registered capability when capability_name omitted", async () => {
    await seed();
    h.deps.dashboardDeps = makeDashboardDeps();
    const tool = renderDashboardTool(h.deps);
    const res = await tool.execute("c2", {});
    const d = res.details as { capability_count: number; markdown: string };
    expect(d.capability_count).toBe(1);
    expect(d.markdown).toContain("*expenses*");
  });

  it("rejects when dashboardDeps is missing", async () => {
    const tool = renderDashboardTool(h.deps);
    await expect(
      tool.execute("c3", { capability_name: "expenses" }),
    ).rejects.toThrow(/dashboardDeps/);
  });
});
