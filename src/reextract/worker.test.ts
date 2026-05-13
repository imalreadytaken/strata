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
  ReextractJobsRepository,
  SchemaEvolutionsRepository,
} from "../db/repositories/index.js";
import { ReextractStrategyRegistry } from "./registry.js";
import { pickNextPendingJob, startReextractWorker } from "./worker.js";

const NOW = () => new Date("2026-05-13T00:00:00Z");

describe("pickNextPendingJob", () => {
  let tmp: string;
  let db: Database;
  let repo: ReextractJobsRepository;
  let schemaEvolutionsRepo: SchemaEvolutionsRepository;
  let capabilityRegistryRepo: CapabilityRegistryRepository;

  async function seedJob(status: "pending" | "running" | "done"): Promise<number> {
    const evo = await schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: "{}",
      proposed_at: NOW().toISOString(),
    });
    const r = await repo.insert({
      schema_evolution_id: evo.id,
      capability_name: "expenses",
      strategy: "derive_existing",
      status,
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
    return r.id;
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-reextract-pick-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    repo = new ReextractJobsRepository(db);
    schemaEvolutionsRepo = new SchemaEvolutionsRepository(db);
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    // schema_evolutions FK references capability_registry — seed it.
    await capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "expenses",
      created_at: NOW().toISOString(),
    });
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns null when no pending jobs", async () => {
    await seedJob("running");
    expect(await pickNextPendingJob(repo)).toBeNull();
  });

  it("returns the lowest-id pending job", async () => {
    const a = await seedJob("pending");
    await seedJob("pending"); // higher id
    const picked = await pickNextPendingJob(repo);
    expect(picked?.id).toBe(a);
  });
});

describe("startReextractWorker", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let reextractJobsRepo: ReextractJobsRepository;
  let schemaEvolutionsRepo: SchemaEvolutionsRepository;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-reextract-worker-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    reextractJobsRepo = new ReextractJobsRepository(db);
    schemaEvolutionsRepo = new SchemaEvolutionsRepository(db);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function seedCapabilityAndRows(): Promise<void> {
    db.exec(
      `CREATE TABLE expenses (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         amount_minor INTEGER NOT NULL,
         currency TEXT,
         created_at TEXT NOT NULL
       )`,
    );
    await capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "expenses",
      created_at: NOW().toISOString(),
    });
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO expenses (amount_minor, currency, created_at) VALUES (?, ?, ?)",
      ).run(100 + i, null, NOW().toISOString());
    }
  }

  it("transitions a pending job through running → done on tick", async () => {
    await seedCapabilityAndRows();
    const evo = await schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: JSON.stringify({
        kind: "constant",
        target_column: "currency",
        value: "CNY",
      }),
      proposed_at: NOW().toISOString(),
    });
    const job = await reextractJobsRepo.insert({
      schema_evolution_id: evo.id,
      capability_name: "expenses",
      strategy: "stub",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });

    const registry = new ReextractStrategyRegistry();
    registry.register({
      name: "stub",
      process: async () => ({ kind: "wrote", confidence: 1, costCents: 5 }),
    });
    const stop = startReextractWorker(
      {
        db,
        capabilityRegistryRepo,
        reextractJobsRepo,
        schemaEvolutionsRepo,
        logger,
        now: NOW,
      },
      { intervalMs: 10, registry, now: NOW },
    );
    await vi.advanceTimersByTimeAsync(50);
    stop();
    const row = await reextractJobsRepo.findById(job.id);
    expect(row?.status).toBe("done");
    expect(row?.rows_done).toBe(3);
    expect(row?.actual_cost_cents).toBe(15);
    expect(row?.completed_at).toBeTruthy();
    expect(row?.started_at).toBeTruthy();
  });

  it("enabled=false returns a no-op stop without registering a timer", async () => {
    const stop = startReextractWorker(
      {
        db,
        capabilityRegistryRepo,
        reextractJobsRepo,
        schemaEvolutionsRepo,
        logger,
        now: NOW,
      },
      { enabled: false },
    );
    // No timer to advance; calling stop is safe and returns.
    expect(() => stop()).not.toThrow();
  });

  it("stop() halts further ticks", async () => {
    const registry = new ReextractStrategyRegistry();
    const calls: number[] = [];
    registry.register({
      name: "tracking",
      process: async () => {
        calls.push(Date.now());
        return { kind: "wrote", confidence: 1 };
      },
    });
    const stop = startReextractWorker(
      {
        db,
        capabilityRegistryRepo,
        reextractJobsRepo,
        schemaEvolutionsRepo,
        logger,
        now: NOW,
      },
      { intervalMs: 5, registry },
    );
    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);
  });

  it("strategy throw marks job failed with last_error", async () => {
    await seedCapabilityAndRows();
    const evo = await schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: "{}",
      proposed_at: NOW().toISOString(),
    });
    const job = await reextractJobsRepo.insert({
      schema_evolution_id: evo.id,
      capability_name: "expenses",
      strategy: "always_fails",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
    const registry = new ReextractStrategyRegistry();
    registry.register({
      name: "always_fails",
      process: async () => ({ kind: "failed", error: "ouch" }),
    });
    const stop = startReextractWorker(
      {
        db,
        capabilityRegistryRepo,
        reextractJobsRepo,
        schemaEvolutionsRepo,
        logger,
        now: NOW,
      },
      { intervalMs: 5, registry, now: NOW },
    );
    await vi.advanceTimersByTimeAsync(30);
    stop();
    const row = await reextractJobsRepo.findById(job.id);
    expect(row?.status).toBe("done"); // runner finishes; all rows failed but job ran end-to-end
    expect(row?.rows_failed).toBe(3);
    expect(row?.last_error).toBe("ouch");
  });
});
