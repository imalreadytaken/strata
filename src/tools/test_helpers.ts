/**
 * Shared test harness for the six event tools. Creates a fresh DB +
 * repositories + pending buffer + logger and returns a ready-to-use deps
 * bag plus a tmp-dir cleanup hook.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type DatabaseType from "better-sqlite3";

import type { PipelineToolDeps } from "../capabilities/pipeline_runner.js";
import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase } from "../db/connection.js";

type Database = DatabaseType.Database;
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  CapabilityHealthRepository,
  MessagesRepository,
  ProposalsRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { PendingBuffer } from "../pending_buffer/index.js";
import type { EventToolDeps } from "./types.js";

export interface TestHarness {
  tmp: string;
  db: Database;
  logger: Logger;
  messagesRepo: MessagesRepository;
  rawEventsRepo: RawEventsRepository;
  proposalsRepo: ProposalsRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  pendingBuffer: PendingBuffer;
  deps: EventToolDeps & { db: Database };
  /** Insert a `messages` row and return its id; handy for satisfying FK constraints. */
  insertMessage(session_id?: string, content?: string): Promise<number>;
  /** Close the DB and remove the tmp dir. */
  teardown(): Promise<void>;
}

export interface MakeHarnessOpts {
  sessionId?: string;
  /**
   * Optional pipeline-runner deps wired into `deps.pipelineDeps`. Default
   * `undefined` — pre-existing tests don't exercise capability writes.
   */
  pipelineDeps?: PipelineToolDeps;
}

export function makeHarness(opts: MakeHarnessOpts = {}): TestHarness {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "strata-tools-"));
  const db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
  applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
  const logger = createLogger({
    level: "debug",
    logFilePath: path.join(tmp, "log.log"),
  });
  const messagesRepo = new MessagesRepository(db);
  const rawEventsRepo = new RawEventsRepository(db);
  const proposalsRepo = new ProposalsRepository(db);
  const capabilityHealthRepo = new CapabilityHealthRepository(db);
  const pendingBuffer = new PendingBuffer({
    stateFile: path.join(tmp, "pending_buffer.json"),
    logger,
  });
  const sessionId = opts.sessionId ?? "s-test";
  const deps: EventToolDeps & { db: Database } = {
    rawEventsRepo,
    proposalsRepo,
    pendingBuffer,
    logger,
    sessionId,
    db,
  };
  if (opts.pipelineDeps) {
    deps.pipelineDeps = opts.pipelineDeps;
  }

  return {
    tmp,
    db,
    logger,
    messagesRepo,
    rawEventsRepo,
    proposalsRepo,
    capabilityHealthRepo,
    pendingBuffer,
    deps,
    async insertMessage(s = sessionId, content = "x"): Promise<number> {
      const turn = await messagesRepo.getNextTurnIndex(s);
      const row = await messagesRepo.insert({
        session_id: s,
        channel: "test",
        role: "user",
        content,
        content_type: "text",
        turn_index: turn,
        received_at: new Date().toISOString(),
      });
      return row.id;
    },
    async teardown() {
      db.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}
