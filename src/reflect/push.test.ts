import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import { ProposalsRepository } from "../db/repositories/index.js";
import { pushProposalsToUser } from "./push.js";
import type { ProposalRow } from "../db/repositories/proposals.js";

describe("pushProposalsToUser", () => {
  let tmp: string;
  let db: Database;
  let proposalsRepo: ProposalsRepository;
  let logger: Logger;
  const now = new Date("2026-05-13T00:00:00Z");

  async function seedProposal(): Promise<ProposalRow> {
    return proposalsRepo.insert({
      source: "reflect_agent",
      kind: "schema_evolution",
      target_capability: "expenses",
      title: "title",
      summary: "summary",
      rationale: "rationale",
      status: "pending",
      signal_strength: 0.7,
      created_at: now.toISOString(),
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-push-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    proposalsRepo = new ProposalsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("calls notify once per row and stamps pushed_to_user_at", async () => {
    const a = await seedProposal();
    const b = await seedProposal();
    const notify = vi.fn(async () => {});
    await pushProposalsToUser([a, b], {
      proposalsRepo,
      notify,
      logger,
      now: () => now,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await proposalsRepo.findById(a.id))?.pushed_to_user_at).toBe(
      now.toISOString(),
    );
    expect((await proposalsRepo.findById(b.id))?.pushed_to_user_at).toBe(
      now.toISOString(),
    );
  });

  it("swallows notify rejection but still stamps pushed_to_user_at", async () => {
    const row = await seedProposal();
    const notify = vi.fn(async () => {
      throw new Error("im down");
    });
    await pushProposalsToUser([row], {
      proposalsRepo,
      notify,
      logger,
      now: () => now,
    });
    expect((await proposalsRepo.findById(row.id))?.pushed_to_user_at).toBe(
      now.toISOString(),
    );
  });

  it("notify receives the rendered card text", async () => {
    const row = await seedProposal();
    const captured: string[] = [];
    await pushProposalsToUser([row], {
      proposalsRepo,
      notify: async (_row, card) => {
        captured.push(card.text);
      },
      logger,
      now: () => now,
    });
    expect(captured[0]).toContain(`#${row.id}`);
    expect(captured[0]).toContain("schema_evolution");
  });
});
