import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  MessagesRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { scanRawEvents } from "./scanner.js";

describe("scanRawEvents", () => {
  let tmp: string;
  let db: Database;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;

  async function seedEvent(opts: {
    status: "pending" | "committed" | "abandoned";
    daysAgo?: number;
  }): Promise<number> {
    const msg = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role: "user",
      content: "x",
      content_type: "text",
      turn_index: 0,
      received_at: new Date().toISOString(),
    });
    const createdAt = new Date(
      Date.now() - (opts.daysAgo ?? 1) * 86_400_000,
    ).toISOString();
    const row = await rawEventsRepo.insert({
      session_id: "s",
      event_type: "x",
      status: opts.status,
      extracted_data: "{}",
      source_summary: "x",
      primary_message_id: msg.id,
      related_message_ids: JSON.stringify([msg.id]),
      extraction_version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    });
    return row.id;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-scanner-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns only committed events", async () => {
    await seedEvent({ status: "pending" });
    await seedEvent({ status: "abandoned" });
    const id = await seedEvent({ status: "committed" });
    const rows = await scanRawEvents({ db });
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("respects sinceDays", async () => {
    await seedEvent({ status: "committed", daysAgo: 95 });
    const recentId = await seedEvent({ status: "committed", daysAgo: 1 });
    const rows = await scanRawEvents({ db }, { sinceDays: 7 });
    expect(rows.map((r) => r.id)).toEqual([recentId]);
  });

  it("respects an injected now()", async () => {
    await seedEvent({ status: "committed", daysAgo: 5 });
    const future = () => new Date(Date.now() + 100 * 86_400_000);
    const rows = await scanRawEvents({ db }, { sinceDays: 7, now: future });
    expect(rows).toHaveLength(0);
  });
});
