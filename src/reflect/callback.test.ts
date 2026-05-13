import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import { ProposalsRepository } from "../db/repositories/index.js";
import {
  buildReflectKeyboard,
  handleReflectCallback,
  parseReflectPayload,
} from "./callback.js";
import type { ProposalRow } from "../db/repositories/proposals.js";

describe("parseReflectPayload", () => {
  it.each([
    ["approve:7", { action: "approve", proposalId: 7 }],
    ["decline:42", { action: "decline", proposalId: 42 }],
  ])("parses %s", (input, expected) => {
    expect(parseReflectPayload(input)).toEqual(expected);
  });

  it.each([
    "",
    "approve",
    "approve:",
    ":7",
    "approve_7",
    "discard:7",
    "approve:0",
    "approve:abc",
  ])("rejects %s", (input) => {
    expect(parseReflectPayload(input)).toBeNull();
  });
});

describe("buildReflectKeyboard", () => {
  it("builds a 1-row 2-button approve/decline layout", () => {
    const kb = buildReflectKeyboard(11);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toHaveLength(2);
    expect(kb[0]?.[0]).toEqual({
      text: "✅ approve",
      callback_data: "strata-propose:approve:11",
      style: "success",
    });
    expect(kb[0]?.[1]).toEqual({
      text: "❌ decline",
      callback_data: "strata-propose:decline:11",
      style: "danger",
    });
  });
});

describe("handleReflectCallback", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let proposalsRepo: ProposalsRepository;
  const now = new Date("2026-05-13T00:00:00Z");
  let editMessage: ReturnType<typeof vi.fn>;

  async function seedProposal(): Promise<ProposalRow> {
    return proposalsRepo.insert({
      source: "reflect_agent",
      kind: "schema_evolution",
      target_capability: "expenses",
      title: "title",
      summary: "summary",
      rationale: "rationale",
      status: "pending",
      created_at: now.toISOString(),
    });
  }

  function makeCtx(payload: string) {
    editMessage = vi.fn().mockResolvedValue(undefined);
    return {
      channel: "telegram",
      accountId: "acc",
      callbackId: "cb-1",
      conversationId: "s",
      isGroup: false,
      isForum: false,
      auth: { isAuthorizedSender: true },
      callback: {
        data: `strata-propose:${payload}`,
        namespace: "strata-propose",
        payload,
        messageId: 1,
        chatId: "chat",
        messageText: "🌿 proposal text",
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
    } as unknown as Parameters<ReturnType<typeof handleReflectCallback>>[0];
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-rcb-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    proposalsRepo = new ProposalsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("approve flips status + clears buttons", async () => {
    const row = await seedProposal();
    const handler = handleReflectCallback({
      proposalsRepo,
      logger,
      now: () => now,
    });
    const ctx = makeCtx(`approve:${row.id}`);
    await handler(ctx);
    const updated = await proposalsRepo.findById(row.id);
    expect(updated?.status).toBe("approved");
    expect(updated?.responded_at).toBe(now.toISOString());
    const call = editMessage.mock.calls[0]?.[0] as { buttons: unknown[] };
    expect(call.buttons).toEqual([]);
  });

  it("decline sets cooldown_until 30 days ahead", async () => {
    const row = await seedProposal();
    const handler = handleReflectCallback({
      proposalsRepo,
      logger,
      now: () => now,
    });
    const ctx = makeCtx(`decline:${row.id}`);
    await handler(ctx);
    const updated = await proposalsRepo.findById(row.id);
    expect(updated?.status).toBe("declined");
    expect(updated?.cooldown_until).toBeTruthy();
    const expected = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    expect(updated?.cooldown_until).toBe(expected);
  });

  it("malformed payload logs warn and does not mutate", async () => {
    const row = await seedProposal();
    const handler = handleReflectCallback({ proposalsRepo, logger });
    const ctx = makeCtx("foo");
    await handler(ctx);
    const updated = await proposalsRepo.findById(row.id);
    expect(updated?.status).toBe("pending");
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("missing proposal id surfaces a not-found edit", async () => {
    const handler = handleReflectCallback({ proposalsRepo, logger });
    const ctx = makeCtx("approve:9999");
    await handler(ctx);
    const call = editMessage.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toContain("not found");
  });
});
