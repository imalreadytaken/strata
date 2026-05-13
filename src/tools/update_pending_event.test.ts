import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPendingEventTool } from "./create_pending_event.js";
import { updatePendingEventTool } from "./update_pending_event.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_update_pending_event", () => {
  let h: TestHarness;

  async function seedPending(): Promise<{ eventId: number; msgId: number }> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const result = await create.execute("seed", {
      event_type: "consumption",
      extracted_data: { amount_minor: 4500, merchant: "Blue Bottle" },
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: msgId,
      confidence: 0.6,
    });
    return {
      eventId: (result.details as { event_id: number }).event_id,
      msgId,
    };
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-update" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("merges a shallow patch into extracted_data", async () => {
    const { eventId } = await seedPending();
    const followupId = await h.insertMessage();
    const tool = updatePendingEventTool(h.deps);
    await tool.execute("call-1", {
      event_id: eventId,
      patch: { amount_minor: 4800 },
      related_message_id: followupId,
    });
    const row = await h.rawEventsRepo.findById(eventId);
    expect(JSON.parse(row!.extracted_data)).toEqual({
      amount_minor: 4800,
      merchant: "Blue Bottle",
    });
  });

  it("appends related message ids without duplicating", async () => {
    const { eventId } = await seedPending();
    const followupId = await h.insertMessage();
    const tool = updatePendingEventTool(h.deps);
    await tool.execute("a", {
      event_id: eventId,
      patch: {},
      related_message_id: followupId,
    });
    await tool.execute("b", {
      event_id: eventId,
      patch: {},
      related_message_id: followupId, // same id again
    });
    const row = await h.rawEventsRepo.findById(eventId);
    const ids = JSON.parse(row!.related_message_ids) as number[];
    expect(ids.filter((id) => id === followupId)).toHaveLength(1);
  });

  it("replaces source_summary when new_summary is supplied", async () => {
    const { eventId } = await seedPending();
    const followupId = await h.insertMessage();
    const tool = updatePendingEventTool(h.deps);
    await tool.execute("c", {
      event_id: eventId,
      patch: { amount_minor: 4800 },
      new_summary: "Blue Bottle 拿铁 ¥48",
      related_message_id: followupId,
    });
    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.source_summary).toBe("Blue Bottle 拿铁 ¥48");
  });

  it("refuses a missing row", async () => {
    const followupId = await h.insertMessage();
    const tool = updatePendingEventTool(h.deps);
    await expect(
      tool.execute("d", {
        event_id: 9999,
        patch: {},
        related_message_id: followupId,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses a non-pending row", async () => {
    const { eventId } = await seedPending();
    await h.rawEventsRepo.update(eventId, { status: "committed" });
    const followupId = await h.insertMessage();
    const tool = updatePendingEventTool(h.deps);
    await expect(
      tool.execute("e", {
        event_id: eventId,
        patch: {},
        related_message_id: followupId,
      }),
    ).rejects.toThrow(/not in pending state/);
  });
});
