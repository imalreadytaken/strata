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
import { reextractRawEventsStrategy } from "./reextract_raw_events.js";
import type { ReextractRunDeps } from "../types.js";
import type { ReextractJobRow } from "../../db/repositories/reextract_jobs.js";

const NOW = () => new Date("2026-05-13T00:00:00Z");

describe("reextractRawEventsStrategy", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let deps: ReextractRunDeps;
  let job: ReextractJobRow;
  let rawEventId: number;
  let businessRowId: number;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-rre-"));
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
    const m = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: NOW().toISOString(),
    });
    const rawEventsRepo = new RawEventsRepository(db);
    const re = await rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "committed",
      extracted_data: JSON.stringify({ merchant: "Blue Bottle", amount_minor: 4500 }),
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: m.id,
      related_message_ids: JSON.stringify([m.id]),
      extraction_version: 1,
      created_at: NOW().toISOString(),
      updated_at: NOW().toISOString(),
    });
    rawEventId = re.id;
    const info = db
      .prepare(
        "INSERT INTO expenses (raw_event_id, amount_minor, created_at) VALUES (?, ?, ?) RETURNING id",
      )
      .get(rawEventId, 4500, NOW().toISOString()) as { id: number };
    businessRowId = info.id;

    const evo = await deps.schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: JSON.stringify({
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt:
          "Pick a subcategory for this consumption event. {{context}}",
      }),
      proposed_at: NOW().toISOString(),
    });
    job = await deps.reextractJobsRepo.insert({
      schema_evolution_id: evo.id,
      capability_name: "expenses",
      strategy: "reextract_raw_events",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("context contains source_summary + extracted_data; calls LLM", async () => {
    const infer = vi.fn(async () => '{"value":"coffee","confidence":0.9}');
    deps.llmClient = { infer };
    const row = db
      .prepare("SELECT * FROM expenses WHERE id = ?")
      .get(businessRowId) as { id: number; raw_event_id: number };
    const out = await reextractRawEventsStrategy.process(row, job, deps);
    expect(out.kind).toBe("wrote");
    const userArg = infer.mock.calls[0]?.[0]?.user ?? "";
    expect(userArg).toContain("Blue Bottle 拿铁 ¥45");
    expect(userArg).toContain("merchant");
    expect(userArg).toContain("4500");
  });

  it("missing raw_event_id column → failed", async () => {
    deps.llmClient = { infer: async () => '{"value":"x","confidence":0.9}' };
    const out = await reextractRawEventsStrategy.process(
      { id: 99 },
      job,
      deps,
    );
    expect(out.kind).toBe("failed");
  });

  it("dangling raw_event_id → failed", async () => {
    deps.llmClient = { infer: async () => '{"value":"x","confidence":0.9}' };
    const out = await reextractRawEventsStrategy.process(
      { id: 1, raw_event_id: 9999 },
      job,
      deps,
    );
    expect(out.kind).toBe("failed");
  });
});
