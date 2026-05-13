import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import { loadCapabilities, type LoadCapabilitiesDeps } from "./loader.js";

function seedCapability(
  root: string,
  name: string,
  version: number,
  opts: { metaOverride?: string; addInitSql?: boolean } = {},
): string {
  const dir = path.join(root, name, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const meta =
    opts.metaOverride ??
    JSON.stringify({
      name,
      version,
      description: `${name} capability`,
      primary_table: name,
    });
  writeFileSync(path.join(dir, "meta.json"), meta);
  if (opts.addInitSql !== false) {
    mkdirSync(path.join(dir, "migrations"), { recursive: true });
    writeFileSync(
      path.join(dir, "migrations", "001_init.sql"),
      `CREATE TABLE ${name} (id INTEGER PRIMARY KEY);`,
    );
  }
  return dir;
}

describe("loadCapabilities", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let repo: CapabilityRegistryRepository;
  let bundledRoot: string;
  let userRoot: string;

  function depsFor(extras: Partial<LoadCapabilitiesDeps> = {}): LoadCapabilitiesDeps {
    return {
      db,
      repo,
      logger,
      bundledRoot,
      userRoot,
      ...extras,
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-cap-load-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    repo = new CapabilityRegistryRepository(db);
    bundledRoot = path.join(tmp, "bundled");
    userRoot = path.join(tmp, "user");
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns an empty registry when no capabilities are on disk", async () => {
    const reg = await loadCapabilities(depsFor());
    expect(reg.size).toBe(0);
  });

  it("happy path: registers a capability, applies its migration, returns a LoadedCapability", async () => {
    seedCapability(userRoot, "expenses", 1);
    const reg = await loadCapabilities(depsFor());
    expect(reg.size).toBe(1);
    const loaded = reg.get("expenses");
    expect(loaded?.meta.name).toBe("expenses");
    expect(loaded?.meta.version).toBe(1);
    expect(loaded?.meta.primary_table).toBe("expenses");
    // Defaults populated.
    expect(loaded?.meta.depends_on_capabilities).toEqual([]);
    expect(loaded?.meta.owner_pipeline).toBe("pipeline.ts");
    // Migration applied.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'",
      )
      .all();
    expect(tables).toHaveLength(1);
    // Registry row.
    const row = await repo.findById("expenses");
    expect(row?.status).toBe("active");
    expect(row?.version).toBe(1);
    expect(row?.primary_table).toBe("expenses");
  });

  it("idempotent re-boot: created_at is unchanged on second call", async () => {
    seedCapability(userRoot, "expenses", 1);
    await loadCapabilities(depsFor());
    const firstRow = await repo.findById("expenses");
    const firstCreatedAt = firstRow!.created_at;
    await new Promise((r) => setTimeout(r, 10));
    await loadCapabilities(depsFor());
    const secondRow = await repo.findById("expenses");
    expect(secondRow!.created_at).toBe(firstCreatedAt);
    expect(secondRow!.status).toBe("active");
  });

  it("malformed meta.json (missing primary_table) aborts boot", async () => {
    seedCapability(userRoot, "expenses", 1, {
      metaOverride: JSON.stringify({
        name: "expenses",
        version: 1,
        description: "x",
      }),
    });
    await expect(loadCapabilities(depsFor())).rejects.toThrow(
      /primary_table/,
    );
  });

  it("mismatched meta.name vs directory aborts boot", async () => {
    seedCapability(userRoot, "expenses", 1, {
      metaOverride: JSON.stringify({
        name: "moods",
        version: 1,
        description: "x",
        primary_table: "moods",
      }),
    });
    await expect(loadCapabilities(depsFor())).rejects.toThrow(
      /must match/,
    );
  });

  it("user root shadows bundled root", async () => {
    seedCapability(bundledRoot, "expenses", 1);
    seedCapability(userRoot, "expenses", 2);
    const reg = await loadCapabilities(depsFor());
    expect(reg.get("expenses")?.meta.version).toBe(2);
    expect(reg.get("expenses")?.metaPath.startsWith(userRoot)).toBe(true);
    const row = await repo.findById("expenses");
    expect(row?.version).toBe(2);
    expect(row?.meta_path.startsWith(userRoot)).toBe(true);
  });

  it("loads multiple capabilities in one boot", async () => {
    seedCapability(userRoot, "expenses", 1);
    seedCapability(userRoot, "moods", 1);
    const reg = await loadCapabilities(depsFor());
    expect([...reg.keys()].sort()).toEqual(["expenses", "moods"]);
  });
});
