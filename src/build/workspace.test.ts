import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityRegistry, LoadedCapability } from "../capabilities/types.js";
import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  CapabilityRegistryRepository,
  ProposalsRepository,
} from "../db/repositories/index.js";
import {
  cleanupBuildWorkspace,
  renderUserContext,
  setupBuildWorkspace,
} from "./workspace.js";

function makeLoadedCapability(
  capRoot: string,
  name: string,
  opts: { withMigrations?: boolean } = {},
): LoadedCapability {
  const dir = path.join(capRoot, name, "v1");
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
  if (opts.withMigrations) {
    mkdirSync(path.join(dir, "migrations"), { recursive: true });
    writeFileSync(
      path.join(dir, "migrations", "001_init.sql"),
      `CREATE TABLE ${name} (id INTEGER PRIMARY KEY);`,
    );
  }
  return {
    meta: {
      name,
      version: 1,
      description: name,
      primary_table: name,
      depends_on_capabilities: [],
      ingest_event_types: [],
      owner_pipeline: "pipeline.ts",
      exposed_skills: [],
    },
    path: dir,
    metaPath: path.join(dir, "meta.json"),
  };
}

describe("renderUserContext", () => {
  let tmp: string;
  let db: Database;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let proposalsRepo: ProposalsRepository;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-ws-render-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    proposalsRepo = new ProposalsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("emits the timestamp + (none) placeholders when registry and proposals are empty", async () => {
    const md = await renderUserContext({
      capabilityRegistryRepo,
      proposalsRepo,
      buildContext: {
        requestedTitle: "Track weight",
        requestedSummary: "Track body weight over time.",
      },
      now: () => new Date("2026-05-13T10:00:00Z"),
    });
    expect(md).toContain("# Strata user context (build triggered 2026-05-13T10:00:00.000Z)");
    expect(md).toContain("(none yet)");
    expect(md).toContain("(none)");
    expect(md).toContain("Track weight");
    expect(md).toContain("Track body weight over time.");
  });

  it("lists active capabilities as a table", async () => {
    await capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x/meta.json",
      primary_table: "expenses",
      created_at: new Date().toISOString(),
    });
    const md = await renderUserContext({
      capabilityRegistryRepo,
      proposalsRepo,
      buildContext: {
        requestedTitle: "Track sleep",
        requestedSummary: "x",
      },
    });
    expect(md).toContain("| expenses | 1 | expenses |");
  });

  it("lists pending proposals", async () => {
    await proposalsRepo.insert({
      source: "user_request",
      kind: "new_capability",
      title: "Track weight",
      summary: "x",
      rationale: "y",
      status: "pending",
      created_at: new Date().toISOString(),
    });
    const md = await renderUserContext({
      capabilityRegistryRepo,
      proposalsRepo,
      buildContext: {
        requestedTitle: "Track sleep",
        requestedSummary: "x",
      },
    });
    expect(md).toMatch(/^- #\d+ \(user_request \/ new_capability\): Track weight$/m);
  });

  it("includes rationale when supplied", async () => {
    const md = await renderUserContext({
      capabilityRegistryRepo,
      proposalsRepo,
      buildContext: {
        requestedTitle: "Track sleep",
        requestedSummary: "x",
        rationale: "user wants insights",
      },
    });
    expect(md).toContain("user wants insights");
  });
});

describe("setupBuildWorkspace", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let proposalsRepo: ProposalsRepository;
  let buildsDir: string;
  let capRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-ws-setup-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);
    proposalsRepo = new ProposalsRepository(db);
    buildsDir = path.join(tmp, "builds");
    capRoot = path.join(tmp, "caps");
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path: produces all 4 artefacts + git init + capability snapshot", async () => {
    const expenses = makeLoadedCapability(capRoot, "expenses", { withMigrations: true });
    const capabilities: CapabilityRegistry = new Map([["expenses", expenses]]);

    const handle = await setupBuildWorkspace({
      sessionId: "s1",
      planContents: "# Plan\nDo a thing.",
      buildContext: {
        requestedTitle: "Track weight",
        requestedSummary: "Track body weight over time.",
      },
      agentsMdSource: "# Constitution\n\nObey the rules.",
      buildsDir,
      capabilities,
      proposalsRepo,
      capabilityRegistryRepo,
      logger,
      now: () => new Date("2026-05-13T10:00:00Z"),
    });

    expect(handle.workdir).toBe(
      path.join(buildsDir, "s1-2026-05-13T10-00-00-000Z"),
    );
    expect(existsSync(handle.agentsMdPath)).toBe(true);
    expect(await readFile(handle.agentsMdPath, "utf8")).toContain("# Constitution");
    expect(await readFile(handle.planMdPath, "utf8")).toBe("# Plan\nDo a thing.");
    const ctx = await readFile(handle.userContextMdPath, "utf8");
    expect(ctx).toContain("Track weight");

    // existing_capabilities/ snapshot
    const expMeta = path.join(handle.existingCapabilitiesDir, "expenses", "meta.json");
    expect(existsSync(expMeta)).toBe(true);
    const expMig = path.join(
      handle.existingCapabilitiesDir,
      "expenses",
      "migrations",
      "001_init.sql",
    );
    expect(existsSync(expMig)).toBe(true);

    // git init + commit
    expect(existsSync(path.join(handle.workdir, ".git"))).toBe(true);
    const headSha = execFileSync("git", ["-C", handle.workdir, "rev-parse", "HEAD"])
      .toString()
      .trim();
    expect(handle.gitInitialCommit).toBe(headSha);
  });

  it("handles a capability without a migrations dir", async () => {
    const moods = makeLoadedCapability(capRoot, "moods", { withMigrations: false });
    const capabilities: CapabilityRegistry = new Map([["moods", moods]]);

    const handle = await setupBuildWorkspace({
      sessionId: "s2",
      planContents: "# Plan",
      buildContext: { requestedTitle: "x", requestedSummary: "y" },
      agentsMdSource: "# C",
      buildsDir,
      capabilities,
      proposalsRepo,
      capabilityRegistryRepo,
      logger,
      now: () => new Date("2026-05-13T11:00:00Z"),
    });
    const meta = path.join(handle.existingCapabilitiesDir, "moods", "meta.json");
    expect(existsSync(meta)).toBe(true);
    const mig = path.join(handle.existingCapabilitiesDir, "moods", "migrations");
    expect(existsSync(mig)).toBe(false);
  });

  it("two calls with advancing now() produce distinct workdirs", async () => {
    let t = 0;
    const tick = () => new Date(`2026-05-13T12:00:00.00${t++}Z`);
    const opts = {
      sessionId: "s3",
      planContents: "# Plan",
      buildContext: { requestedTitle: "x", requestedSummary: "y" },
      agentsMdSource: "# C",
      buildsDir,
      capabilities: new Map() as CapabilityRegistry,
      proposalsRepo,
      capabilityRegistryRepo,
      logger,
      now: tick,
    };
    const a = await setupBuildWorkspace(opts);
    const b = await setupBuildWorkspace(opts);
    expect(a.workdir).not.toBe(b.workdir);
  });

  it("renders USER_CONTEXT.md from the live registry + proposals", async () => {
    await capabilityRegistryRepo.insert({
      name: "expenses",
      version: 1,
      status: "active",
      meta_path: "/x/meta.json",
      primary_table: "expenses",
      created_at: new Date().toISOString(),
    });
    await proposalsRepo.insert({
      source: "user_request",
      kind: "new_capability",
      title: "Track dreams",
      summary: "x",
      rationale: "y",
      status: "pending",
      created_at: new Date().toISOString(),
    });
    const handle = await setupBuildWorkspace({
      sessionId: "s4",
      planContents: "# Plan",
      buildContext: {
        requestedTitle: "Track weight",
        requestedSummary: "x",
      },
      agentsMdSource: "# C",
      buildsDir,
      capabilities: new Map(),
      proposalsRepo,
      capabilityRegistryRepo,
      logger,
      now: () => new Date("2026-05-13T13:00:00Z"),
    });
    const ctx = await readFile(handle.userContextMdPath, "utf8");
    expect(ctx).toContain("expenses");
    expect(ctx).toContain("Track dreams");
    expect(ctx).toContain("Track weight");
  });
});

describe("cleanupBuildWorkspace", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-ws-clean-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("removes the workdir", async () => {
    const handle = await setupBuildWorkspace({
      sessionId: "s",
      planContents: "# Plan",
      buildContext: { requestedTitle: "x", requestedSummary: "y" },
      agentsMdSource: "# C",
      buildsDir: path.join(tmp, "builds"),
      capabilities: new Map(),
      proposalsRepo: new ProposalsRepository(db),
      capabilityRegistryRepo: new CapabilityRegistryRepository(db),
      logger,
    });
    expect(existsSync(handle.workdir)).toBe(true);
    await cleanupBuildWorkspace(handle);
    expect(existsSync(handle.workdir)).toBe(false);
  });

  it("is idempotent on an already-removed workdir", async () => {
    const handle = await setupBuildWorkspace({
      sessionId: "s",
      planContents: "# Plan",
      buildContext: { requestedTitle: "x", requestedSummary: "y" },
      agentsMdSource: "# C",
      buildsDir: path.join(tmp, "builds"),
      capabilities: new Map(),
      proposalsRepo: new ProposalsRepository(db),
      capabilityRegistryRepo: new CapabilityRegistryRepository(db),
      logger,
    });
    await cleanupBuildWorkspace(handle);
    await expect(cleanupBuildWorkspace(handle)).resolves.toBeUndefined();
  });
});
