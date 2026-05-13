/**
 * End-to-end test for Strata's capture loop. Drives the full chain from an
 * inbound Telegram message through to an `expenses` business-table row,
 * invoking each registered handler the same way the OpenClaw SDK would.
 *
 * No LLM involved — `runtime.llmClient` is the heuristic backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bootStrataForIntegration,
  type IntegrationHarness,
} from "./harness.js";

const SESSION_ID = "int-session";

describe("Strata capture loop (integration)", () => {
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await bootStrataForIntegration();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("captures a consumption message end-to-end via the tool path", async () => {
    // Sanity: every wiring point we depend on exists.
    expect(h.getHook("message_received")).toBeTypeOf("function");
    expect(h.getHook("before_prompt_build")).toBeTypeOf("function");
    expect(h.getTool("strata_create_pending_event")).toBeDefined();
    expect(h.getTool("strata_commit_event")).toBeDefined();

    // 1. Inbound message hits message_received → row in `messages`.
    const userMessage = "今天买了 Blue Bottle 拿铁 ¥45";
    await h.getHook("message_received")(
      {
        from: "u-int",
        content: userMessage,
        timestamp: Date.parse("2026-05-13T09:00:00+08:00"),
      },
      { channelId: "telegram", conversationId: SESSION_ID },
    );

    const messages = await h.runtime.messagesRepo.findMany({
      session_id: SESSION_ID,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(userMessage);
    const primaryMessageId = messages[0]!.id;

    // 2. before_prompt_build → routing context names the capture tool.
    const routing = (await h.getHook("before_prompt_build")(
      { prompt: userMessage, messages: [] },
      { sessionId: SESSION_ID },
    )) as { prependSystemContext: string; prependContext: string };
    expect(routing.prependContext).toContain("CAPTURE");
    expect(routing.prependContext).toContain("strata_create_pending_event");
    expect(routing.prependSystemContext).toContain("expenses");

    // 3. Agent (simulated) calls strata_create_pending_event.
    const createTool = h.getTool("strata_create_pending_event");
    const createResult = await createTool.execute(
      "cid-1",
      {
        event_type: "consumption",
        capability_name: "expenses",
        extracted_data: {
          amount_minor: 4500,
          currency: "CNY",
          merchant: "Blue Bottle",
          category: "dining",
        },
        source_summary: "Blue Bottle 拿铁 ¥45",
        event_occurred_at: "2026-05-13T09:00:00+08:00",
        primary_message_id: primaryMessageId,
        confidence: 0.9,
      },
    );
    const created = (createResult as { details: { event_id: number; status: string } })
      .details;
    expect(created.status).toBe("awaiting_confirmation");
    expect(await h.runtime.pendingBuffer.has(SESSION_ID, created.event_id)).toBe(
      true,
    );
    const pending = await h.runtime.rawEventsRepo.findById(created.event_id);
    expect(pending?.status).toBe("pending");

    // 4. Agent calls strata_commit_event. Should drive the expenses pipeline.
    const commitTool = h.getTool("strata_commit_event");
    const commitResult = await commitTool.execute("cid-2", {
      event_id: created.event_id,
    });
    const committed = (commitResult as {
      details: {
        event_id: number;
        status: string;
        capability_written: boolean;
        business_row_id?: number;
      };
    }).details;
    expect(committed.status).toBe("committed");
    expect(committed.capability_written).toBe(true);
    expect(committed.business_row_id).toBeGreaterThan(0);

    // Raw event reflects the link + commit.
    const finalEvent = await h.runtime.rawEventsRepo.findById(created.event_id);
    expect(finalEvent?.status).toBe("committed");
    expect(finalEvent?.business_row_id).toBe(committed.business_row_id);

    // Buffer drained.
    expect(await h.runtime.pendingBuffer.has(SESSION_ID, created.event_id)).toBe(
      false,
    );

    // Business table row exists with the captured fields.
    const expensesRow = h.runtime.db
      .prepare("SELECT * FROM expenses WHERE id = ?")
      .get(committed.business_row_id) as {
      amount_minor: number;
      currency: string;
      merchant: string;
      category: string;
      occurred_at: string;
      raw_event_id: number;
    };
    expect(expensesRow.amount_minor).toBe(4500);
    expect(expensesRow.currency).toBe("CNY");
    expect(expensesRow.merchant).toBe("Blue Bottle");
    expect(expensesRow.category).toBe("dining");
    expect(expensesRow.occurred_at).toBe("2026-05-13T09:00:00+08:00");
    expect(expensesRow.raw_event_id).toBe(created.event_id);

    // capability_health counter bumped.
    const health = await h.runtime.capabilityHealthRepo.findById("expenses");
    expect(health?.total_writes).toBe(1);
    expect(health?.last_write_at).toBeTruthy();
  });

  it("commits via the Telegram inline-keyboard callback", async () => {
    // Seed: persist a message + a pending event (skip the triage hook path here,
    // it's already covered by the first case).
    const msgRow = await h.runtime.messagesRepo.insert({
      session_id: SESSION_ID,
      channel: "telegram",
      role: "user",
      content: "今天买了 Blue Bottle ¥45",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    const createTool = h.getTool("strata_create_pending_event");
    const createResult = await createTool.execute("cid-cb-1", {
      event_type: "consumption",
      capability_name: "expenses",
      extracted_data: {
        amount_minor: 4500,
        currency: "CNY",
        merchant: "Blue Bottle",
        category: "dining",
      },
      source_summary: "Blue Bottle 拿铁 ¥45",
      event_occurred_at: "2026-05-13T09:00:00+08:00",
      primary_message_id: msgRow.id,
      confidence: 0.9,
    });
    const eventId = (createResult as { details: { event_id: number } }).details
      .event_id;

    // Invoke the strata-namespace Telegram handler.
    const handler = h.getInteractiveHandler("telegram", "strata");
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      channel: "telegram" as const,
      accountId: "acc",
      callbackId: "cb-1",
      conversationId: SESSION_ID,
      isGroup: false,
      isForum: false,
      auth: { isAuthorizedSender: true },
      callback: {
        data: `strata:commit:${eventId}`,
        namespace: "strata",
        payload: `commit:${eventId}`,
        messageId: 1,
        chatId: "chat-int",
        messageText: "Blue Bottle 拿铁 ¥45\n\n要记下吗?",
      },
      respond: {
        reply: vi.fn(),
        editMessage,
        editButtons: vi.fn(),
        clearButtons: vi.fn(),
        deleteMessage: vi.fn(),
      },
      requestConversationBinding: vi.fn(),
      detachConversationBinding: vi.fn(),
      getCurrentConversationBinding: vi.fn(),
    };
    await handler(ctx);

    // Same business outcomes as the tool path.
    const finalEvent = await h.runtime.rawEventsRepo.findById(eventId);
    expect(finalEvent?.status).toBe("committed");
    expect(finalEvent?.business_row_id).toBeGreaterThan(0);
    const health = await h.runtime.capabilityHealthRepo.findById("expenses");
    expect(health?.total_writes).toBe(1);
    expect(editMessage).toHaveBeenCalledTimes(1);
    const call = editMessage.mock.calls[0]?.[0] as {
      text: string;
      buttons: unknown[];
    };
    expect(call.buttons).toEqual([]);
    expect(call.text).toContain("✅ 已记录");
  });
});
