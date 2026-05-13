import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../../core/logger.js";
import { openDatabase, type Database } from "../../db/connection.js";
import { applyMigrations } from "../../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../../db/index.js";
import {
  CapabilityRegistryRepository,
  MessagesRepository,
  RawEventsRepository,
  ReextractJobsRepository,
  SchemaEvolutionsRepository,
} from "../../db/repositories/index.js";
import { reextractMessagesStrategy } from "./reextract_messages.js";
import type { ReextractRunDeps } from "../types.js";
import type { ReextractJobRow } from "../../db/repositories/reextract_jobs.js";

const NOW = () => new Date("2026-05-13T00:00:00Z");

describe("reextractMessagesStrategy", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let deps: ReextractRunDeps;
  let job: ReextractJobRow;

  async function seedJob(): Promise<{ businessRowId: number; rawEventId: number }> {
    db.exec(
      `CREATE TABLE expenses (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
         amount_minor INTEGER NOT NULL,
         subcategory TEXT,
         created_at TEXT NOT NULL
       )`,
    );
    await deps.capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "expenses",
      created_at: NOW().toISOString(),
    });
    const messagesRepo = new MessagesRepository(db);
    const m1 = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "today bought blue bottle",
      content_type: "text",
      turn_index: 0,
      received_at: "2026-05-13T09:00:00Z",
    });
    const m2 = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "for 45 yuan",
      content_type: "text",
      turn_index: 1,
      received_at: "2026-05-13T09:01:00Z",
    });
    const m3 = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "iced latte",
      content_type: "text",
      turn_index: 2,
      received_at: "2026-05-13T09:02:00Z",
    });
    const rawEventsRepo = new RawEventsRepository(db);
    const re = await rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "committed",
      extracted_data: "{}",
      source_summary: "x",
      primary_message_id: m1.id,
      related_message_ids: JSON.stringify([m1.id, m2.id, m3.id]),
      extraction_version: 1,
      created_at: NOW().toISOString(),
      updated_at: NOW().toISOString(),
    });
    const info = db
      .prepare(
        "INSERT INTO expenses (raw_event_id, amount_minor, created_at) VALUES (?, ?, ?) RETURNING id",
      )
      .get(re.id, 4500, NOW().toISOString()) as { id: number };
    const evo = await deps.schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: JSON.stringify({
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Look at the messages: {{context}}",
      }),
      proposed_at: NOW().toISOString(),
    });
    job = await deps.reextractJobsRepo.insert({
      schema_evolution_id: evo.id,
      capability_name: "expenses",
      strategy: "reextract_messages",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
    return { businessRowId: info.id, rawEventId: re.id };
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-rme-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    deps = {
      db,
      capabilityRegistryRepo: new CapabilityRegistryRepository(db),
      reextractJobsRepo: new ReextractJobsRepository(db),
      schemaEvolutionsRepo: new SchemaEvolutionsRepository(db),
      logger,
      now: NOW,
    };
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("joins multi-message context in chronological order", async () => {
    const { businessRowId } = await seedJob();
    const infer = vi.fn(async () => '{"value":"coffee","confidence":0.9}');
    deps.llmClient = { infer };
    const row = db
      .prepare("SELECT * FROM expenses WHERE id = ?")
      .get(businessRowId) as { id: number; raw_event_id: number };
    await reextractMessagesStrategy.process(row, job, deps);
    const userArg = infer.mock.calls[0]?.[0]?.user ?? "";
    const idxA = userArg.indexOf("today bought blue bottle");
    const idxB = userArg.indexOf("for 45 yuan");
    const idxC = userArg.indexOf("iced latte");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  it("missing message ids are silently dropped", async () => {
    const { businessRowId } = await seedJob();
    // Manually corrupt related_message_ids to point at non-existent ids.
    db.prepare(
      "UPDATE raw_events SET related_message_ids = '[1,9999,2]' WHERE id = (SELECT raw_event_id FROM expenses WHERE id = ?)",
    ).run(businessRowId);
    const infer = vi.fn(async () => '{"value":"coffee","confidence":0.9}');
    deps.llmClient = { infer };
    const row = db
      .prepare("SELECT * FROM expenses WHERE id = ?")
      .get(businessRowId) as { id: number; raw_event_id: number };
    const out = await reextractMessagesStrategy.process(row, job, deps);
    expect(out.kind).toBe("wrote");
  });

  it("dangling raw_event_id → failed", async () => {
    await seedJob();
    deps.llmClient = { infer: async () => '{"value":"x","confidence":0.9}' };
    const out = await reextractMessagesStrategy.process(
      { id: 1, raw_event_id: 9999 },
      job,
      deps,
    );
    expect(out.kind).toBe("failed");
  });
});
