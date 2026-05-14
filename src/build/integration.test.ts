import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  BuildsRepository,
  CapabilityHealthRepository,
  CapabilityRegistryRepository,
  ProposalsRepository,
  SchemaEvolutionsRepository,
} from "../db/repositories/index.js";
import { runIntegration, type IntegrationDeps } from "./integration.js";
import type { BuildRunResult } from "./orchestrator.js";

const META = (name: string) =>
  JSON.stringify({
    name,
    version: 1,
    description: name,
    primary_table: name,
  });

const MIGRATION = (name: string) =>
  `CREATE TABLE ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, raw_event_id INTEGER NOT NULL REFERENCES raw_events(id), extraction_version INTEGER NOT NULL DEFAULT 1, extraction_confidence REAL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`;

const PIPELINE = `export async function ingest(rawEvent, deps) {
  return { business_row_id: 1, business_table: "x" };
}`;

function seedCapabilityInWorkdir(
  workdir: string,
  name: string,
  version = 1,
): void {
  const dir = path.join(workdir, "capabilities", name, `v${version}`);
  mkdirSync(path.join(dir, "migrations"), { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), META(name));
  writeFileSync(path.join(dir, "migrations", "001_init.sql"), MIGRATION(name));
  writeFileSync(path.join(dir, "pipeline.ts"), PIPELINE);
}

describe("runIntegration", () => {
  let tmp: string;
  let workdir: string;
  let userDir: string;
  let db: Database;
  let logger: Logger;
  let deps: IntegrationDeps;
  let proposalId: number;
  let buildId: number;
  let buildResult: BuildRunResult & { status: "ready_for_integration" };

  async function makeBuildResult(): Promise<typeof buildResult> {
    return {
      status: "ready_for_integration",
      build_id: buildId,
      workdir,
      plan: "# Plan",
      changeIds: ["add-weight"],
      validationReports: {},
    };
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-integ-"));
    workdir = path.join(tmp, "workdir");
    userDir = path.join(tmp, "user-caps");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    deps = {
      buildsRepo: new BuildsRepository(db),
      proposalsRepo: new ProposalsRepository(db),
      capabilityRegistryRepo: new CapabilityRegistryRepository(db),
      capabilityHealthRepo: new CapabilityHealthRepository(db),
      schemaEvolutionsRepo: new SchemaEvolutionsRepository(db),
      db,
      userCapabilitiesDir: userDir,
      logger,
    };
    const p = await deps.proposalsRepo.insert({
      source: "user_request",
      kind: "new_capability",
      title: "Track weight",
      summary: "x",
      rationale: "y",
      status: "pending",
      created_at: new Date().toISOString(),
    });
    proposalId = p.id;
    const b = await deps.buildsRepo.insert({
      session_id: "s",
      trigger_kind: "user_request",
      trigger_proposal_id: proposalId,
      target_capability: "weight",
      target_action: "create",
      phase: "integrate",
      changes_done: 1,
      created_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    });
    buildId = b.id;
    buildResult = await makeBuildResult();
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path (single capability): moves files + writes DB rows + flips proposal/build", async () => {
    seedCapabilityInWorkdir(workdir, "weight");
    const result = await runIntegration({ buildResult, deps });
    expect(result.status).toBe("integrated");
    if (result.status !== "integrated") throw new Error("expected integrated");
    expect(result.integrated).toHaveLength(1);
    expect(result.integrated[0]?.name).toBe("weight");
    expect(result.integrated[0]?.version).toBe(1);

    // Files moved
    expect(existsSync(path.join(userDir, "weight", "v1", "meta.json"))).toBe(true);
    expect(
      existsSync(path.join(userDir, "weight", "v1", "migrations", "001_init.sql")),
    ).toBe(true);
    expect(existsSync(path.join(userDir, "weight", "v1", "pipeline.ts"))).toBe(true);

    // DB rows
    const regRow = await deps.capabilityRegistryRepo.findById("weight");
    expect(regRow?.status).toBe("active");
    expect(regRow?.version).toBe(1);
    expect(regRow?.primary_table).toBe("weight");
    const healthRow = await deps.capabilityHealthRepo.findById("weight");
    expect(healthRow?.total_writes).toBe(0);
    expect(healthRow?.total_reads).toBe(0);
    const evoRows = await deps.schemaEvolutionsRepo.findMany({
      capability_name: "weight",
    });
    expect(evoRows).toHaveLength(1);
    expect(evoRows[0]?.change_type).toBe("capability_create");
    expect(evoRows[0]?.from_version).toBe(0);
    expect(evoRows[0]?.to_version).toBe(1);

    // Proposal + build flipped
    const propRow = await deps.proposalsRepo.findById(proposalId);
    expect(propRow?.status).toBe("applied");
    expect(propRow?.resulting_build_id).toBe(buildId);
    const buildRow = await deps.buildsRepo.findById(buildId);
    expect(buildRow?.phase).toBe("done");
    expect(buildRow?.completed_at).toBeTruthy();
  });

  it("multi-capability happy path", async () => {
    seedCapabilityInWorkdir(workdir, "weight");
    seedCapabilityInWorkdir(workdir, "moods");
    const result = await runIntegration({ buildResult, deps });
    expect(result.status).toBe("integrated");
    if (result.status !== "integrated") throw new Error("expected integrated");
    expect(result.integrated.map((c) => c.name).sort()).toEqual(["moods", "weight"]);
    expect(await deps.capabilityRegistryRepo.findById("moods")).not.toBeNull();
    expect(await deps.capabilityRegistryRepo.findById("weight")).not.toBeNull();
  });

  it("version_conflict: user dir already has v1, fails that capability", async () => {
    seedCapabilityInWorkdir(workdir, "weight");
    // Pre-populate destDir.
    mkdirSync(path.join(userDir, "weight", "v1"), { recursive: true });
    writeFileSync(
      path.join(userDir, "weight", "v1", "meta.json"),
      META("weight"),
    );

    const result = await runIntegration({ buildResult, deps });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failureReason).toContain("version_conflict");
    // Proposal stays pending
    const propRow = await deps.proposalsRepo.findById(proposalId);
    expect(propRow?.status).toBe("pending");
    const buildRow = await deps.buildsRepo.findById(buildId);
    expect(buildRow?.phase).toBe("failed");
  });

  it("DB failure during integration rolls back the FS copy", async () => {
    seedCapabilityInWorkdir(workdir, "weight");
    // Stub the registry insert to throw.
    const spy = vi
      .spyOn(deps.capabilityRegistryRepo, "insert")
      .mockRejectedValueOnce(new Error("synthetic db fail"));
    const result = await runIntegration({ buildResult, deps });
    spy.mockRestore();
    expect(result.status).toBe("failed");
    // FS rollback
    expect(existsSync(path.join(userDir, "weight", "v1"))).toBe(false);
  });

  it("partial success: first integrates, second fails with version_conflict; first stays", async () => {
    seedCapabilityInWorkdir(workdir, "moods"); // will be tried alphabetically first
    seedCapabilityInWorkdir(workdir, "weight");
    // Pre-populate the weight v1 to force conflict on the second.
    mkdirSync(path.join(userDir, "weight", "v1"), { recursive: true });
    writeFileSync(path.join(userDir, "weight", "v1", "meta.json"), META("weight"));

    const result = await runIntegration({ buildResult, deps });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    // moods integrated cleanly; weight failed.
    expect(result.integrated.map((c) => c.name)).toEqual(["moods"]);
    expect(await deps.capabilityRegistryRepo.findById("moods")).not.toBeNull();
    // Proposal stays pending (build-wide failure).
    const propRow = await deps.proposalsRepo.findById(proposalId);
    expect(propRow?.status).toBe("pending");
  });

  it("no_capabilities_in_workdir when nothing was produced", async () => {
    // workdir has no capabilities/ dir.
    const result = await runIntegration({ buildResult, deps });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failureReason).toBe("no_capabilities_in_workdir");
  });

  it("throws when buildResult.status is not ready_for_integration", async () => {
    const bad = { ...buildResult, status: "failed" } as unknown as typeof buildResult;
    await expect(runIntegration({ buildResult: bad, deps })).rejects.toThrow(
      /not ready/,
    );
  });
});
