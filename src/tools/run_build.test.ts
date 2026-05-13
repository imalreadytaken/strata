import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BuildRunResult,
  RunBuildOptions,
} from "../build/orchestrator.js";
import { BuildSessionRegistry } from "../build/session_registry.js";
import type { IntegrationResult } from "../build/integration.js";
import { runBuildTool } from "./run_build.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";
import type { BuildToolDeps, EventToolDeps } from "./types.js";

describe("strata_run_build", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-rb" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  async function seedProposal(
    status: "pending" | "approved" | "declined" | "applied" = "pending",
  ): Promise<number> {
    const row = await h.proposalsRepo.insert({
      source: "user_request",
      kind: "new_capability",
      title: "Track weight",
      summary: "x",
      rationale: "y",
      status,
      created_at: new Date().toISOString(),
    });
    return row.id;
  }

  function makeBuildDeps(overrides: Partial<BuildToolDeps> = {}): BuildToolDeps {
    // The stubbed runBuild + runIntegration never call into these, so empty
    // stand-ins are fine for the unit-test surface.
    return {
      db: h.db,
      buildsRepo: { insert: vi.fn(), update: vi.fn(), findById: vi.fn() } as never,
      capabilityRegistryRepo: { findMany: vi.fn(async () => []) } as never,
      capabilityHealthRepo: h.capabilityHealthRepo,
      schemaEvolutionsRepo: { findMany: vi.fn(async () => []) } as never,
      capabilities: new Map(),
      agentsMdSource: "# Constitution",
      buildsDir: "/tmp/builds",
      userCapabilitiesDir: "/tmp/user-caps",
      maxTurnsPerPhase: 5,
      ...overrides,
    };
  }

  function depsWith(buildDeps?: BuildToolDeps): EventToolDeps {
    const d: EventToolDeps = { ...h.deps };
    if (buildDeps) d.buildDeps = buildDeps;
    return d;
  }

  function mkBuildResult(
    status: BuildRunResult["status"],
    overrides: Partial<BuildRunResult> = {},
  ): BuildRunResult {
    const base = { build_id: 1 };
    if (status === "ready_for_integration") {
      return {
        ...base,
        status: "ready_for_integration",
        workdir: "/tmp/workdir",
        plan: "# Plan",
        changeIds: ["add-weight"],
        validationReports: {},
        ...overrides,
      } as BuildRunResult;
    }
    if (status === "failed") {
      return {
        ...base,
        status: "failed",
        failureReason: "plan_empty",
        validationReports: {},
        partial: {},
        ...overrides,
      } as BuildRunResult;
    }
    return {
      ...base,
      status: "cancelled",
      partial: {},
      ...overrides,
    } as BuildRunResult;
  }

  it("happy path returns 'integrated' with build_id + integrated names", async () => {
    const proposalId = await seedProposal();
    const runBuild = vi.fn(async () =>
      mkBuildResult("ready_for_integration"),
    ) as unknown as BuildToolDeps["runBuild"];
    const runIntegration = vi.fn(async () => ({
      status: "integrated" as const,
      build_id: 1,
      integrated: [
        { name: "weight", version: 1, installedPath: "/p", metaPath: "/m" },
      ],
    })) as unknown as BuildToolDeps["runIntegration"];
    const buildDeps = makeBuildDeps({ runBuild, runIntegration });

    const tool = runBuildTool(depsWith(buildDeps));
    const result = await tool.execute("call-1", { proposal_id: proposalId });
    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("integrated");
    expect(details.build_id).toBe(1);
    expect(details.integrated).toEqual(["weight"]);
    expect((runBuild as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect((runIntegration as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("orchestrator failure surfaces the reason and skips integration", async () => {
    const proposalId = await seedProposal();
    const runBuild = vi.fn(async () =>
      mkBuildResult("failed", { failureReason: "plan_empty" }),
    ) as unknown as BuildToolDeps["runBuild"];
    const runIntegration = vi.fn(async () => ({
      status: "integrated" as const,
      build_id: 1,
      integrated: [],
    })) as unknown as BuildToolDeps["runIntegration"];
    const buildDeps = makeBuildDeps({ runBuild, runIntegration });

    const result = await runBuildTool(depsWith(buildDeps)).execute("call-2", {
      proposal_id: proposalId,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("orchestrator_failed");
    expect(d.failureReason).toBe("plan_empty");
    expect((runIntegration as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("integration failure preserves the build_id", async () => {
    const proposalId = await seedProposal();
    const runBuild = vi.fn(async () =>
      mkBuildResult("ready_for_integration", { build_id: 42 }),
    ) as unknown as BuildToolDeps["runBuild"];
    const runIntegration = vi.fn(async () => ({
      status: "failed" as const,
      build_id: 42,
      failureReason: "weight_failed: version_conflict",
      integrated: [],
    })) as unknown as BuildToolDeps["runIntegration"];
    const buildDeps = makeBuildDeps({ runBuild, runIntegration });

    const result = await runBuildTool(depsWith(buildDeps)).execute("c", {
      proposal_id: proposalId,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("integration_failed");
    expect(d.build_id).toBe(42);
    expect(d.failureReason).toContain("version_conflict");
  });

  it("cancelled cascade skips integration", async () => {
    const proposalId = await seedProposal();
    const runBuild = vi.fn(async () =>
      mkBuildResult("cancelled"),
    ) as unknown as BuildToolDeps["runBuild"];
    const runIntegration = vi.fn() as unknown as BuildToolDeps["runIntegration"];
    const buildDeps = makeBuildDeps({ runBuild, runIntegration });

    const result = await runBuildTool(depsWith(buildDeps)).execute("c", {
      proposal_id: proposalId,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("cancelled");
    expect((runIntegration as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("refuses when buildDeps is undefined", async () => {
    const proposalId = await seedProposal();
    const result = await runBuildTool(h.deps).execute("c", {
      proposal_id: proposalId,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("rejected");
    expect((d.failureReason as string).toLowerCase()).toContain("builddeps");
  });

  it("refuses a declined proposal", async () => {
    const proposalId = await seedProposal("declined");
    const buildDeps = makeBuildDeps();
    const result = await runBuildTool(depsWith(buildDeps)).execute("c", {
      proposal_id: proposalId,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("rejected");
    expect(d.failureReason).toContain("declined");
  });

  it("refuses an unknown proposal id", async () => {
    const buildDeps = makeBuildDeps();
    const result = await runBuildTool(depsWith(buildDeps)).execute("c", {
      proposal_id: 9999,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("rejected");
    expect(d.failureReason).toContain("9999");
  });

  it("registers an AbortController + signal abort cancels the run; complete fires in finally", async () => {
    const proposalId = await seedProposal();
    const registry = new BuildSessionRegistry(h.logger);

    // The stubbed runBuild reads the signal + onBuildIdAssigned callback
    // directly (no real orchestrator) and aborts immediately after
    // registration, simulating a user calling strata_stop_build mid-flight.
    const runBuild = vi.fn(async (opts: RunBuildOptions) => {
      opts.onBuildIdAssigned?.(42);
      // Now signal must be wired — controller.abort() through registry.
      const result = registry.abort(42);
      expect(result.stopped).toBe(true);
      expect(opts.signal?.aborted).toBe(true);
      return mkBuildResult("cancelled", { build_id: 42 });
    }) as unknown as BuildToolDeps["runBuild"];
    const runIntegration = vi.fn() as unknown as BuildToolDeps["runIntegration"];
    const buildDeps = makeBuildDeps({
      runBuild,
      runIntegration,
      buildSessionRegistry: registry,
    });

    const result = await runBuildTool(depsWith(buildDeps)).execute("c", {
      proposal_id: proposalId,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.status).toBe("cancelled");
    expect(d.build_id).toBe(42);
    // After the tool returns the registry MUST have deregistered.
    expect(registry.get(42)).toBeUndefined();
  });

  it("complete fires even when runIntegration throws", async () => {
    const proposalId = await seedProposal();
    const registry = new BuildSessionRegistry(h.logger);
    const runBuild = vi.fn(async (opts: RunBuildOptions) => {
      opts.onBuildIdAssigned?.(7);
      return mkBuildResult("ready_for_integration", { build_id: 7 });
    }) as unknown as BuildToolDeps["runBuild"];
    const runIntegration = vi.fn(async () => {
      throw new Error("integration boom");
    }) as unknown as BuildToolDeps["runIntegration"];
    const buildDeps = makeBuildDeps({
      runBuild,
      runIntegration,
      buildSessionRegistry: registry,
    });

    await expect(
      runBuildTool(depsWith(buildDeps)).execute("c", { proposal_id: proposalId }),
    ).rejects.toThrow(/integration boom/);
    // The crash must still have cleared the registry slot.
    expect(registry.get(7)).toBeUndefined();
  });
});
