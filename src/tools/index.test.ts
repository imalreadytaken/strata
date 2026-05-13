import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEventTools, registerEventTools } from "./index.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("registerEventTools", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-register" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("buildEventTools returns ten tools with the documented names", () => {
    const tools = buildEventTools(h.deps);
    expect(tools.map((t) => t.name)).toEqual([
      "strata_create_pending_event",
      "strata_update_pending_event",
      "strata_commit_event",
      "strata_supersede_event",
      "strata_abandon_event",
      "strata_search_events",
      "strata_propose_capability",
      "strata_run_build",
      "strata_query_table",
      "strata_render_dashboard",
    ]);
    for (const tool of tools) {
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("registerTool is called once and the factory yields ten tools", () => {
    const calls: unknown[] = [];
    const fakeApi = {
      registerTool: vi.fn((toolOrFactory: unknown) => {
        if (typeof toolOrFactory === "function") {
          const result = (toolOrFactory as (ctx: unknown) => unknown)({
            sessionId: "ctx-session",
          });
          calls.push(result);
        } else {
          calls.push(toolOrFactory);
        }
      }),
      logger: { warn: vi.fn() },
    } as unknown as Parameters<typeof registerEventTools>[0];

    const runtime = {
      rawEventsRepo: h.rawEventsRepo,
      proposalsRepo: h.proposalsRepo,
      capabilityHealthRepo: h.capabilityHealthRepo,
      capabilityRegistryRepo: { findMany: vi.fn(async () => []) },
      schemaEvolutionsRepo: { findMany: vi.fn(async () => []) },
      buildsRepo: { insert: vi.fn(), update: vi.fn(), findById: vi.fn(async () => null) },
      capabilities: new Map(),
      dashboardRegistry: { get: vi.fn(() => undefined), list: vi.fn(() => []) },
      pendingBuffer: h.pendingBuffer,
      logger: h.logger,
      db: h.db,
      agentsMdSource: "# AGENTS.md",
      config: {
        paths: {
          buildsDir: "/tmp/builds",
          capabilitiesDir: "/tmp/caps",
        },
      },
    } as unknown as Parameters<typeof registerEventTools>[1];

    registerEventTools(fakeApi, runtime);
    expect((fakeApi.registerTool as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    const factoryResult = calls[0] as Array<{ name: string }>;
    expect(factoryResult).toHaveLength(10);
    expect(factoryResult.map((t) => t.name).sort()).toEqual(
      [
        "strata_abandon_event",
        "strata_commit_event",
        "strata_create_pending_event",
        "strata_propose_capability",
        "strata_query_table",
        "strata_render_dashboard",
        "strata_run_build",
        "strata_search_events",
        "strata_supersede_event",
        "strata_update_pending_event",
      ],
    );
  });

  it("falls back to 'default' session and logs a warn when ctx.sessionId is missing", () => {
    const warnSpy = vi.fn();
    const childLogger = { warn: warnSpy };
    const logger = { child: vi.fn(() => childLogger) };
    const fakeApi = {
      registerTool: (factory: unknown) => {
        (factory as (ctx: unknown) => unknown)({});
      },
    } as unknown as Parameters<typeof registerEventTools>[0];
    const runtime = {
      rawEventsRepo: h.rawEventsRepo,
      proposalsRepo: h.proposalsRepo,
      capabilityHealthRepo: h.capabilityHealthRepo,
      capabilityRegistryRepo: { findMany: vi.fn(async () => []) },
      schemaEvolutionsRepo: { findMany: vi.fn(async () => []) },
      buildsRepo: { insert: vi.fn(), update: vi.fn(), findById: vi.fn(async () => null) },
      capabilities: new Map(),
      dashboardRegistry: { get: vi.fn(() => undefined), list: vi.fn(() => []) },
      pendingBuffer: h.pendingBuffer,
      logger,
      db: h.db,
      agentsMdSource: "# AGENTS.md",
      config: {
        paths: { buildsDir: "/tmp/builds", capabilitiesDir: "/tmp/caps" },
      },
    } as unknown as Parameters<typeof registerEventTools>[1];

    registerEventTools(fakeApi, runtime);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no sessionId"),
    );
  });
});
