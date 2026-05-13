import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  CapabilityHealthRepository,
  MessagesRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { runPipeline, runPipelineForEvent } from "./pipeline_runner.js";
import type { CapabilityRegistry, LoadedCapability } from "./types.js";

interface FakeCapability {
  name: string;
  dir: string;
  loaded: LoadedCapability;
}

let capCounter = 0;

/**
 * Emit a `pipeline.ts` file at `<dir>/pipeline.ts` whose `ingest` runs
 * `inlinePipelineBody`. Returns the `LoadedCapability` you can register.
 *
 * Each call gets a fresh capability *name* so Node's `import()` cache
 * doesn't return a stale module on rapid-fire calls in the same suite.
 */
function makeFakeCapability(
  rootTmp: string,
  inlinePipelineBody: string,
  opts: { extraFiles?: Record<string, string>; bareName?: string } = {},
): FakeCapability {
  const name = opts.bareName ?? `cap_${++capCounter}`;
  const dir = path.join(rootTmp, name, "v1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      name,
      version: 1,
      description: name,
      primary_table: name,
    }),
  );
  writeFileSync(path.join(dir, "pipeline.mjs"), inlinePipelineBody);
  for (const [filename, body] of Object.entries(opts.extraFiles ?? {})) {
    writeFileSync(path.join(dir, filename), body);
  }
  const loaded: LoadedCapability = {
    meta: {
      name,
      version: 1,
      description: name,
      primary_table: name,
      depends_on_capabilities: [],
      ingest_event_types: [],
      owner_pipeline: "pipeline.mjs",
      exposed_skills: [],
    },
    path: dir,
    metaPath: path.join(dir, "meta.json"),
  };
  return { name, dir, loaded };
}

describe("pipeline runner", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;
  let capabilityHealthRepo: CapabilityHealthRepository;
  let registry: CapabilityRegistry;

  async function seedRawEvent(opts: {
    capability_name: string | null;
    extracted_data?: Record<string, unknown>;
  }): Promise<number> {
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
    const row = await rawEventsRepo.insert({
      session_id: "s",
      event_type: "test",
      status: "committed",
      extracted_data: JSON.stringify(opts.extracted_data ?? {}),
      source_summary: "x",
      primary_message_id: msg.id,
      related_message_ids: JSON.stringify([msg.id]),
      capability_name: opts.capability_name,
      extraction_version: 1,
      extraction_confidence: 0.9,
      committed_at: now,
      created_at: now,
      updated_at: now,
    });
    return row.id;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-pipeline-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
    capabilityHealthRepo = new CapabilityHealthRepository(db);
    registry = new Map();
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path: writes business row, links raw_event, bumps capability_health", async () => {
    const cap = makeFakeCapability(
      tmp,
      `export async function ingest(rawEvent, deps) {
        deps.db.exec("CREATE TABLE IF NOT EXISTS ${capCounterTableName()} (id INTEGER PRIMARY KEY, raw_event_id INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL)");
        const row = deps.db.prepare("INSERT INTO ${capCounterTableName()} (raw_event_id, note, created_at) VALUES (?, ?, ?) RETURNING id").get(rawEvent.id, "ok", deps.now());
        return { business_row_id: row.id, business_table: "${capCounterTableName()}" };
      }`,
    );
    registry.set(cap.name, cap.loaded);
    // Register row in capability_registry so capability_health FK is satisfied.
    db.prepare(
      "INSERT INTO capability_registry (name, version, status, meta_path, primary_table, created_at) VALUES (?, 1, 'active', ?, ?, ?)",
    ).run(cap.name, cap.loaded.metaPath, cap.name, new Date().toISOString());

    const eventId = await seedRawEvent({ capability_name: cap.name });
    const rawEvent = await rawEventsRepo.findById(eventId);
    const r = await runPipelineForEvent({
      rawEvent: rawEvent!,
      toolDeps: {
        db,
        registry,
        rawEventsRepo,
        capabilityHealthRepo,
        logger,
      },
    });

    expect(r.capability_written).toBe(true);
    expect(r.business_row_id).toBeGreaterThan(0);
    const updated = await rawEventsRepo.findById(eventId);
    expect(updated?.business_row_id).toBe(r.business_row_id);

    const health = await capabilityHealthRepo.findById(cap.name);
    expect(health?.total_writes).toBe(1);
  });

  it("unbound event (capability_name=null) short-circuits with no logs", async () => {
    const eventId = await seedRawEvent({ capability_name: null });
    const rawEvent = await rawEventsRepo.findById(eventId);
    const r = await runPipelineForEvent({
      rawEvent: rawEvent!,
      toolDeps: { db, registry, rawEventsRepo, capabilityHealthRepo, logger },
    });
    expect(r.capability_written).toBe(false);
    expect(r.business_row_id).toBeUndefined();
  });

  it("bound to a capability not in the registry returns false and warns", async () => {
    const eventId = await seedRawEvent({ capability_name: "ghost" });
    const rawEvent = await rawEventsRepo.findById(eventId);
    const r = await runPipelineForEvent({
      rawEvent: rawEvent!,
      toolDeps: { db, registry, rawEventsRepo, capabilityHealthRepo, logger },
    });
    expect(r.capability_written).toBe(false);
    const updated = await rawEventsRepo.findById(eventId);
    expect(updated?.business_row_id).toBeNull();
  });

  it("pipeline throw is caught; raw_event keeps committed, no business row", async () => {
    const cap = makeFakeCapability(
      tmp,
      `export async function ingest(rawEvent, deps) {
        throw new Error("nope");
      }`,
    );
    registry.set(cap.name, cap.loaded);
    db.prepare(
      "INSERT INTO capability_registry (name, version, status, meta_path, primary_table, created_at) VALUES (?, 1, 'active', ?, ?, ?)",
    ).run(cap.name, cap.loaded.metaPath, cap.name, new Date().toISOString());

    const eventId = await seedRawEvent({ capability_name: cap.name });
    const rawEvent = await rawEventsRepo.findById(eventId);
    const r = await runPipelineForEvent({
      rawEvent: rawEvent!,
      toolDeps: { db, registry, rawEventsRepo, capabilityHealthRepo, logger },
    });
    expect(r.capability_written).toBe(false);
    const updated = await rawEventsRepo.findById(eventId);
    expect(updated?.status).toBe("committed");
    expect(updated?.business_row_id).toBeNull();
  });

  it("partial-write rollback: pipeline that inserts then throws leaves the table empty", async () => {
    const cap = makeFakeCapability(
      tmp,
      `export async function ingest(rawEvent, deps) {
        deps.db.exec("CREATE TABLE IF NOT EXISTS rollback_test (id INTEGER PRIMARY KEY, raw_event_id INTEGER NOT NULL)");
        deps.db.prepare("INSERT INTO rollback_test (raw_event_id) VALUES (?)").run(rawEvent.id);
        throw new Error("after-insert failure");
      }`,
    );
    // Pre-create the table outside the pipeline transaction so the
    // CREATE TABLE inside doesn't affect rollback semantics.
    db.exec("CREATE TABLE rollback_test (id INTEGER PRIMARY KEY, raw_event_id INTEGER NOT NULL)");

    await expect(
      runPipeline(
        cap.loaded,
        {
          id: 1,
          session_id: "s",
          event_type: "x",
          status: "committed",
          extracted_data: "{}",
          source_summary: "x",
          primary_message_id: 1,
          related_message_ids: "[1]",
          event_occurred_at: null,
          committed_at: null,
          supersedes_event_id: null,
          superseded_by_event_id: null,
          abandoned_reason: null,
          capability_name: cap.name,
          business_row_id: null,
          extraction_version: 1,
          extraction_confidence: 0.9,
          extraction_errors: null,
          created_at: "x",
          updated_at: "x",
        },
        { db, logger, now: () => "now" },
      ),
    ).rejects.toThrow(/pipeline for capability/);

    const count = db.prepare("SELECT COUNT(*) AS c FROM rollback_test").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("missing pipeline.ts throws STRATA_E_PIPELINE_INVALID", async () => {
    const dir = path.join(tmp, "nopipeline", "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        name: "nopipeline",
        version: 1,
        description: "x",
        primary_table: "nopipeline",
      }),
    );
    const loaded: LoadedCapability = {
      meta: {
        name: "nopipeline",
        version: 1,
        description: "x",
        primary_table: "nopipeline",
        depends_on_capabilities: [],
        ingest_event_types: [],
        owner_pipeline: "pipeline.mjs",
        exposed_skills: [],
      },
      path: dir,
      metaPath: path.join(dir, "meta.json"),
    };
    await expect(
      runPipeline(
        loaded,
        {
          id: 1,
          session_id: "s",
          event_type: "x",
          status: "committed",
          extracted_data: "{}",
          source_summary: "x",
          primary_message_id: 1,
          related_message_ids: "[1]",
          event_occurred_at: null,
          committed_at: null,
          supersedes_event_id: null,
          superseded_by_event_id: null,
          abandoned_reason: null,
          capability_name: "nopipeline",
          business_row_id: null,
          extraction_version: 1,
          extraction_confidence: 0.9,
          extraction_errors: null,
          created_at: "x",
          updated_at: "x",
        },
        { db, logger, now: () => "now" },
      ),
    ).rejects.toMatchObject({ code: "STRATA_E_PIPELINE_INVALID" });
  });

  it("module without ingest export throws STRATA_E_PIPELINE_INVALID", async () => {
    const cap = makeFakeCapability(
      tmp,
      `export const hello = 1;`,
    );
    await expect(
      runPipeline(
        cap.loaded,
        {
          id: 1,
          session_id: "s",
          event_type: "x",
          status: "committed",
          extracted_data: "{}",
          source_summary: "x",
          primary_message_id: 1,
          related_message_ids: "[1]",
          event_occurred_at: null,
          committed_at: null,
          supersedes_event_id: null,
          superseded_by_event_id: null,
          abandoned_reason: null,
          capability_name: cap.name,
          business_row_id: null,
          extraction_version: 1,
          extraction_confidence: 0.9,
          extraction_errors: null,
          created_at: "x",
          updated_at: "x",
        },
        { db, logger, now: () => "now" },
      ),
    ).rejects.toMatchObject({ code: "STRATA_E_PIPELINE_INVALID" });
  });
});

/** Per-test unique table name so we don't fight Node's import cache. */
function capCounterTableName(): string {
  return `biz_${capCounter}`;
}
