import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../../../../core/logger.js";
import { openDatabase, type Database } from "../../../../db/connection.js";
import { applyMigrations } from "../../../../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../../../../db/index.js";
import {
  MessagesRepository,
  RawEventsRepository,
} from "../../../../db/repositories/index.js";
import { applyCapabilityMigrations } from "../../../migrations.js";
import { ingest } from "../pipeline.js";
import type { RawEventRow } from "../../../../db/repositories/raw_events.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, "..", "migrations");

interface ExpensesRow {
  id: number;
  raw_event_id: number;
  extraction_version: number;
  extraction_confidence: number | null;
  occurred_at: string;
  amount_minor: number;
  currency: string;
  merchant: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
}

describe("expenses pipeline", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;

  async function seedRawEvent(opts: {
    extracted_data: Record<string, unknown>;
    event_occurred_at?: string | null;
    confidence?: number;
  }): Promise<RawEventRow> {
    const msg = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    return rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "committed",
      capability_name: "expenses",
      extracted_data: JSON.stringify(opts.extracted_data),
      source_summary: "x",
      primary_message_id: msg.id,
      related_message_ids: JSON.stringify([msg.id]),
      event_occurred_at: opts.event_occurred_at ?? null,
      extraction_version: 1,
      extraction_confidence: opts.confidence ?? 0.9,
      committed_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-expenses-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    applyCapabilityMigrations(db, "expenses", MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path: inserts a row with all fields", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: {
        amount_minor: 4500,
        currency: "CNY",
        merchant: "Blue Bottle",
        category: "dining",
      },
      event_occurred_at: "2026-05-13T09:00:00+08:00",
    });
    const result = await ingest(rawEvent, {
      db,
      logger,
      now: () => "2026-05-13T09:30:00+08:00",
    });
    expect(result.business_table).toBe("expenses");
    expect(result.business_row_id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM expenses WHERE id = ?")
      .get(result.business_row_id) as ExpensesRow;
    expect(row.amount_minor).toBe(4500);
    expect(row.currency).toBe("CNY");
    expect(row.merchant).toBe("Blue Bottle");
    expect(row.category).toBe("dining");
    expect(row.occurred_at).toBe("2026-05-13T09:00:00+08:00");
    expect(row.raw_event_id).toBe(rawEvent.id);
    expect(row.extraction_version).toBe(1);
    expect(row.extraction_confidence).toBeCloseTo(0.9);
  });

  it("minimal payload: currency defaults to CNY, merchant/category null", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: { amount_minor: 3500 },
      event_occurred_at: "2026-05-13T09:00:00+08:00",
    });
    const result = await ingest(rawEvent, {
      db,
      logger,
      now: () => "now",
    });
    const row = db
      .prepare("SELECT * FROM expenses WHERE id = ?")
      .get(result.business_row_id) as ExpensesRow;
    expect(row.amount_minor).toBe(3500);
    expect(row.currency).toBe("CNY");
    expect(row.merchant).toBeNull();
    expect(row.category).toBeNull();
  });

  it("occurred_at resolution: extracted.occurred_at wins when event_occurred_at is null", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: {
        amount_minor: 1000,
        occurred_at: "2026-05-12T12:00:00+08:00",
      },
      event_occurred_at: null,
    });
    const result = await ingest(rawEvent, {
      db,
      logger,
      now: () => "now",
    });
    const row = db
      .prepare("SELECT occurred_at FROM expenses WHERE id = ?")
      .get(result.business_row_id) as Pick<ExpensesRow, "occurred_at">;
    expect(row.occurred_at).toBe("2026-05-12T12:00:00+08:00");
  });

  it("occurred_at resolution: falls back to created_at when nothing else is set", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: { amount_minor: 1000 },
      event_occurred_at: null,
    });
    const result = await ingest(rawEvent, {
      db,
      logger,
      now: () => "now",
    });
    const row = db
      .prepare("SELECT occurred_at FROM expenses WHERE id = ?")
      .get(result.business_row_id) as Pick<ExpensesRow, "occurred_at">;
    expect(row.occurred_at).toBe(rawEvent.created_at);
  });

  it("rejects missing amount_minor", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: { merchant: "x" },
      event_occurred_at: "2026-05-13T09:00:00+08:00",
    });
    await expect(
      ingest(rawEvent, { db, logger, now: () => "now" }),
    ).rejects.toThrow();
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM expenses")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("rejects negative amount_minor", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: { amount_minor: -1 },
      event_occurred_at: "2026-05-13T09:00:00+08:00",
    });
    await expect(
      ingest(rawEvent, { db, logger, now: () => "now" }),
    ).rejects.toThrow();
  });

  it("rejects unknown category enum value", async () => {
    const rawEvent = await seedRawEvent({
      extracted_data: { amount_minor: 1000, category: "nightlife" },
      event_occurred_at: "2026-05-13T09:00:00+08:00",
    });
    await expect(
      ingest(rawEvent, { db, logger, now: () => "now" }),
    ).rejects.toThrow();
  });

  it("DB rejects insert with missing raw_event_id FK", async () => {
    // Direct INSERT bypassing the pipeline to test the FK constraint.
    expect(() =>
      db
        .prepare(
          "INSERT INTO expenses (raw_event_id, extraction_version, occurred_at, amount_minor, currency, created_at, updated_at) VALUES (?, 1, ?, 1000, 'CNY', ?, ?)",
        )
        .run(9999, "2026-05-13T09:00:00+08:00", "now", "now"),
    ).toThrow(/FOREIGN KEY/);
  });

  it("extract_prompt.md mentions worked examples + minor units", async () => {
    const promptPath = path.resolve(HERE, "..", "extract_prompt.md");
    const body = await readFile(promptPath, "utf8");
    expect(body).toContain("¥");
    expect(body).toContain("$");
    expect(body).toMatch(/minor/i);
  });
});
