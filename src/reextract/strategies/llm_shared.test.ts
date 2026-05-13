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
  ReextractJobsRepository,
  SchemaEvolutionsRepository,
} from "../../db/repositories/index.js";
import { renderLlmPrompt, runLlmReextract } from "./llm_shared.js";
import type { LLMClient } from "../../triage/index.js";
import type { ReextractRunDeps } from "../types.js";
import type { ReextractJobRow } from "../../db/repositories/reextract_jobs.js";

const NOW = () => new Date("2026-05-13T00:00:00Z");

describe("renderLlmPrompt", () => {
  it("substitutes {{context}} once", () => {
    expect(renderLlmPrompt("Look at {{context}} and answer.", "X")).toBe(
      "Look at X and answer.",
    );
  });

  it("substitutes multiple occurrences", () => {
    expect(renderLlmPrompt("A {{context}} B {{ context }}", "Y")).toBe(
      "A Y B Y",
    );
  });
});

describe("runLlmReextract", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let deps: ReextractRunDeps;
  let job: ReextractJobRow;

  async function seed(diff: object, llm: LLMClient | undefined): Promise<void> {
    db.exec(
      `CREATE TABLE expenses (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         amount_minor INTEGER NOT NULL,
         subcategory TEXT,
         created_at TEXT NOT NULL
       )`,
    );
    db.prepare(
      "INSERT INTO expenses (amount_minor, created_at) VALUES (?, ?)",
    ).run(100, NOW().toISOString());
    await deps.capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: "expenses",
      created_at: NOW().toISOString(),
    });
    const evo = await deps.schemaEvolutionsRepo.insert({
      capability_name: "expenses",
      from_version: 1,
      to_version: 2,
      change_type: "add_column",
      diff: JSON.stringify(diff),
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
    if (llm) deps.llmClient = llm;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-llm-shared-"));
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

  it("missing llmClient → failed", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      undefined,
    );
    const row = { id: 1 };
    const out = await runLlmReextract(row, job, deps, "context");
    expect(out.kind).toBe("failed");
  });

  it("malformed diff → failed", async () => {
    await seed({ kind: "weird", value: "x" }, { infer: async () => "" });
    const row = { id: 1 };
    const out = await runLlmReextract(row, job, deps, "ctx");
    expect(out.kind).toBe("failed");
    expect("error" in out ? out.error.toLowerCase() : "").toContain(
      "llm_field shape",
    );
  });

  it("already-set target → skipped without LLM call", async () => {
    const infer = vi.fn(async () => '{"value":"x","confidence":0.9}');
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      { infer },
    );
    db.prepare("UPDATE expenses SET subcategory = 'preset' WHERE id = 1").run();
    const out = await runLlmReextract({ id: 1 }, job, deps, "ctx");
    expect(out.kind).toBe("skipped");
    expect(infer).not.toHaveBeenCalled();
  });

  it("high confidence → wrote + UPDATE happened", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      { infer: async () => '{"value":"coffee","confidence":0.9}' },
    );
    const out = await runLlmReextract({ id: 1 }, job, deps, "Blue Bottle");
    expect(out.kind).toBe("wrote");
    const row = db
      .prepare("SELECT subcategory FROM expenses WHERE id = 1")
      .get() as { subcategory: string };
    expect(row.subcategory).toBe("coffee");
  });

  it("mid confidence → low_confidence + UPDATE still happens", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      { infer: async () => '{"value":"coffee","confidence":0.5}' },
    );
    const out = await runLlmReextract({ id: 1 }, job, deps, "context");
    expect(out.kind).toBe("low_confidence");
    const row = db
      .prepare("SELECT subcategory FROM expenses WHERE id = 1")
      .get() as { subcategory: string };
    expect(row.subcategory).toBe("coffee");
  });

  it("very low confidence → failed + NO UPDATE", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      { infer: async () => '{"value":"coffee","confidence":0.2}' },
    );
    const out = await runLlmReextract({ id: 1 }, job, deps, "context");
    expect(out.kind).toBe("failed");
    const row = db
      .prepare("SELECT subcategory FROM expenses WHERE id = 1")
      .get() as { subcategory: string | null };
    expect(row.subcategory).toBeNull();
  });

  it("non-JSON LLM response → failed", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      { infer: async () => "I think it's coffee" },
    );
    const out = await runLlmReextract({ id: 1 }, job, deps, "context");
    expect(out.kind).toBe("failed");
    expect("error" in out ? out.error : "").toContain("JSON");
  });

  it("LLM throws → failed", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
      },
      {
        infer: async () => {
          throw new Error("rate_limited");
        },
      },
    );
    const out = await runLlmReextract({ id: 1 }, job, deps, "context");
    expect(out.kind).toBe("failed");
    expect("error" in out ? out.error : "").toContain("rate_limited");
  });

  it("respects custom confidence_threshold", async () => {
    await seed(
      {
        kind: "llm_field",
        target_column: "subcategory",
        extract_prompt: "Decide: {{context}}",
        confidence_threshold: 0.5,
      },
      { infer: async () => '{"value":"coffee","confidence":0.6}' },
    );
    const out = await runLlmReextract({ id: 1 }, job, deps, "context");
    // 0.6 >= threshold 0.5 → wrote (not low_confidence).
    expect(out.kind).toBe("wrote");
  });
});
