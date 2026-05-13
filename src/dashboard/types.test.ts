import { describe, expect, it } from "vitest";

import { DashboardSchema, WidgetSchema } from "./types.js";

describe("DashboardSchema", () => {
  it("accepts a well-formed KPI widget", () => {
    const ok = DashboardSchema.safeParse({
      widgets: [
        {
          kind: "kpi",
          title: "Total spend",
          format: "money",
          query: { aggregate: { fn: "sum", column: "amount_minor" } },
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a list widget without aggregate", () => {
    const ok = WidgetSchema.safeParse({
      kind: "list",
      title: "Recent",
      format: "text",
      query: { order_by: "occurred_at", order_direction: "desc", limit: 5 },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const r = WidgetSchema.safeParse({
      kind: "pie_chart",
      title: "x",
      query: {},
    });
    expect(r.success).toBe(false);
  });

  it("rejects a KPI without aggregate when format is money", () => {
    const r = WidgetSchema.safeParse({
      kind: "kpi",
      title: "Bad",
      format: "money",
      query: {},
    });
    expect(r.success).toBe(false);
  });

  it("accepts a KPI without aggregate when format is text", () => {
    // Edge case: an agent could conceivably register a text KPI like "last
    // entry merchant" without aggregation. The schema currently allows it;
    // the renderer just stringifies whatever the first row yields.
    const r = WidgetSchema.safeParse({
      kind: "kpi",
      title: "Last merchant",
      format: "text",
      query: { order_by: "occurred_at", order_direction: "desc", limit: 1 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects limit > 100", () => {
    const r = WidgetSchema.safeParse({
      kind: "list",
      title: "x",
      query: { limit: 999 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown columns at the regex level", () => {
    const r = WidgetSchema.safeParse({
      kind: "list",
      title: "x",
      query: { order_by: "weird; DROP TABLE" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty widgets array", () => {
    const r = DashboardSchema.safeParse({ widgets: [] });
    expect(r.success).toBe(false);
  });
});
