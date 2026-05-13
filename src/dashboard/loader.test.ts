import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../core/logger.js";
import { loadCapabilityDashboard } from "./loader.js";
import { DashboardRegistry } from "./registry.js";

const logger = createLogger({ level: "warn", logFilePath: "/dev/null" });

describe("loadCapabilityDashboard", () => {
  let dir: string;
  let registry: DashboardRegistry;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dashboard-loader-"));
    registry = new DashboardRegistry(logger);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("missing dashboard.json returns false and registers nothing", async () => {
    const ok = await loadCapabilityDashboard({
      dir,
      name: "expenses",
      registry,
      logger,
    });
    expect(ok).toBe(false);
    expect(registry.has("expenses")).toBe(false);
  });

  it("valid dashboard.json (JSON5) registers widgets", async () => {
    writeFileSync(
      path.join(dir, "dashboard.json"),
      `{
        // a comment
        widgets: [
          {
            kind: 'kpi',
            title: 'Total',
            format: 'money',
            query: { aggregate: { fn: 'sum', column: 'amount_minor' } },
          },
        ],
      }`,
    );
    const ok = await loadCapabilityDashboard({
      dir,
      name: "expenses",
      registry,
      logger,
    });
    expect(ok).toBe(true);
    expect(registry.get("expenses")?.widgets.length).toBe(1);
  });

  it("invalid JSON throws STRATA_E_CAPABILITY_INVALID", async () => {
    writeFileSync(path.join(dir, "dashboard.json"), "{ this is not json");
    await expect(
      loadCapabilityDashboard({
        dir,
        name: "expenses",
        registry,
        logger,
      }),
    ).rejects.toThrow(/STRATA_E_CAPABILITY_INVALID|not valid JSON/);
  });

  it("schema-invalid dashboard throws", async () => {
    writeFileSync(
      path.join(dir, "dashboard.json"),
      `{
        widgets: [
          { kind: 'pie_chart', title: 'x', query: {} },
        ],
      }`,
    );
    await expect(
      loadCapabilityDashboard({
        dir,
        name: "expenses",
        registry,
        logger,
      }),
    ).rejects.toThrow(/dashboard schema validation/);
  });
});
