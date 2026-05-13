import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { runReextractJob } from "./runner.js";
import type {
  ReextractRunDeps,
  ReextractStrategy,
  StrategyOutcome,
} from "./types.js";
import type { ReextractJobRow } from "../db/repositories/reextract_jobs.js";

const NOW = () => new Date("2026-05-13T00:00:00Z");

describe("runReextractJob", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let deps: ReextractRunDeps;
  let registry: ReextractStrategyRegistry;

  async function seedCapability(): Promise<void> {
    db.exec(
      `CREATE TABLE expenses (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         amount_minor INTEGER NOT NULL,
         currency TEXT,
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
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO expenses (amount_minor, currency, created_at) VALUES (?, ?, ?)",
      ).run(100 + i, null, NOW().toISOString());
    }
  }

  async function seedJob(strategyName: string): Promise<ReextractJobRow> {
    const evo = await deps.schemaEvolutionsRepo.insert({
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
    return deps.reextractJobsRepo.insert({
      schema_evolution_id: evo.id,
      capability_name: "expenses",
      strategy: strategyName,
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-reextract-runner-"));
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
      checkpointEveryRows: 2,
    };
    registry = new ReextractStrategyRegistry();
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("unknown strategy aborts without scanning rows", async () => {
    await seedCapability();
    const job = await seedJob("nonexistent");
    const outcome = await runReextractJob(job, deps, registry);
    expect(outcome.status).toBe("failed");
    expect(outcome.last_error).toContain("unknown_strategy");
    expect(outcome.rows_done).toBe(0);
    expect(outcome.rows_failed).toBe(0);
  });

  it("missing capability aborts gracefully", async () => {
    // schema_evolutions.capability_name has an FK to capability_registry, so
    // seed expenses first; the JOB uses a *different* capability_name that
    // is not in the registry — runner's capabilityRegistryRepo.findById will
    // return null and abort.
    await seedCapability();
    const evo = await deps.schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: "{}",
      proposed_at: NOW().toISOString(),
    });
    const job = await deps.reextractJobsRepo.insert({
      schema_evolution_id: evo.id,
      capability_name: "ghost",
      strategy: "any",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
    registry.register({
      name: "any",
      process: async () => ({ kind: "wrote", confidence: 1 }),
    });
    const outcome = await runReextractJob(job, deps, registry);
    expect(outcome.status).toBe("failed");
    expect(outcome.last_error).toContain("capability_not_found");
  });

  it("mixed outcomes update the right counters", async () => {
    await seedCapability();
    const job = await seedJob("mixed");
    let i = 0;
    const outcomes: StrategyOutcome[] = [
      { kind: "wrote", confidence: 1 },
      { kind: "low_confidence", confidence: 0.5 },
      { kind: "failed", error: "boom" },
      { kind: "skipped", reason: "noop" },
      { kind: "wrote", confidence: 1 },
    ];
    const strategy: ReextractStrategy = {
      name: "mixed",
      process: async () => outcomes[i++]!,
    };
    registry.register(strategy);
    const outcome = await runReextractJob(job, deps, registry);
    expect(outcome.status).toBe("done");
    expect(outcome.rows_done).toBe(2);
    expect(outcome.rows_low_confidence).toBe(1);
    expect(outcome.rows_failed).toBe(1);
    expect(outcome.last_error).toBe("boom");
  });

  it("per-row thrown error counts as failed and continues", async () => {
    await seedCapability();
    const job = await seedJob("throws");
    let i = 0;
    registry.register({
      name: "throws",
      process: async () => {
        i++;
        if (i === 2) throw new Error("kaboom");
        return { kind: "wrote", confidence: 1 };
      },
    });
    const outcome = await runReextractJob(job, deps, registry);
    expect(outcome.rows_done).toBe(4);
    expect(outcome.rows_failed).toBe(1);
    expect(outcome.last_error).toContain("kaboom");
  });

  it("accumulates costCents from wrote/low_confidence outcomes", async () => {
    await seedCapability();
    const job = await seedJob("paid");
    let i = 0;
    registry.register({
      name: "paid",
      process: async () => {
        i++;
        return { kind: "wrote", confidence: 1, costCents: i * 10 };
      },
    });
    const outcome = await runReextractJob(job, deps, registry);
    expect(outcome.cost_cents).toBe(10 + 20 + 30 + 40 + 50);
  });

  it("checkpoint stamps last_checkpoint_at every checkpointEveryRows", async () => {
    await seedCapability();
    const job = await seedJob("noop");
    registry.register({
      name: "noop",
      process: async () => ({ kind: "wrote", confidence: 1 }),
    });
    await runReextractJob(job, deps, registry);
    const row = await deps.reextractJobsRepo.findById(job.id);
    // checkpointEveryRows=2 in this suite; we process 5 rows so at least one checkpoint
    expect(row?.last_checkpoint_at).toBe(NOW().toISOString());
  });
});
