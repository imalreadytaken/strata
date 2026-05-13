import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commitEventTool } from "./commit_event.js";
import { createPendingEventTool } from "./create_pending_event.js";
import { supersedeEventTool } from "./supersede_event.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_supersede_event", () => {
  let h: TestHarness;

  async function seedCommitted(): Promise<number> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const createRes = await create.execute("seed", {
      event_type: "consumption",
      capability_name: "expenses",
      extracted_data: { amount_minor: 4500, merchant: "Blue Bottle" },
      source_summary: "Blue Bottle 拿铁 ¥45",
      event_occurred_at: "2026-05-04T09:00:00+08:00",
      primary_message_id: msgId,
      confidence: 0.9,
    });
    const eventId = (createRes.details as { event_id: number }).event_id;
    const commit = commitEventTool(h.deps);
    await commit.execute("c", { event_id: eventId });
    return eventId;
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-supersede" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("creates a correction chain linking old and new rows", async () => {
    const oldId = await seedCommitted();
    const correctionMsg = await h.insertMessage();
    const tool = supersedeEventTool(h.deps);
    const result = await tool.execute("s1", {
      old_event_id: oldId,
      new_extracted_data: { amount_minor: 4800, merchant: "Blue Bottle" },
      new_summary: "Blue Bottle 拿铁 ¥48",
      correction_message_id: correctionMsg,
    });
    const newId = (result.details as { new_event_id: number }).new_event_id;

    const newRow = await h.rawEventsRepo.findById(newId);
    expect(newRow?.status).toBe("committed");
    expect(newRow?.supersedes_event_id).toBe(oldId);
    expect(newRow?.primary_message_id).toBe(correctionMsg);
    expect(newRow?.source_summary).toBe("Blue Bottle 拿铁 ¥48");
    expect(JSON.parse(newRow!.related_message_ids)).toEqual([correctionMsg]);
    // Copied from the old row.
    expect(newRow?.event_type).toBe("consumption");
    expect(newRow?.capability_name).toBe("expenses");
    expect(newRow?.event_occurred_at).toBe("2026-05-04T09:00:00+08:00");

    const oldRow = await h.rawEventsRepo.findById(oldId);
    expect(oldRow?.status).toBe("superseded");
    expect(oldRow?.superseded_by_event_id).toBe(newId);
  });

  it("refuses a non-committed row", async () => {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const r = await create.execute("p", {
      event_type: "consumption",
      extracted_data: {},
      source_summary: "x",
      primary_message_id: msgId,
      confidence: 0.9,
    });
    const pendingId = (r.details as { event_id: number }).event_id;
    const tool = supersedeEventTool(h.deps);
    await expect(
      tool.execute("s2", {
        old_event_id: pendingId,
        new_extracted_data: {},
        new_summary: "y",
        correction_message_id: msgId,
      }),
    ).rejects.toThrow(/can only supersede committed events/);
    const row = await h.rawEventsRepo.findById(pendingId);
    expect(row?.status).toBe("pending"); // untouched
  });

  it("rolls back when the UPDATE on the old row fails mid-transaction", async () => {
    const oldId = await seedCommitted();
    const correctionMsg = await h.insertMessage();
    const tool = supersedeEventTool(h.deps);

    const beforeCount = await h.rawEventsRepo.count();
    const updateSpy = vi
      .spyOn(h.rawEventsRepo, "update")
      .mockRejectedValueOnce(new Error("simulated UPDATE failure"));

    await expect(
      tool.execute("s3", {
        old_event_id: oldId,
        new_extracted_data: { amount_minor: 4800 },
        new_summary: "Blue Bottle 拿铁 ¥48",
        correction_message_id: correctionMsg,
      }),
    ).rejects.toThrow(/simulated UPDATE failure/);

    updateSpy.mockRestore();
    const afterCount = await h.rawEventsRepo.count();
    expect(afterCount).toBe(beforeCount); // INSERT rolled back

    const oldRow = await h.rawEventsRepo.findById(oldId);
    expect(oldRow?.status).toBe("committed"); // unchanged
  });

  it("refuses a missing row", async () => {
    const tool = supersedeEventTool(h.deps);
    const msgId = await h.insertMessage();
    await expect(
      tool.execute("s4", {
        old_event_id: 9999,
        new_extracted_data: {},
        new_summary: "x",
        correction_message_id: msgId,
      }),
    ).rejects.toThrow(/not found/);
  });
});
