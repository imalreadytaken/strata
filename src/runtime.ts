/**
 * Strata runtime bootstrap.
 *
 * The plugin's `register(api)` calls `bootRuntime(api)` exactly once. That
 * call:
 *   1. Reads `~/.strata/config.json` (defaults if missing) via `loadConfig`
 *   2. Opens (and creates) the SQLite database at `config.database.path`
 *   3. Applies the eight system migrations idempotently
 *   4. Instantiates a Strata logger writing to `config.paths.logsDir/plugin.log`
 *   5. Instantiates every system-table repository against the shared `db`
 *
 * Subsequent `bootRuntime` calls return the same memoised value. Tests use
 * `resetRuntimeForTests()` to clear the cache between cases.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import {
  loadCapabilities,
  type CapabilityRegistry,
} from "./capabilities/index.js";
import { loadConfig, type StrataConfig } from "./core/config.js";
import { createLogger, type Logger } from "./core/logger.js";
import { DashboardRegistry } from "./dashboard/registry.js";
import type DatabaseType from "better-sqlite3";

import {
  applyMigrations,
  openDatabase,
  SYSTEM_MIGRATIONS_DIR,
} from "./db/index.js";
import {
  BuildsRepository,
  CapabilityHealthRepository,
  CapabilityRegistryRepository,
  MessagesRepository,
  ProposalsRepository,
  RawEventsRepository,
  ReextractJobsRepository,
  SchemaEvolutionsRepository,
} from "./db/repositories/index.js";
import { resolveLLMClient } from "./llm/pi_ai_client.js";
import { PendingBuffer } from "./pending_buffer/index.js";
import type { LLMClient } from "./triage/index.js";

const BUNDLED_CAPABILITIES_ROOT = fileURLToPath(
  new URL("./capabilities/", import.meta.url),
);
const AGENTS_MD_PATH = fileURLToPath(
  new URL("../openspec/AGENTS.md", import.meta.url),
);

function loadAgentsMdSource(): string {
  try {
    return readFileSync(AGENTS_MD_PATH, "utf8");
  } catch {
    // Tests + ad-hoc dev contexts may run from a tree where the file is
    // elsewhere. Returning a placeholder keeps boot non-fatal; Build Bridge
    // can still spawn but Claude Code will lack constitution context.
    return "# AGENTS.md (placeholder — constitution not loaded)\n";
  }
}

export interface StrataRuntime {
  config: Readonly<StrataConfig>;
  db: DatabaseType.Database;
  logger: Logger;
  messagesRepo: MessagesRepository;
  rawEventsRepo: RawEventsRepository;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  schemaEvolutionsRepo: SchemaEvolutionsRepository;
  reextractJobsRepo: ReextractJobsRepository;
  buildsRepo: BuildsRepository;
  proposalsRepo: ProposalsRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  pendingBuffer: PendingBuffer;
  capabilities: CapabilityRegistry;
  /** In-memory registry of per-capability dashboards (`dashboard.json`). */
  dashboardRegistry: DashboardRegistry;
  /**
   * Intent classifier backend. Defaults to `HeuristicLLMClient`; future
   * change can swap in an LLM-backed implementation.
   */
  llmClient: LLMClient;
  /** Reflect cron stop handle, populated when the agent is started. */
  stopReflect?: () => void;
  /** Re-extraction worker stop handle, populated when the worker is started. */
  stopReextract?: () => void;
  /**
   * AGENTS.md text used by Build Bridge to seed each workdir's
   * constitution. Loaded at boot from `<plugin>/openspec/AGENTS.md`.
   */
  agentsMdSource: string;
}

let cached: Promise<StrataRuntime> | undefined;
let bootCount = 0;
let migrateCount = 0;

/**
 * Boot (or return the already-booted) Strata runtime. Idempotent across
 * multiple `register(api)` invocations on a single process.
 *
 * `api` is currently used only for the OpenClaw-side fallback logger via
 * `api.logger`; once Strata's own logger is wired we never call back into it.
 * A future change may pull `config` overrides from `api.pluginConfig`.
 */
export async function bootRuntime(api: OpenClawPluginApi): Promise<StrataRuntime> {
  if (cached) return cached;

  cached = (async () => {
    bootCount++;
    try {
      const config = await loadConfig();
      const logger = createLogger({
        level: config.logging.level,
        logFilePath: path.join(config.paths.logsDir, "plugin.log"),
        toStderr: config.logging.toStderr,
        bindings: { plugin: "strata" },
      });

      const db = openDatabase({ path: config.database.path });

      migrateCount++;
      const summary = applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
      logger
        .child({ module: "migrations" })
        .info("system migrations applied", {
          applied: summary.applied,
          skipped_count: summary.skipped.length,
        });

      const pendingBuffer = new PendingBuffer({
        stateFile: path.join(
          config.paths.dataDir,
          ".strata-state",
          "pending_buffer.json",
        ),
        logger,
      });

      const capabilityRegistryRepo = new CapabilityRegistryRepository(db);
      const dashboardRegistry = new DashboardRegistry(logger);
      const capabilities = await loadCapabilities({
        db,
        repo: capabilityRegistryRepo,
        bundledRoot: BUNDLED_CAPABILITIES_ROOT,
        userRoot: config.paths.capabilitiesDir,
        logger,
        dashboardRegistry,
      });

      return {
        config,
        db,
        logger,
        messagesRepo: new MessagesRepository(db),
        rawEventsRepo: new RawEventsRepository(db),
        capabilityRegistryRepo,
        schemaEvolutionsRepo: new SchemaEvolutionsRepository(db),
        reextractJobsRepo: new ReextractJobsRepository(db),
        buildsRepo: new BuildsRepository(db),
        proposalsRepo: new ProposalsRepository(db),
        capabilityHealthRepo: new CapabilityHealthRepository(db),
        pendingBuffer,
        capabilities,
        dashboardRegistry,
        llmClient: resolveLLMClient(config, { logger }).client,
        agentsMdSource: loadAgentsMdSource(),
      } satisfies StrataRuntime;
    } catch (err) {
      // Failed boots must NOT poison the cache; later attempts (e.g. after
      // the user fixes their config) should be able to retry.
      cached = undefined;
      api.logger?.error?.(
        `Strata bootRuntime failed: ${(err as Error).message}`,
      );
      throw err;
    }
  })();

  return cached;
}

/** Test-only: clear the memoised runtime and close the DB if open. */
export async function resetRuntimeForTests(): Promise<void> {
  if (!cached) return;
  try {
    const runtime = await cached;
    runtime.db.close();
  } catch {
    /* swallow — best effort */
  }
  cached = undefined;
}

/** Test-only: read internal counters used by idempotency assertions. */
export function _bootCountersForTests(): { bootCount: number; migrateCount: number } {
  return { bootCount, migrateCount };
}

/** Test-only: reset the internal counters (independent of cache reset). */
export function _resetBootCountersForTests(): void {
  bootCount = 0;
  migrateCount = 0;
}
