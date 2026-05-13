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
  CapabilityHealthRepository,
  CapabilityRegistryRepository,
  MessagesRepository,
  ProposalsRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { runReflectOnce } from "./runner.js";

describe("runReflectOnce", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let capabilityHealthRepo: CapabilityHealthRepository;
  let proposalsRepo: ProposalsRepository;

  async function seedUnclassifiedCluster(count: number, spanDays: number): Promise<void> {
    const m = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    for (let i = 0; i < count; i++) {
      const t = new Date(Date.now() - Math.floor((i * spanDays) / count) * 86_400_000).toISOString();
      await rawEventsRepo.insert({
        session_id: "s",
        event_type: "unclassified",
        status: "committed",
        extracted_data: "{}",
        source_summary: `unclassified ${i}`,
        primary_message_id: m.id,
        related_message_ids: JSON.stringify([m.id]),
        extraction_version: 1,
        created_at: t,
        updated_at: t,
      });
    }
  }

  async function seedStaleCapability(name: string): Promise<void> {
    await capabilityRegistryRepo.insert({
      name,
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: name,
      created_at: new Date().toISOString(),
    });
    await capabilityHealthRepo.insert({
      capability_name: name,
      total_writes: 1,
      total_reads: 0,
      total_corrections: 0,
      last_write_at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      last_read_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-reflect-run-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    capabilityHealthRepo = new CapabilityHealthRepository(db);
    proposalsRepo = new ProposalsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("composes detect → generate → push when notify supplied", async () => {
    await seedUnclassifiedCluster(15, 10);
    await seedStaleCapability("old_cap");
    const notify = vi.fn(async () => {});
    const result = await runReflectOnce({
      db,
      capabilityRegistryRepo,
      capabilityHealthRepo,
      proposalsRepo,
      logger,
      notify,
    });
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
    expect(result.generated.inserted.length).toBeGreaterThanOrEqual(2);
    expect(result.pushed).toBe(result.generated.inserted.length);
    expect(notify).toHaveBeenCalledTimes(result.pushed);
  });

  it("skips push when notify is undefined", async () => {
    await seedUnclassifiedCluster(15, 10);
    const result = await runReflectOnce({
      db,
      capabilityRegistryRepo,
      capabilityHealthRepo,
      proposalsRepo,
      logger,
    });
    expect(result.pushed).toBe(0);
    expect(result.generated.inserted.length).toBeGreaterThanOrEqual(1);
  });
});
