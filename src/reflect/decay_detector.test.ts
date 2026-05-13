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
  CapabilityHealthRepository,
  CapabilityRegistryRepository,
} from "../db/repositories/index.js";
import {
  detectArchiveCandidates,
  type DecayDeps,
} from "./decay_detector.js";

describe("detectArchiveCandidates", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let registryRepo: CapabilityRegistryRepository;
  let healthRepo: CapabilityHealthRepository;
  let deps: DecayDeps;

  async function seedCapability(
    name: string,
    health: { last_write_at?: string | null; last_read_at?: string | null } | null,
  ): Promise<void> {
    await registryRepo.insert({
      name,
      version: 1,
      status: "active",
      meta_path: "/x",
      primary_table: name,
      created_at: new Date().toISOString(),
    });
    if (health) {
      await healthRepo.insert({
        capability_name: name,
        total_writes: 1,
        total_reads: 0,
        total_corrections: 0,
        last_write_at: health.last_write_at ?? null,
        last_read_at: health.last_read_at ?? null,
        updated_at: new Date().toISOString(),
      });
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-decay-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    registryRepo = new CapabilityRegistryRepository(db);
    healthRepo = new CapabilityHealthRepository(db);
    deps = { capabilityRegistryRepo: registryRepo, capabilityHealthRepo: healthRepo, logger };
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("emits a signal when both timestamps exceed thresholds", async () => {
    const now = new Date("2026-05-13T00:00:00Z");
    await seedCapability("stale_cap", {
      last_write_at: new Date(now.getTime() - 120 * 86_400_000).toISOString(),
      last_read_at: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
    });
    const signals = await detectArchiveCandidates(deps, { now: () => now });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.target_capability).toBe("stale_cap");
    expect(signals[0]?.days_since_last_write).toBeCloseTo(120);
    expect(signals[0]?.days_since_last_read).toBeCloseTo(60);
    expect(signals[0]?.signal_strength).toBeCloseTo(120 / 180);
  });

  it("emits no signal when last_write_at is recent", async () => {
    const now = new Date("2026-05-13T00:00:00Z");
    await seedCapability("active_cap", {
      last_write_at: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
      last_read_at: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
    });
    const signals = await detectArchiveCandidates(deps, { now: () => now });
    expect(signals).toHaveLength(0);
  });

  it("emits a signal when capability_health is missing entirely (infinite age)", async () => {
    const now = new Date("2026-05-13T00:00:00Z");
    await seedCapability("orphaned", null);
    const signals = await detectArchiveCandidates(deps, { now: () => now });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.target_capability).toBe("orphaned");
    expect(Number.isFinite(signals[0]?.days_since_last_write ?? 0)).toBe(false);
  });

  it("does not emit a signal when only one threshold is exceeded", async () => {
    const now = new Date("2026-05-13T00:00:00Z");
    await seedCapability("half_stale", {
      last_write_at: new Date(now.getTime() - 120 * 86_400_000).toISOString(),
      last_read_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    });
    const signals = await detectArchiveCandidates(deps, { now: () => now });
    expect(signals).toHaveLength(0);
  });

  it("respects custom thresholds", async () => {
    const now = new Date("2026-05-13T00:00:00Z");
    await seedCapability("borderline", {
      last_write_at: new Date(now.getTime() - 40 * 86_400_000).toISOString(),
      last_read_at: new Date(now.getTime() - 40 * 86_400_000).toISOString(),
    });
    const signals = await detectArchiveCandidates(deps, {
      now: () => now,
      thresholds: { decay: { days_since_last_write: 30, days_since_last_read: 30 } },
    });
    expect(signals).toHaveLength(1);
  });
});
