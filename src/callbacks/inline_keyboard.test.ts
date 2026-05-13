import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPendingEventTool } from "../tools/create_pending_event.js";
import { makeHarness, type TestHarness } from "../tools/test_helpers.js";
import {
  buildStrataKeyboard,
  handleStrataCallback,
  parseStrataPayload,
} from "./inline_keyboard.js";

describe("parseStrataPayload", () => {
  const valid: Array<[string, { action: string; eventId: number }]> = [
    ["commit:1", { action: "commit", eventId: 1 }],
    ["commit:42", { action: "commit", eventId: 42 }],
    ["edit:7", { action: "edit", eventId: 7 }],
    ["abandon:999", { action: "abandon", eventId: 999 }],
  ];
  it.each(valid)("parses %s", (payload, expected) => {
    expect(parseStrataPayload(payload)).toEqual(expected);
  });

  const invalid = [
    "",
    "commit",
    "commit:",
    ":42",
    "commit_42",
    "delete:42",
    "commit:abc",
    "strata:commit:42", // namespace not yet stripped
    "commit:-1",
    "commit:0",
    "commit:1.5",
  ];
  it.each(invalid)("rejects %s", (payload) => {
    expect(parseStrataPayload(payload)).toBeNull();
  });
});

describe("buildStrataKeyboard", () => {
  it("defaults to a 3-button single row", () => {
    const kb = buildStrataKeyboard(7);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toHaveLength(3);
    expect(kb[0]?.[0]).toEqual({
      text: "✅ 记录",
      callback_data: "strata:commit:7",
      style: "success",
    });
    expect(kb[0]?.[1]).toEqual({
      text: "✏️ 调整",
      callback_data: "strata:edit:7",
    });
    expect(kb[0]?.[2]).toEqual({
      text: "❌ 不记",
      callback_data: "strata:abandon:7",
      style: "danger",
    });
  });

  it("hides the edit button when showEdit=false", () => {
    const kb = buildStrataKeyboard(7, { showEdit: false });
    expect(kb).toHaveLength(1);
    expect(kb[0]).toHaveLength(2);
    expect(kb[0]?.map((b) => b.callback_data)).toEqual([
      "strata:commit:7",
      "strata:abandon:7",
    ]);
  });
});

describe("handleStrataCallback", () => {
  let h: TestHarness;
  let editMessage: ReturnType<typeof vi.fn>;
  let clearButtons: ReturnType<typeof vi.fn>;

  async function seedPending(): Promise<{ eventId: number; summary: string }> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const summary = "Blue Bottle 拿铁 ¥45";
    const r = await create.execute("seed", {
      event_type: "consumption",
      extracted_data: { amount_minor: 4500 },
      source_summary: summary,
      primary_message_id: msgId,
      confidence: 0.9,
    });
    return {
      eventId: (r.details as { event_id: number }).event_id,
      summary,
    };
  }

  function makeCtx(payload: string, messageText?: string) {
    editMessage = vi.fn().mockResolvedValue(undefined);
    clearButtons = vi.fn().mockResolvedValue(undefined);
    return {
      channel: "telegram" as const,
      accountId: "acc",
      callbackId: "cb-1",
      conversationId: "s-cb",
      isGroup: false,
      isForum: false,
      auth: { isAuthorizedSender: true },
      callback: {
        data: `strata:${payload}`,
        namespace: "strata",
        payload,
        messageId: 12345,
        chatId: "chat-1",
        messageText,
      },
      respond: {
        reply: vi.fn(),
        editMessage,
        editButtons: vi.fn(),
        clearButtons,
        deleteMessage: vi.fn(),
      },
      requestConversationBinding: vi.fn(),
      detachConversationBinding: vi.fn(),
      getCurrentConversationBinding: vi.fn(),
    } as unknown as Parameters<ReturnType<typeof handleStrataCallback>>[0];
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-cb" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("commit branch transitions and edits the message", async () => {
    const { eventId, summary } = await seedPending();
    const handler = handleStrataCallback(h.deps);
    const ctx = makeCtx(`commit:${eventId}`, `${summary}\n\n要记下吗?`);
    await handler(ctx);

    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
    expect(await h.pendingBuffer.has("s-cb", eventId)).toBe(false);
    expect(editMessage).toHaveBeenCalledTimes(1);
    const call = editMessage.mock.calls[0]?.[0] as { text: string; buttons: unknown[] };
    expect(call.text).toContain("✅ 已记录");
    expect(call.buttons).toEqual([]);
  });

  it("abandon branch stamps inline reason and clears keyboard", async () => {
    const { eventId, summary } = await seedPending();
    const handler = handleStrataCallback(h.deps);
    const ctx = makeCtx(`abandon:${eventId}`, `${summary}\n\n要记下吗?`);
    await handler(ctx);

    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("abandoned");
    expect(row?.abandoned_reason).toBe("user_declined_via_inline");
    expect(await h.pendingBuffer.has("s-cb", eventId)).toBe(false);
    const call = editMessage.mock.calls[0]?.[0] as { text: string; buttons: unknown[] };
    expect(call.text).toContain("❌ 不记");
    expect(call.buttons).toEqual([]);
  });

  it("edit branch clears keyboard without changing DB", async () => {
    const { eventId, summary } = await seedPending();
    const handler = handleStrataCallback(h.deps);
    const before = await h.rawEventsRepo.findById(eventId);
    const ctx = makeCtx(`edit:${eventId}`, `${summary}\n\n要记下吗?`);
    await handler(ctx);

    const after = await h.rawEventsRepo.findById(eventId);
    expect(after?.status).toBe("pending");
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(await h.pendingBuffer.has("s-cb", eventId)).toBe(true);
    const call = editMessage.mock.calls[0]?.[0] as { text: string; buttons: unknown[] };
    expect(call.text).toContain("✏️");
    expect(call.buttons).toEqual([]);
  });

  it("falls back to '${summary} ${mark}' when messageText is missing", async () => {
    const { eventId, summary } = await seedPending();
    const handler = handleStrataCallback(h.deps);
    const ctx = makeCtx(`commit:${eventId}`); // no messageText
    await handler(ctx);
    const call = editMessage.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toBe(`${summary} ✅ 已记录`);
  });

  it("malformed payload logs warn and never edits the message", async () => {
    const handler = handleStrataCallback(h.deps);
    const ctx = makeCtx("commit_42", "some text");
    await handler(ctx);
    expect(editMessage).not.toHaveBeenCalled();
    expect(clearButtons).not.toHaveBeenCalled();
  });

  it("double-tap commit converges the UI without throwing", async () => {
    const { eventId, summary } = await seedPending();
    const handler = handleStrataCallback(h.deps);
    const ctx1 = makeCtx(`commit:${eventId}`, `${summary}\n\n要记下吗?`);
    await handler(ctx1);
    const ctx2 = makeCtx(`commit:${eventId}`, `${summary}\n\n要记下吗?`);
    await handler(ctx2);

    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
    expect(editMessage).toHaveBeenCalledTimes(1);
    // The second handler invocation rebuilt its own editMessage spy via makeCtx.
    // Both calls should have completed without throwing — which is the point.
  });

  it("uses ctx.conversationId as session_id (override on each callback)", async () => {
    // Seed in session 's-other' but invoke the handler against the global deps
    // whose sessionId is 's-cb' (set in makeHarness). The handler must override
    // to ctx.conversationId so the buffer drain targets 's-other'.
    const msgId = await h.insertMessage("s-other");
    const otherDeps = { ...h.deps, sessionId: "s-other" };
    const create = createPendingEventTool(otherDeps);
    const r = await create.execute("seed", {
      event_type: "consumption",
      extracted_data: {},
      source_summary: "x",
      primary_message_id: msgId,
      confidence: 0.9,
    });
    const eventId = (r.details as { event_id: number }).event_id;
    expect(await h.pendingBuffer.has("s-other", eventId)).toBe(true);

    const handler = handleStrataCallback(h.deps); // base deps uses 's-cb'
    const ctx = makeCtx(`commit:${eventId}`, "x\n\n要记下吗?");
    (ctx as { conversationId: string }).conversationId = "s-other";
    await handler(ctx);
    expect(await h.pendingBuffer.has("s-other", eventId)).toBe(false);
  });
});
