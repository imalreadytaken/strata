import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CapabilityRegistry,
  LoadedCapability,
} from "../capabilities/types.js";
import { commitEventCore, commitEventTool } from "./commit_event.js";
import { createPendingEventTool } from "./create_pending_event.js";
import { makeHarness, type TestHarness } from "./test_helpers.js";

describe("strata_commit_event", () => {
  let h: TestHarness;

  async function seedPending(): Promise<number> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const result = await create.execute("seed", {
      event_type: "consumption",
      extracted_data: { amount_minor: 4500 },
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: msgId,
      confidence: 0.9,
    });
    return (result.details as { event_id: number }).event_id;
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-commit" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("transitions pending → committed and drains the buffer", async () => {
    const eventId = await seedPending();
    const tool = commitEventTool(h.deps);
    const result = await tool.execute("c1", { event_id: eventId });
    expect(result.details).toMatchObject({
      event_id: eventId,
      status: "committed",
      capability_written: false,
      summary: "Blue Bottle 拿铁 ¥45",
    });

    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
    expect(row?.committed_at).toBeTruthy();
    expect(await h.pendingBuffer.has("s-commit", eventId)).toBe(false);
  });

  it("refuses a double-commit", async () => {
    const eventId = await seedPending();
    const tool = commitEventTool(h.deps);
    await tool.execute("c1", { event_id: eventId });
    await expect(tool.execute("c2", { event_id: eventId })).rejects.toThrow(
      /not in pending state/,
    );
  });

  it("refuses a missing event", async () => {
    const tool = commitEventTool(h.deps);
    await expect(
      tool.execute("c3", { event_id: 9999 }),
    ).rejects.toThrow(/not found/);
  });

  it("commitEventCore is callable directly with the same semantics", async () => {
    const eventId = await seedPending();
    const details = await commitEventCore(h.deps, eventId);
    expect(details).toMatchObject({
      event_id: eventId,
      status: "committed",
      capability_written: false,
    });
    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
  });

  it("succeeds even when the buffer no longer contains the id", async () => {
    const eventId = await seedPending();
    await h.pendingBuffer.remove("s-commit", eventId); // pre-drain
    const tool = commitEventTool(h.deps);
    const result = await tool.execute("c4", { event_id: eventId });
    expect((result.details as { status: string }).status).toBe("committed");
  });
});

describe("strata_commit_event with pipelineDeps", () => {
  let h: TestHarness;

  async function seedBoundPending(
    capability_name: string,
  ): Promise<number> {
    const msgId = await h.insertMessage();
    const create = createPendingEventTool(h.deps);
    const result = await create.execute("seed", {
      event_type: "consumption",
      capability_name,
      extracted_data: { amount_minor: 4500 },
      source_summary: "Blue Bottle 拿铁 ¥45",
      primary_message_id: msgId,
      confidence: 0.9,
    });
    return (result.details as { event_id: number }).event_id;
  }

  /**
   * Emit a tiny capability whose pipeline writes one row into a per-test
   * business table and returns the row id. Registers the capability in the
   * harness's `capability_registry` so `capability_health` FK is satisfied.
   */
  function makeFakeCapability(
    name: string,
    table: string,
  ): LoadedCapability {
    const dir = path.join(h.tmp, "caps", name, "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        name,
        version: 1,
        description: name,
        primary_table: table,
      }),
    );
    writeFileSync(
      path.join(dir, "pipeline.mjs"),
      `export async function ingest(rawEvent, deps) {
        deps.db.exec("CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, raw_event_id INTEGER NOT NULL, created_at TEXT NOT NULL)");
        const row = deps.db.prepare("INSERT INTO ${table} (raw_event_id, created_at) VALUES (?, ?) RETURNING id").get(rawEvent.id, deps.now());
        return { business_row_id: row.id, business_table: "${table}" };
      }`,
    );
    h.db
      .prepare(
        "INSERT INTO capability_registry (name, version, status, meta_path, primary_table, created_at) VALUES (?, 1, 'active', ?, ?, ?)",
      )
      .run(name, path.join(dir, "meta.json"), table, new Date().toISOString());
    return {
      meta: {
        name,
        version: 1,
        description: name,
        primary_table: table,
        depends_on_capabilities: [],
        ingest_event_types: [],
        owner_pipeline: "pipeline.mjs",
        exposed_skills: [],
      },
      path: dir,
      metaPath: path.join(dir, "meta.json"),
    };
  }

  beforeEach(() => {
    h = makeHarness({ sessionId: "s-commit-pipe" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("runs the bound capability's pipeline and surfaces capability_written: true", async () => {
    const cap = makeFakeCapability("expenses_test", "expenses_test");
    const registry: CapabilityRegistry = new Map([[cap.meta.name, cap]]);
    h.deps.pipelineDeps = {
      db: h.db,
      registry,
      rawEventsRepo: h.rawEventsRepo,
      capabilityHealthRepo: h.capabilityHealthRepo,
      logger: h.logger,
    };

    const eventId = await seedBoundPending(cap.meta.name);
    const result = await commitEventCore(h.deps, eventId);
    expect(result.capability_written).toBe(true);
    expect(result.business_row_id).toBeGreaterThan(0);

    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.business_row_id).toBe(result.business_row_id);
    const health = await h.capabilityHealthRepo.findById("expenses_test");
    expect(health?.total_writes).toBe(1);
  });

  it("capability_written stays false when pipelineDeps is undefined", async () => {
    const eventId = await seedBoundPending("expenses_test");
    const result = await commitEventCore(h.deps, eventId);
    expect(result.capability_written).toBe(false);
    expect(result.business_row_id).toBeUndefined();
    const row = await h.rawEventsRepo.findById(eventId);
    expect(row?.status).toBe("committed");
  });
});
