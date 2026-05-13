import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../../core/logger.js";
import { openDatabase, type Database } from "../../db/connection.js";
import { applyMigrations } from "../../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../../db/index.js";
import {
  CapabilityRegistryRepository,
  ReextractJobsRepository,
  SchemaEvolutionsRepository,
} from "../../db/repositories/index.js";
import { deriveExistingStrategy } from "./derive_existing.js";
import type { ReextractRunDeps } from "../types.js";

const NOW = () => new Date("2026-05-13T00:00:00Z");

describe("deriveExistingStrategy", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let deps: ReextractRunDeps;
  let jobId: number;
  let evoId: number;

  async function seedJob(diff: object): Promise<void> {
    const evo = await deps.schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: JSON.stringify(diff),
      proposed_at: NOW().toISOString(),
    });
    evoId = evo.id;
    const r = await deps.reextractJobsRepo.insert({
      schema_evolution_id: evoId,
      capability_name: "expenses",
      strategy: "derive_existing",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
    jobId = r.id;
  }

  async function loadJob() {
    const row = await deps.reextractJobsRepo.findById(jobId);
    if (!row) throw new Error("job vanished");
    return row;
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-derive-"));
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
         amount_minor INTEGER NOT NULL,
         currency TEXT,
         category TEXT,
         main_category TEXT,
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
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("constant fill writes only NULL rows", async () => {
    db.prepare(
      "INSERT INTO expenses (amount_minor, currency, created_at) VALUES (?, NULL, ?)",
    ).run(100, NOW().toISOString());
    db.prepare(
      "INSERT INTO expenses (amount_minor, currency, created_at) VALUES (?, 'USD', ?)",
    ).run(200, NOW().toISOString());
    await seedJob({
      kind: "constant",
      target_column: "currency",
      value: "CNY",
    });
    const job = await loadJob();
    const allRows = db.prepare("SELECT * FROM expenses ORDER BY id").all() as Array<{ id: number }>;
    const o1 = await deriveExistingStrategy.process(allRows[0]!, job, deps);
    expect(o1.kind).toBe("wrote");
    const o2 = await deriveExistingStrategy.process(allRows[1]!, job, deps);
    expect(o2.kind).toBe("skipped");
    const after = db.prepare("SELECT currency FROM expenses ORDER BY id").all() as Array<{ currency: string }>;
    expect(after.map((r) => r.currency)).toEqual(["CNY", "USD"]);
  });

  it("copy mirrors source column", async () => {
    db.prepare(
      "INSERT INTO expenses (amount_minor, currency, category, created_at) VALUES (?, 'CNY', 'dining', ?)",
    ).run(100, NOW().toISOString());
    await seedJob({
      kind: "copy",
      target_column: "main_category",
      source_column: "category",
    });
    const job = await loadJob();
    const row = db.prepare("SELECT * FROM expenses").get() as { id: number };
    const o = await deriveExistingStrategy.process(row, job, deps);
    expect(o.kind).toBe("wrote");
    const after = db
      .prepare("SELECT main_category FROM expenses")
      .get() as { main_category: string };
    expect(after.main_category).toBe("dining");
  });

  it("invalid diff JSON fails", async () => {
    await seedJob({ kind: "invalid_kind", target_column: "x" });
    const job = await loadJob();
    const row = { id: 1, currency: null };
    const o = await deriveExistingStrategy.process(row, job, deps);
    expect(o.kind).toBe("failed");
    expect("error" in o ? o.error.toLowerCase() : "").toContain(
      "derive_existing shape",
    );
  });

  it("malformed diff JSON fails with parse error", async () => {
    // Raw insert: we want the column to literally hold non-JSON text. The
    // repo would have JSON.stringify'd a passed-in object.
    db.prepare(
      "INSERT INTO schema_evolutions (capability_name, from_version, to_version, change_type, diff, proposed_at) VALUES ('expenses', 1, 2, 'add_column', ?, ?)",
    ).run("this is not json{", NOW().toISOString());
    const evoRow = db
      .prepare("SELECT id FROM schema_evolutions ORDER BY id DESC LIMIT 1")
      .get() as { id: number };
    const job = await deps.reextractJobsRepo.insert({
      schema_evolution_id: evoRow.id,
      capability_name: "expenses",
      strategy: "derive_existing",
      status: "pending",
      rows_total: 0,
      rows_done: 0,
      rows_failed: 0,
      rows_low_confidence: 0,
    });
    const row = { id: 1, currency: null };
    const o = await deriveExistingStrategy.process(row, job, deps);
    expect(o.kind).toBe("failed");
    expect("error" in o ? o.error.toLowerCase() : "").toContain("json");
  });

  it("idempotent: running twice leaves data unchanged the second time", async () => {
    db.prepare(
      "INSERT INTO expenses (amount_minor, created_at) VALUES (?, ?)",
    ).run(100, NOW().toISOString());
    await seedJob({
      kind: "constant",
      target_column: "currency",
      value: "CNY",
    });
    const job = await loadJob();
    const row = db.prepare("SELECT * FROM expenses").get() as { id: number };
    const first = await deriveExistingStrategy.process(row, job, deps);
    expect(first.kind).toBe("wrote");
    const second = await deriveExistingStrategy.process(row, job, deps);
    expect(second.kind).toBe("skipped");
  });
});
