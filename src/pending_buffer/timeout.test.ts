import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  MessagesRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { PendingBuffer } from "./index.js";
import { startPendingTimeoutLoop } from "./timeout.js";

describe("startPendingTimeoutLoop", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;
  let pendingBuffer: PendingBuffer;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-ptimeout-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
    pendingBuffer = new PendingBuffer({
      stateFile: path.join(tmp, "pending_buffer.json"),
      logger,
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
    vi.useRealTimers();
  });

  /** Seed a pending raw_event whose `created_at` is `minutesAgo` ago. */
  async function seedExpiredPending(opts: {
    session_id: string;
    confidence: number | null;
    minutesAgo: number;
  }): Promise<number> {
    const msg = await messagesRepo.insert({
      session_id: opts.session_id,
      channel: "telegram",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    const createdAt = new Date(
      Date.now() - opts.minutesAgo * 60_000,
    ).toISOString();
    const row = await rawEventsRepo.insert({
      session_id: opts.session_id,
      event_type: "consumption",
      status: "pending",
      extracted_data: "{}",
      source_summary: "x",
      primary_message_id: msg.id,
      related_message_ids: JSON.stringify([msg.id]),
      extraction_version: 1,
      extraction_confidence: opts.confidence,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await pendingBuffer.add(opts.session_id, row.id);
    return row.id;
  }

  it("auto-commits a high-confidence expired pending event", async () => {
    vi.useFakeTimers();
    const id = await seedExpiredPending({
      session_id: "s-high",
      confidence: 0.9,
      minutesAgo: 60,
    });
    const stop = startPendingTimeoutLoop({
      pendingBuffer,
      rawEventsRepo,
      timeoutMinutes: 30,
      logger,
      pollEveryMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    stop();

    const row = await rawEventsRepo.findById(id);
    expect(row?.status).toBe("committed");
    expect(row?.committed_at).toBeTruthy();
    expect(await pendingBuffer.has("s-high", id)).toBe(false);
  });

  it("auto-abandons a low-confidence expired pending event", async () => {
    vi.useFakeTimers();
    const id = await seedExpiredPending({
      session_id: "s-low",
      confidence: 0.2,
      minutesAgo: 60,
    });
    const stop = startPendingTimeoutLoop({
      pendingBuffer,
      rawEventsRepo,
      timeoutMinutes: 30,
      logger,
      pollEveryMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    stop();

    const row = await rawEventsRepo.findById(id);
    expect(row?.status).toBe("abandoned");
    expect(row?.abandoned_reason).toBe("pending_timeout");
    expect(await pendingBuffer.has("s-low", id)).toBe(false);
  });

  it("treats NULL confidence as low and abandons", async () => {
    vi.useFakeTimers();
    const id = await seedExpiredPending({
      session_id: "s-null",
      confidence: null,
      minutesAgo: 60,
    });
    const stop = startPendingTimeoutLoop({
      pendingBuffer,
      rawEventsRepo,
      timeoutMinutes: 30,
      logger,
      pollEveryMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    stop();

    const row = await rawEventsRepo.findById(id);
    expect(row?.status).toBe("abandoned");
  });

  it("leaves fresh pending events alone", async () => {
    vi.useFakeTimers();
    const id = await seedExpiredPending({
      session_id: "s-fresh",
      confidence: 0.9,
      minutesAgo: 5, // not expired
    });
    const stop = startPendingTimeoutLoop({
      pendingBuffer,
      rawEventsRepo,
      timeoutMinutes: 30,
      logger,
      pollEveryMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    stop();

    const row = await rawEventsRepo.findById(id);
    expect(row?.status).toBe("pending");
    expect(await pendingBuffer.has("s-fresh", id)).toBe(true);
  });

  it("stop() halts further iterations and is idempotent", async () => {
    vi.useFakeTimers();
    const id = await seedExpiredPending({
      session_id: "s",
      confidence: 0.9,
      minutesAgo: 60,
    });
    const stop = startPendingTimeoutLoop({
      pendingBuffer,
      rawEventsRepo,
      timeoutMinutes: 30,
      logger,
      pollEveryMs: 100,
    });
    stop();
    stop(); // second call must not throw
    await vi.advanceTimersByTimeAsync(500);

    const row = await rawEventsRepo.findById(id);
    // Nothing ran — row is still pending.
    expect(row?.status).toBe("pending");
  });
});
