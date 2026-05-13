import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitEventCore, commitEventTool } from "./commit_event.js";
import { createPendingEventTool } from "./create_pending_event.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_commit_event", () => {
  let h: TestHarness;

  async function seedPending(): Promise<number> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const result = await create.execute("seed", {
      event_type: "consumption",
      extracted_data: { amount_minor: 4500 },
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: msgId,
      confidence: 0.9,
    });
    return (result.details as { event_id: number }).event_id;
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-commit" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("transitions pending → committed and drains the buffer", async () => {
    const eventId = await seedPending();
    const tool = commitEventTool(h.deps);
    const result = await tool.execute("c1", { event_id: eventId });
    expect(result.details).toMatchObject({
      event_id: eventId,
      status: "committed",
      capability_written: false,
      summary: "Blue Bottle 拿铁 ¥45",
    });

    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
    expect(row?.committed_at).toBeTruthy();
    expect(await h.pendingBuffer.has("s-commit", eventId)).toBe(false);
  });

  it("refuses a double-commit", async () => {
    const eventId = await seedPending();
    const tool = commitEventTool(h.deps);
    await tool.execute("c1", { event_id: eventId });
    await expect(tool.execute("c2", { event_id: eventId })).rejects.toThrow(
      /not in pending state/,
    );
  });

  it("refuses a missing event", async () => {
    const tool = commitEventTool(h.deps);
    await expect(
      tool.execute("c3", { event_id: 9999 }),
    ).rejects.toThrow(/not found/);
  });

  it("commitEventCore is callable directly with the same semantics", async () => {
    const eventId = await seedPending();
    const details = await commitEventCore(h.deps, eventId);
    expect(details).toMatchObject({
      event_id: eventId,
      status: "committed",
      capability_written: false,
    });
    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
  });

  it("succeeds even when the buffer no longer contains the id", async () => {
    const eventId = await seedPending();
    await h.pendingBuffer.remove("s-commit", eventId); // pre-drain
    const tool = commitEventTool(h.deps);
    const result = await tool.execute("c4", { event_id: eventId });
    expect((result.details as { status: string }).status).toBe("committed");
  });
});
