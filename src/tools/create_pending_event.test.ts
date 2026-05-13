import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPendingEventTool } from "./create_pending_event.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_create_pending_event", () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-create" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("inserts a pending row and registers the buffer", async () => {
    const msgId = await h.insertMessage();
    const tool = createPendingEventTool(h.deps);
    const result = await tool.execute("call-1", {
      event_type: "consumption",
      capability_name: "expenses",
      extracted_data: { amount_minor: 4500, merchant: "Blue Bottle" },
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: msgId,
      confidence: 0.9,
    });

    expect(result.details).toMatchObject({
      status: "awaiting_confirmation",
      summary: "Blue Bottle 拿铁 ¥45",
    });
    expect((result.details as { event_id: number }).event_id).toBeGreaterThan(0);
    const row = await h.rawEventsRepo.findById(
      (result.details as { event_id: number }).event_id,
    );
    expect(row?.status).toBe("pending");
    expect(JSON.parse(row!.extracted_data)).toEqual({
      amount_minor: 4500,
      merchant: "Blue Bottle",
    });
    expect(JSON.parse(row!.related_message_ids)).toEqual([msgId]);
    expect(row?.capability_name).toBe("expenses");
    expect(row?.extraction_confidence).toBe(0.9);
    expect(await h.pendingBuffer.has("s-create", row!.id)).toBe(true);
  });

  it("populates defaults for omitted optional fields", async () => {
    const msgId = await h.insertMessage();
    const tool = createPendingEventTool(h.deps);
    const result = await tool.execute("call-2", {
      event_type: "unclassified",
      extracted_data: { note: "something" },
      source_summary: "vague event",
      primary_message_id: msgId,
      confidence: 0.4,
    });
    const row = await h.rawEventsRepo.findById(
      (result.details as { event_id: number }).event_id,
    );
    expect(row?.capability_name).toBeNull();
    expect(row?.event_occurred_at).toBeNull();
    expect(row?.extraction_version).toBe(1);
  });

  it("schema rejects negative confidence", async () => {
    const msgId = await h.insertMessage();
    const tool = createPendingEventTool(h.deps);
    await expect(
      tool.execute("call-3", {
        event_type: "consumption",
        extracted_data: {},
        source_summary: "x",
        primary_message_id: msgId,
        confidence: -0.1,
      }),
    ).rejects.toThrow();
    const count = await h.rawEventsRepo.count();
    expect(count).toBe(0);
  });

  it("schema rejects empty source_summary", async () => {
    const msgId = await h.insertMessage();
    const tool = createPendingEventTool(h.deps);
    await expect(
      tool.execute("call-4", {
        event_type: "consumption",
        extracted_data: {},
        source_summary: "",
        primary_message_id: msgId,
        confidence: 0.5,
      }),
    ).rejects.toThrow();
    expect(await h.rawEventsRepo.count()).toBe(0);
  });
});
