import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitEventTool } from "./commit_event.js";
import { createPendingEventTool } from "./create_pending_event.js";
import { searchEventsTool } from "./search_events.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_search_events", () => {
  let h: TestHarness;

  async function seed(
    summary: string,
    event_type: string,
    commit: boolean,
    confidence = 0.9,
  ): Promise<number> {
    const msgId = await h.insertMessage();
    const c = createPendingEventTool(h.deps);
    const r = await c.execute("seed", {
      event_type,
      extracted_data: { note: summary },
      source_summary: summary,
      primary_message_id: msgId,
      confidence,
    });
    const id = (r.details as { event_id: number }).event_id;
    if (commit) {
      const commitTool = commitEventTool(h.deps);
      await commitTool.execute("commit", { event_id: id });
    }
    return id;
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-search" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("returns nothing on an empty database", async () => {
    const tool = searchEventsTool(h.deps);
    const r = await tool.execute("q", {});
    expect(r.details).toEqual({ count: 0, results: [] });
  });

  it("matches a case-insensitive LIKE on source_summary", async () => {
    await seed("Blue Bottle 拿铁 ¥45", "consumption", true);
    await seed("跑步 5km", "workout", true);
    const tool = searchEventsTool(h.deps);
    const r = await tool.execute("q", { query: "blue bottle" });
    expect((r.details as { count: number }).count).toBe(1);
  });

  it("filters by event_type", async () => {
    await seed("a", "consumption", true);
    await seed("b", "consumption", true);
    await seed("c", "workout", true);
    const tool = searchEventsTool(h.deps);
    const r = await tool.execute("q", { event_type: "consumption" });
    const details = r.details as {
      count: number;
      results: Array<{ event_type: string }>;
    };
    expect(details.count).toBe(2);
    expect(details.results.every((row) => row.event_type === "consumption")).toBe(
      true,
    );
  });

  it("caps the result at limit", async () => {
    for (let i = 0; i < 20; i++) {
      await seed(`row-${i}`, "consumption", true);
    }
    const tool = searchEventsTool(h.deps);
    const r = await tool.execute("q", { limit: 5 });
    expect((r.details as { results: unknown[] }).results.length).toBe(5);
  });

  it("orders committed before pending, then newest first", async () => {
    await seed("oldest committed", "consumption", true);
    await seed("middle committed", "consumption", true);
    // Pending row should come AFTER committed ones regardless of recency.
    const pendingId = await seed("newest pending", "consumption", false);
    const tool = searchEventsTool(h.deps);
    const r = await tool.execute("q", {});
    const details = r.details as {
      results: Array<{ event_id: number; status: string }>;
    };
    expect(details.results[details.results.length - 1]?.event_id).toBe(
      pendingId,
    );
    expect(details.results[details.results.length - 1]?.status).toBe("pending");
  });

  it("filters status when supplied", async () => {
    await seed("a", "consumption", true);
    await seed("b", "consumption", false);
    const tool = searchEventsTool(h.deps);
    const r = await tool.execute("q", { status: "pending" });
    const details = r.details as {
      count: number;
      results: Array<{ status: string }>;
    };
    expect(details.count).toBe(1);
    expect(details.results[0]?.status).toBe("pending");
  });
});
