import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuildSessionRegistry } from "../build/session_registry.js";
import { stopBuildTool } from "./stop_build.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";
import type { BuildToolDeps, EventToolDeps } from "./types.js";

describe("strata_stop_build", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-stop" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  function depsWith(buildDeps?: BuildToolDeps): EventToolDeps {
    const d: EventToolDeps = { ...h.deps };
    if (buildDeps) d.buildDeps = buildDeps;
    return d;
  }

  function makeBuildDeps(
    overrides: Partial<BuildToolDeps> = {},
  ): BuildToolDeps {
    return {
      db: h.db,
      buildsRepo: {
        insert: vi.fn(),
        update: vi.fn(),
        findById: vi.fn(async () => null),
      } as never,
      capabilityRegistryRepo: { findMany: vi.fn(async () => []) } as never,
      capabilityHealthRepo: h.capabilityHealthRepo,
      schemaEvolutionsRepo: { findMany: vi.fn(async () => []) } as never,
      capabilities: new Map(),
      agentsMdSource: "# x",
      buildsDir: "/tmp/builds",
      userCapabilitiesDir: "/tmp/user-caps",
      maxTurnsPerPhase: 5,
      ...overrides,
    };
  }

  it("rejects when buildDeps is undefined", async () => {
    const result = await stopBuildTool(h.deps).execute("c", { build_id: 1 });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("rejected");
    expect((d.failureReason as string).toLowerCase()).toContain("builddeps");
  });

  it("rejects when buildSessionRegistry is undefined", async () => {
    const buildDeps = makeBuildDeps();
    const result = await stopBuildTool(depsWith(buildDeps)).execute("c", {
      build_id: 1,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("rejected");
    expect((d.failureReason as string).toLowerCase()).toContain("registry");
  });

  it("returns not_found when the row doesn't exist", async () => {
    const registry = new BuildSessionRegistry(h.logger);
    const buildDeps = makeBuildDeps({ buildSessionRegistry: registry });
    const result = await stopBuildTool(depsWith(buildDeps)).execute("c", {
      build_id: 9999,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("not_found");
  });

  it("returns stopped + fires signal when the build is registered", async () => {
    const registry = new BuildSessionRegistry(h.logger);
    const controller = new AbortController();
    registry.register(7, controller, "sess-1");
    const buildDeps = makeBuildDeps({
      buildSessionRegistry: registry,
      buildsRepo: {
        findById: vi.fn(async () => ({ id: 7, phase: "decompose" })),
      } as never,
    });
    const result = await stopBuildTool(depsWith(buildDeps)).execute("c", {
      build_id: 7,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("stopped");
    expect(d.build_id).toBe(7);
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns not_running with phase when row exists but registry is empty", async () => {
    const registry = new BuildSessionRegistry(h.logger);
    const buildDeps = makeBuildDeps({
      buildSessionRegistry: registry,
      buildsRepo: {
        findById: vi.fn(async () => ({ id: 12, phase: "integrated" })),
      } as never,
    });
    const result = await stopBuildTool(depsWith(buildDeps)).execute("c", {
      build_id: 12,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("not_running");
    expect(d.build_id).toBe(12);
    expect(d.phase).toBe("integrated");
  });
});
