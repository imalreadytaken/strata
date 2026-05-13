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
  CapabilityRegistryRepository,
  MessagesRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { applyCapabilityMigrations } from "../capabilities/migrations.js";
import {
  detectNewCapabilityEmergence,
  detectSchemaEvolutionNeed,
  type EmergenceDeps,
} from "./emergence_detector.js";
import type { LLMClient } from "../triage/index.js";

describe("detectNewCapabilityEmergence", () => {
  let tmp: string;
  let db: Database;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let logger: Logger;
  let deps: EmergenceDeps;
  let msgId: number;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-emergence-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    deps = { db, capabilityRegistryRepo, logger };
    const m = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    msgId = m.id;
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function seedCommitted(
    eventType: string | null,
    daysAgo: number,
    capability: string | null = null,
    summary = "x",
  ): Promise<number> {
    const createdAt = new Date(
      Date.now() - daysAgo * 86_400_000,
    ).toISOString();
    const r = await rawEventsRepo.insert({
      session_id: "s",
      event_type: eventType ?? "unclassified",
      status: "committed",
      extracted_data: "{}",
      source_summary: summary,
      primary_message_id: msgId,
      related_message_ids: JSON.stringify([msgId]),
      capability_name: capability,
      extraction_version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    });
    return r.id;
  }

  it("emits a signal for a 12-row unclassified cluster spanning 10 days", async () => {
    for (let i = 0; i < 12; i++) {
      await seedCommitted("unclassified", i);
    }
    const signals = await detectNewCapabilityEmergence(deps);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe("new_capability");
    expect(signals[0]?.suggested_name).toBe("unclassified");
    expect(signals[0]?.evidence_event_ids.length).toBe(12);
    expect(signals[0]?.signal_strength).toBeGreaterThan(0.3);
  });

  it("drops a cluster below min_cluster_size", async () => {
    for (let i = 0; i < 5; i++) await seedCommitted("dreams", i);
    const signals = await detectNewCapabilityEmergence(deps);
    expect(signals).toHaveLength(0);
  });

  it("drops a cluster spanning less than min_span_days", async () => {
    for (let i = 0; i < 12; i++) await seedCommitted("dreams", 0);
    const signals = await detectNewCapabilityEmergence(deps);
    expect(signals).toHaveLength(0);
  });

  it("excludes events whose capability is an active registry entry", async () => {
    await capabilityRegistryRepo.insert({
      name: "dreams",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "dreams",
      created_at: new Date().toISOString(),
    });
    for (let i = 0; i < 12; i++) await seedCommitted("dreams", i, "dreams");
    const signals = await detectNewCapabilityEmergence(deps);
    expect(signals).toHaveLength(0);
  });

  it("upgrades suggested_name via LLM when useLLM is true", async () => {
    for (let i = 0; i < 12; i++) await seedCommitted("hobby", i, null, "skateboard ride 30min");
    const llm: LLMClient = {
      infer: async () =>
        JSON.stringify({ suggested_name: "skate_log", rationale: "skateboarding sessions" }),
    };
    const signals = await detectNewCapabilityEmergence(
      { ...deps, llmClient: llm },
      { useLLM: true },
    );
    expect(signals[0]?.suggested_name).toBe("skate_log");
    expect(signals[0]?.rationale).toBe("skateboarding sessions");
  });

  it("falls back to slug when LLM throws", async () => {
    for (let i = 0; i < 12; i++) await seedCommitted("hobby", i);
    const llm: LLMClient = {
      infer: async () => {
        throw new Error("network");
      },
    };
    const signals = await detectNewCapabilityEmergence(
      { ...deps, llmClient: llm },
      { useLLM: true },
    );
    expect(signals[0]?.suggested_name).toBe("hobby");
  });

  it("respects custom thresholds", async () => {
    for (let i = 0; i < 4; i++) await seedCommitted("x", i);
    const signals = await detectNewCapabilityEmergence(deps, {
      thresholds: { emergence: { min_cluster_size: 3, min_span_days: 2 } },
    });
    expect(signals).toHaveLength(1);
  });
});

describe("detectSchemaEvolutionNeed", () => {
  let tmp: string;
  let db: Database;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let logger: Logger;
  let deps: EmergenceDeps;

  async function seedExpensesCapability(): Promise<void> {
    const migDir = path.join(tmp, "migrations");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      path.join(migDir, "001_init.sql"),
      `CREATE TABLE expenses (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
         extraction_version INTEGER NOT NULL DEFAULT 1,
         occurred_at TEXT NOT NULL,
         amount_minor INTEGER NOT NULL,
         currency TEXT NOT NULL DEFAULT 'CNY',
         merchant TEXT,
         category TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );`,
    );
    applyCapabilityMigrations(db, "expenses", migDir);
    await capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x/meta.json",
      primary_table: "expenses",
      created_at: new Date().toISOString(),
    });
  }

  async function seedRow(merchant: string | null, category: string | null): Promise<void> {
    db.prepare(
      `INSERT INTO expenses (raw_event_id, occurred_at, amount_minor, currency, merchant, category, created_at, updated_at) VALUES (?, ?, ?, 'CNY', ?, ?, ?, ?)`,
    ).run(1, "2026-05-13T00:00:00Z", 100, merchant, category, "x", "x");
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-skew-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    deps = { db, capabilityRegistryRepo, logger };
    await seedExpensesCapability();
    // Seed a raw_event so the FK on expenses.raw_event_id is happy.
    const messagesRepo = new MessagesRepository(db);
    const rawEventsRepo = new RawEventsRepository(db);
    const m = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    await rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "committed",
      extracted_data: "{}",
      source_summary: "x",
      primary_message_id: m.id,
      related_message_ids: JSON.stringify([m.id]),
      extraction_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("emits a signal for a skewed category column", async () => {
    for (let i = 0; i < 35; i++) await seedRow("Blue Bottle", "dining");
    for (let i = 0; i < 5; i++) await seedRow("Cab Inc", "transport");
    const signals = await detectSchemaEvolutionNeed(deps);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const cat = signals.find((s) => s.column === "category");
    expect(cat?.dominant_value).toBe("dining");
    expect(cat?.ratio).toBeCloseTo(35 / 40);
  });

  it("emits no signal when values are evenly distributed", async () => {
    for (const c of ["dining", "transport", "groceries", "health"]) {
      for (let i = 0; i < 10; i++) await seedRow("x", c);
    }
    const signals = await detectSchemaEvolutionNeed(deps);
    expect(signals.filter((s) => s.column === "category")).toHaveLength(0);
  });

  it("emits no signal when row count is below min_rows_for_skew_check", async () => {
    for (let i = 0; i < 10; i++) await seedRow("x", "dining");
    const signals = await detectSchemaEvolutionNeed(deps);
    expect(signals.filter((s) => s.column === "category")).toHaveLength(0);
  });

  it("does not skew on _at or currency columns", async () => {
    for (let i = 0; i < 35; i++) await seedRow(null, null);
    const signals = await detectSchemaEvolutionNeed(deps);
    expect(signals.filter((s) => s.column === "currency")).toHaveLength(0);
    expect(signals.filter((s) => s.column === "created_at")).toHaveLength(0);
  });
});
