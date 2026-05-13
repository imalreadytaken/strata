import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { abandonEventTool } from "./abandon_event.js";
import { createPendingEventTool } from "./create_pending_event.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_abandon_event", () => {
  let h: TestHarness;

  async function seedPending(): Promise<number> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const result = await create.execute("seed", {
      event_type: "consumption",
      extracted_data: { amount_minor: 4500 },
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: msgId,
      confidence: 0.4,
    });
    return (result.details as { event_id: number }).event_id;
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-abandon" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("abandons with the default reason", async () => {
    const eventId = await seedPending();
    const tool = abandonEventTool(h.deps);
    const result = await tool.execute("a1", { event_id: eventId });
    expect(result.details).toMatchObject({
      event_id: eventId,
      status: "abandoned",
      reason: "user_declined",
    });
    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("abandoned");
    expect(row?.abandoned_reason).toBe("user_declined");
    expect(await h.pendingBuffer.has("s-abandon", eventId)).toBe(false);
  });

  it("persists a custom reason", async () => {
    const eventId = await seedPending();
    const tool = abandonEventTool(h.deps);
    await tool.execute("a2", { event_id: eventId, reason: "duplicate_entry" });
    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.abandoned_reason).toBe("duplicate_entry");
  });

  it("refuses a non-pending row", async () => {
    const eventId = await seedPending();
    await h.rawEventsRepo.update(eventId, { status: "committed" });
    const tool = abandonEventTool(h.deps);
    await expect(tool.execute("a3", { event_id: eventId })).rejects.toThrow(
      /not in pending state/,
    );
  });

  it("refuses a missing row", async () => {
    const tool = abandonEventTool(h.deps);
    await expect(tool.execute("a4", { event_id: 9999 })).rejects.toThrow(
      /not found/,
    );
  });
});
