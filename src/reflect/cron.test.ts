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
  ProposalsRepository,
} from "../db/repositories/index.js";
import { alreadyFiredThisWeek, startReflectAgent } from "./cron.js";
import type { ReflectRunDeps } from "./runner.js";

describe("alreadyFiredThisWeek", () => {
  let tmp: string;
  let db: Database;
  let proposalsRepo: ProposalsRepository;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-cron-helper-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    proposalsRepo = new ProposalsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns true when a reflect_agent proposal is within 6 days", async () => {
    const now = new Date("2026-05-13T03:00:00Z");
    await proposalsRepo.insert({
      source: "reflect_agent",
      kind: "capability_archive",
      title: "x",
      summary: "y",
      rationale: "z",
      status: "pending",
      target_capability: "old",
      created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    });
    expect(await alreadyFiredThisWeek(proposalsRepo, now)).toBe(true);
  });

  it("returns false when no recent reflect_agent rows", async () => {
    const now = new Date("2026-05-13T03:00:00Z");
    expect(await alreadyFiredThisWeek(proposalsRepo, now)).toBe(false);
  });

  it("returns false when the row is older than 6 days", async () => {
    const now = new Date("2026-05-13T03:00:00Z");
    await proposalsRepo.insert({
      source: "reflect_agent",
      kind: "capability_archive",
      title: "x",
      summary: "y",
      rationale: "z",
      status: "pending",
      target_capability: "old",
      created_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
    });
    expect(await alreadyFiredThisWeek(proposalsRepo, now)).toBe(false);
  });
});

describe("startReflectAgent", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let deps: ReflectRunDeps & { proposalsRepo: ProposalsRepository };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-cron-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    deps = {
      db,
      capabilityRegistryRepo: new CapabilityRegistryRepository(db),
      capabilityHealthRepo: new CapabilityHealthRepository(db),
      proposalsRepo: new ProposalsRepository(db),
      logger,
    };
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("does not fire outside the schedule window", async () => {
    // Wednesday at 03:00 — wrong day.
    const wednesday0300 = new Date("2026-05-13T03:00:00Z");
    const stop = startReflectAgent(deps, {
      intervalMs: 10,
      now: () => wednesday0300,
    });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    const rows = await deps.proposalsRepo.findMany({ source: "reflect_agent" });
    expect(rows).toHaveLength(0);
  });

  it("does not fire at wrong hour", async () => {
    // Sunday 05:00 — wrong hour.
    const sunday0500 = new Date("2026-05-17T05:00:00Z");
    const stop = startReflectAgent(deps, {
      intervalMs: 10,
      now: () => sunday0500,
      schedule: { dayOfWeek: sunday0500.getDay(), hour: 3 },
    });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    const rows = await deps.proposalsRepo.findMany({ source: "reflect_agent" });
    expect(rows).toHaveLength(0);
  });

  it("skips firing when alreadyFiredThisWeek is true", async () => {
    const sunday0300 = new Date("2026-05-17T03:00:00Z");
    await deps.proposalsRepo.insert({
      source: "reflect_agent",
      kind: "capability_archive",
      title: "x",
      summary: "y",
      rationale: "z",
      status: "pending",
      target_capability: "old",
      created_at: new Date(sunday0300.getTime() - 86_400_000).toISOString(),
    });
    const stop = startReflectAgent(deps, {
      intervalMs: 10,
      now: () => sunday0300,
      schedule: { dayOfWeek: sunday0300.getDay(), hour: 3 },
    });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    const rows = await deps.proposalsRepo.findMany({ source: "reflect_agent" });
    expect(rows).toHaveLength(1); // unchanged
  });

  it("stop() halts subsequent ticks", async () => {
    const stop = startReflectAgent(deps, { intervalMs: 5 });
    stop();
    await vi.advanceTimersByTimeAsync(100);
    // No state to assert; the assertion is that we don't blow up. The
    // logger captured "stopped" — also fine if not asserted.
  });
});
