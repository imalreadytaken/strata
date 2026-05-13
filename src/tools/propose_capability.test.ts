import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { proposeCapabilityTool } from "./propose_capability.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_propose_capability", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-propose" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("inserts a pending proposals row from minimal inputs", async () => {
    const tool = proposeCapabilityTool(h.deps);
    const result = await tool.execute("c1", {
      title: "Track weight",
      summary: "Track body weight measurements over time.",
      rationale: "User explicitly asked to add weight tracking.",
    });
    const details = (result.details as { proposal_id: number; status: string });
    expect(details.status).toBe("pending");
    expect(details.proposal_id).toBeGreaterThan(0);

    const row = await h.proposalsRepo.findById(details.proposal_id);
    expect(row).toMatchObject({
      source: "user_request",
      kind: "new_capability",
      status: "pending",
      title: "Track weight",
      summary: "Track body weight measurements over time.",
      rationale: "User explicitly asked to add weight tracking.",
      target_capability: null,
      estimated_time_minutes: null,
    });
    expect(row?.created_at).toBeTruthy();
  });

  it("persists target_capability and estimated_time_minutes when supplied", async () => {
    const tool = proposeCapabilityTool(h.deps);
    const result = await tool.execute("c2", {
      title: "Add notes field to expenses",
      summary: "Adds a free-text note column to the expenses table.",
      rationale: "User wants to annotate purchases with context.",
      target_capability: "expenses",
      estimated_time_minutes: 30,
    });
    const id = (result.details as { proposal_id: number }).proposal_id;
    const row = await h.proposalsRepo.findById(id);
    expect(row?.target_capability).toBe("expenses");
    expect(row?.estimated_time_minutes).toBe(30);
  });

  it("rejects empty title", async () => {
    const tool = proposeCapabilityTool(h.deps);
    await expect(
      tool.execute("c3", { title: "", summary: "x", rationale: "y" }),
    ).rejects.toThrow();
    expect(await h.proposalsRepo.count()).toBe(0);
  });

  it("rejects empty summary", async () => {
    const tool = proposeCapabilityTool(h.deps);
    await expect(
      tool.execute("c4", { title: "x", summary: "", rationale: "y" }),
    ).rejects.toThrow();
    expect(await h.proposalsRepo.count()).toBe(0);
  });

  it("rejects empty rationale", async () => {
    const tool = proposeCapabilityTool(h.deps);
    await expect(
      tool.execute("c5", { title: "x", summary: "y", rationale: "" }),
    ).rejects.toThrow();
    expect(await h.proposalsRepo.count()).toBe(0);
  });

  it("rejects non-positive estimated_time_minutes", async () => {
    const tool = proposeCapabilityTool(h.deps);
    await expect(
      tool.execute("c6", {
        title: "x",
        summary: "y",
        rationale: "z",
        estimated_time_minutes: 0,
      }),
    ).rejects.toThrow();
  });
});
