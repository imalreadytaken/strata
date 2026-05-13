import { describe, expect, it } from "vitest";

import { createLogger } from "../core/logger.js";
import { DashboardRegistry } from "./registry.js";
import type { Dashboard } from "./types.js";

function makeRegistry() {
  return new DashboardRegistry(
    createLogger({ level: "warn", logFilePath: "/dev/null" }),
  );
}

const sample: Dashboard = {
  widgets: [
    {
      kind: "kpi",
      title: "Total",
      format: "money",
      query: { aggregate: { fn: "sum", column: "amount_minor" } },
    },
  ],
};

describe("DashboardRegistry", () => {
  it("register + get round-trip", () => {
    const r = makeRegistry();
    r.register("expenses", sample);
    expect(r.get("expenses")).toBe(sample);
    expect(r.has("expenses")).toBe(true);
  });

  it("get on missing name is undefined", () => {
    const r = makeRegistry();
    expect(r.get("missing")).toBeUndefined();
  });

  it("list returns entries sorted by name", () => {
    const r = makeRegistry();
    r.register("zeta", sample);
    r.register("alpha", sample);
    r.register("middle", sample);
    expect(r.list().map((e) => e.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("re-registering replaces the previous dashboard", () => {
    const r = makeRegistry();
    r.register("expenses", sample);
    const next: Dashboard = {
      widgets: [
        {
          kind: "list",
          title: "Latest",
          format: "text",
          query: { limit: 3 },
        },
      ],
    };
    r.register("expenses", next);
    expect(r.get("expenses")).toBe(next);
    expect(r.size()).toBe(1);
  });
});
