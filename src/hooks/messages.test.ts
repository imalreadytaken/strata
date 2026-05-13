import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import { MessagesRepository } from "../db/repositories/messages.js";
import {
  handleMessageReceived,
  handleMessageSent,
  installMessageHooks,
} from "./messages.js";

/**
 * Tiny mock of the OpenClaw plugin API surface our hook installer touches.
 * Records every `api.on(...)` call so the test can drive the registered
 * handler synchronously.
 */
function mockApi(): {
  api: OpenClawPluginApi;
  fireReceived: (event: unknown, ctx: unknown) => Promise<void>;
  fireSent: (event: unknown, ctx: unknown) => Promise<void>;
  onCalls: string[];
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const onCalls: string[] = [];
  const api = {
    on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => {
      onCalls.push(name);
      handlers.set(name, h);
    },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as OpenClawPluginApi;
  return {
    api,
    onCalls,
    fireReceived: async (event, ctx) => {
      const h = handlers.get("message_received");
      if (!h) throw new Error("message_received not registered");
      await h(event, ctx);
    },
    fireSent: async (event, ctx) => {
      const h = handlers.get("message_sent");
      if (!h) throw new Error("message_sent not registered");
      await h(event, ctx);
    },
  };
}

describe("installMessageHooks (registration)", () => {
  it("subscribes to both message_received and message_sent", () => {
    const { api, onCalls } = mockApi();
    const messagesRepo = {} as MessagesRepository;
    const logger = {} as Logger;
    installMessageHooks(api, { messagesRepo, logger });
    expect(onCalls).toEqual(["message_received", "message_sent"]);
  });
});

describe("handleMessageReceived", () => {
  let tmp: string;
  let db: Database;
  let messagesRepo: MessagesRepository;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-hooks-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    messagesRepo = new MessagesRepository(db);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "plugin.log"),
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("persists an inbound message with conversationId as session_id", async () => {
    await handleMessageReceived(
      { messagesRepo, logger },
      { from: "u1", content: "hi", timestamp: 1_700_000_000_000 },
      { channelId: "telegram", conversationId: "conv-1" },
    );
    const rows = await messagesRepo.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "user",
      channel: "telegram",
      session_id: "conv-1",
      content: "hi",
      content_type: "text",
      turn_index: 0,
      received_at: "2023-11-14T22:13:20.000Z",
    });
  });

  it("falls back to <channelId>:<from> when conversationId is missing", async () => {
    await handleMessageReceived(
      { messagesRepo, logger },
      { from: "u9", content: "hello" },
      { channelId: "telegram" },
    );
    const rows = await messagesRepo.findMany();
    expect(rows[0]?.session_id).toBe("telegram:u9");
  });

  it("increments turn_index across a session", async () => {
    for (let i = 0; i < 3; i++) {
      await handleMessageReceived(
        { messagesRepo, logger },
        { from: "u1", content: `m${i}` },
        { channelId: "telegram", conversationId: "conv-1" },
      );
    }
    const rows = await messagesRepo.findMany({}, { orderBy: "turn_index" });
    expect(rows.map((r) => r.turn_index)).toEqual([0, 1, 2]);
  });

  it("uses current time when event.timestamp is absent", async () => {
    const before = Date.now();
    await handleMessageReceived(
      { messagesRepo, logger },
      { from: "u1", content: "no-ts" },
      { channelId: "telegram", conversationId: "conv-1" },
    );
    const after = Date.now();
    const row = (await messagesRepo.findMany())[0]!;
    const ts = Date.parse(row.received_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("swallows persistence errors and logs at error level", async () => {
    const throwingRepo = {
      getNextTurnIndex: async () => 0,
      insert: async () => {
        throw Object.assign(new Error("disk full"), { code: "STRATA_E_X" });
      },
    } as unknown as MessagesRepository;

    const logPath = path.join(tmp, "err.log");
    const errLogger = createLogger({ level: "debug", logFilePath: logPath });

    await expect(
      handleMessageReceived(
        { messagesRepo: throwingRepo, logger: errLogger },
        { from: "u1", content: "hi" },
        { channelId: "telegram", conversationId: "c1" },
      ),
    ).resolves.toBeUndefined();

    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const errLine = lines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine.session_id).toBe("c1");
    expect(errLine.error).toBe("disk full");
    expect(errLine.code).toBe("STRATA_E_X");
  });
});

describe("handleMessageSent", () => {
  let tmp: string;
  let db: Database;
  let messagesRepo: MessagesRepository;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-hooks-out-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    messagesRepo = new MessagesRepository(db);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "plugin.log"),
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("persists a delivered outbound message", async () => {
    // seed one inbound first so turn_index is 1
    await handleMessageReceived(
      { messagesRepo, logger },
      { from: "u1", content: "hi" },
      { channelId: "telegram", conversationId: "conv-1" },
    );
    await handleMessageSent(
      { messagesRepo, logger },
      { to: "u1", content: "ok", success: true },
      { channelId: "telegram", conversationId: "conv-1" },
    );
    const rows = await messagesRepo.findMany({}, { orderBy: "turn_index" });
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[1]?.turn_index).toBe(1);
    expect(rows[1]?.content).toBe("ok");
  });

  it("skips failed outbound messages and writes a debug log", async () => {
    const logPath = path.join(tmp, "skip.log");
    const debugLogger = createLogger({ level: "debug", logFilePath: logPath });
    await handleMessageSent(
      { messagesRepo, logger: debugLogger },
      { to: "u1", content: "x", success: false, error: "timeout" },
      { channelId: "telegram", conversationId: "conv-1" },
    );
    expect(await messagesRepo.count()).toBe(0);
    const lines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const debugLine = lines.find((l) => l.level === "debug");
    expect(debugLine).toBeDefined();
    expect(debugLine.error).toBe("timeout");
  });

  it("respects the level gate — does not record a debug log when level is info", async () => {
    const logPath = path.join(tmp, "level.log");
    const infoLogger = createLogger({ level: "info", logFilePath: logPath });
    await handleMessageSent(
      { messagesRepo, logger: infoLogger },
      { to: "u1", content: "x", success: false, error: "timeout" },
      { channelId: "telegram" },
    );
    // Nothing was written because the skip path uses debug-level only.
    expect(() => readFileSync(logPath, "utf8")).toThrowError(/ENOENT/);
  });
});
