import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityRegistry } from "../capabilities/types.js";
import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  MessagesRepository,
  RawEventsRepository,
} from "../db/repositories/index.js";
import { PendingBuffer } from "../pending_buffer/index.js";
import {
  buildTriageInput,
  installTriageHook,
  renderRoutingContext,
} from "./hook.js";
import { HeuristicLLMClient } from "./heuristics.js";
import type { LLMClient, TriageInput, TriageResult } from "./index.js";

function makeStubLLM(response: TriageResult): LLMClient {
  return { infer: async () => JSON.stringify(response) };
}

function makeInput(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    user_message: "hello",
    recent_messages: [],
    active_capabilities: [],
    pending_event_summaries: [],
    ...overrides,
  };
}

describe("renderRoutingContext", () => {
  it("capture template names all relevant tools", () => {
    const r = renderRoutingContext(
      { kind: "capture", confidence: 0.8, reasoning: "money pattern" },
      makeInput({ active_capabilities: ["expenses"] }),
    );
    expect(r.prependContext).toContain("CAPTURE");
    expect(r.prependContext).toContain("strata_create_pending_event");
    expect(r.prependContext).toContain("strata_commit_event");
    expect(r.prependContext).toContain("strata_abandon_event");
    expect(r.prependSystemContext).toContain("expenses");
  });

  it("correction template references search + supersede", () => {
    const r = renderRoutingContext(
      { kind: "correction", confidence: 0.8, reasoning: "其实是" },
      makeInput(),
    );
    expect(r.prependContext).toContain("strata_search_events");
    expect(r.prependContext).toContain("strata_supersede_event");
  });

  it("query template references search only", () => {
    const r = renderRoutingContext(
      { kind: "query", confidence: 0.7, reasoning: "how much" },
      makeInput(),
    );
    expect(r.prependContext).toContain("strata_search_events");
    expect(r.prependContext).not.toContain("strata_create_pending_event");
  });

  it("build_request template routes to strata_propose_capability", () => {
    const r = renderRoutingContext(
      { kind: "build_request", confidence: 0.85, reasoning: "加个追踪" },
      makeInput(),
    );
    expect(r.prependContext).toContain("strata_propose_capability");
    // Must NOT claim Build Bridge is unavailable (the old placeholder text).
    expect(r.prependContext.toLowerCase()).not.toMatch(
      /not yet (shipped|available)/,
    );
  });

  it("chitchat returns empty prependContext but a non-empty system block", () => {
    const r = renderRoutingContext(
      { kind: "chitchat", confidence: 0.5, reasoning: "default" },
      makeInput(),
    );
    expect(r.prependContext).toBe("");
    expect(r.prependSystemContext.length).toBeGreaterThan(0);
  });

  it("static block lists pending events when present", () => {
    const r = renderRoutingContext(
      { kind: "capture", confidence: 0.8, reasoning: "x" },
      makeInput({ pending_event_summaries: ["#1: coffee", "#2: taxi"] }),
    );
    expect(r.prependContext).toContain("#1: coffee");
    expect(r.prependContext).toContain("#2: taxi");
  });

  it("static block names every strata_* tool", () => {
    const r = renderRoutingContext(
      { kind: "chitchat", confidence: 0.5, reasoning: "x" },
      makeInput(),
    );
    for (const name of [
      "strata_create_pending_event",
      "strata_update_pending_event",
      "strata_commit_event",
      "strata_supersede_event",
      "strata_abandon_event",
      "strata_search_events",
      "strata_propose_capability",
    ]) {
      expect(r.prependSystemContext).toContain(name);
    }
  });
});

describe("buildTriageInput", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;
  let pendingBuffer: PendingBuffer;
  let capabilities: CapabilityRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-triage-hook-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
    pendingBuffer = new PendingBuffer({
      stateFile: path.join(tmp, "buf.json"),
      logger,
    });
    capabilities = new Map();
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function seedMessage(
    content: string,
    receivedAt: string,
    role: "user" | "assistant" = "user",
  ): Promise<number> {
    const turn = await messagesRepo.getNextTurnIndex("s");
    const row = await messagesRepo.insert({
      session_id: "s",
      channel: "test",
      role,
      content,
      content_type: "text",
      turn_index: turn,
      received_at: receivedAt,
    });
    return row.id;
  }

  it("returns recent user messages newest-first, max 3", async () => {
    await seedMessage("m1", "2026-05-13T09:00:00+08:00");
    await seedMessage("m2", "2026-05-13T09:01:00+08:00");
    await seedMessage("m3", "2026-05-13T09:02:00+08:00");
    await seedMessage("m4", "2026-05-13T09:03:00+08:00");
    await seedMessage("assistant1", "2026-05-13T09:02:30+08:00", "assistant");

    const input = await buildTriageInput({
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      sessionId: "s",
      userMessage: "m5",
    });

    expect(input.user_message).toBe("m5");
    expect(input.recent_messages).toEqual(["m4", "m3", "m2"]);
  });

  it("lists active capability names", async () => {
    capabilities.set("expenses", {} as never);
    capabilities.set("moods", {} as never);
    const input = await buildTriageInput({
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      sessionId: "s",
      userMessage: "x",
    });
    expect(input.active_capabilities).toEqual(["expenses", "moods"]);
  });

  it("populates pending_event_summaries from the buffer + repo", async () => {
    const msgId = await seedMessage("seed", "2026-05-13T09:00:00+08:00");
    const now = new Date().toISOString();
    const row1 = await rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "pending",
      extracted_data: "{}",
      source_summary: "coffee ¥45",
      primary_message_id: msgId,
      related_message_ids: JSON.stringify([msgId]),
      extraction_version: 1,
      created_at: now,
      updated_at: now,
    });
    const row2 = await rawEventsRepo.insert({
      session_id: "s",
      event_type: "consumption",
      status: "pending",
      extracted_data: "{}",
      source_summary: "taxi ¥35",
      primary_message_id: msgId,
      related_message_ids: JSON.stringify([msgId]),
      extraction_version: 1,
      created_at: now,
      updated_at: now,
    });
    await pendingBuffer.add("s", row1.id);
    await pendingBuffer.add("s", row2.id);

    const input = await buildTriageInput({
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      sessionId: "s",
      userMessage: "x",
    });
    expect(input.pending_event_summaries).toEqual([
      `#${row1.id}: coffee ¥45`,
      `#${row2.id}: taxi ¥35`,
    ]);
  });

  it("drops buffer ids that no longer resolve to a row", async () => {
    await pendingBuffer.add("s", 9999);
    const input = await buildTriageInput({
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      sessionId: "s",
      userMessage: "x",
    });
    expect(input.pending_event_summaries).toEqual([]);
  });
});

describe("installTriageHook", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let messagesRepo: MessagesRepository;
  let rawEventsRepo: RawEventsRepository;
  let pendingBuffer: PendingBuffer;
  let capabilities: CapabilityRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-triage-install-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    messagesRepo = new MessagesRepository(db);
    rawEventsRepo = new RawEventsRepository(db);
    pendingBuffer = new PendingBuffer({
      stateFile: path.join(tmp, "buf.json"),
      logger,
    });
    capabilities = new Map();
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("subscribes to before_prompt_build exactly once", () => {
    const on = vi.fn();
    const api = { on } as unknown as Parameters<typeof installTriageHook>[0];
    installTriageHook(api, {
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      llmClient: new HeuristicLLMClient(),
      logger,
    });
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");
    expect(typeof on.mock.calls[0]?.[1]).toBe("function");
  });

  it("registered handler returns the rendered routing context for a capture classification", async () => {
    capabilities.set("expenses", {} as never);
    let registered: (event: { prompt: string; messages: unknown[] }, ctx: { sessionId?: string }) => Promise<unknown>;
    const api = {
      on: (_name: string, handler: typeof registered) => {
        registered = handler;
      },
    } as unknown as Parameters<typeof installTriageHook>[0];
    installTriageHook(api, {
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      llmClient: makeStubLLM({
        kind: "capture",
        confidence: 0.9,
        reasoning: "money",
      }),
      logger,
    });
    const result = (await registered!(
      { prompt: "今天买了 ¥45 咖啡", messages: [] },
      { sessionId: "s" },
    )) as { prependContext: string; prependSystemContext: string };
    expect(result.prependContext).toContain("CAPTURE");
    expect(result.prependContext).toContain("strata_create_pending_event");
    expect(result.prependSystemContext).toContain("expenses");
  });

  it("swallows triage failures and returns {}", async () => {
    let registered: (event: { prompt: string; messages: unknown[] }, ctx: { sessionId?: string }) => Promise<unknown>;
    const api = {
      on: (_name: string, handler: typeof registered) => {
        registered = handler;
      },
    } as unknown as Parameters<typeof installTriageHook>[0];
    const exploding: LLMClient = {
      infer: async () => {
        throw new Error("boom");
      },
    };
    installTriageHook(api, {
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      llmClient: exploding,
      logger,
    });
    const result = await registered!(
      { prompt: "hi", messages: [] },
      { sessionId: "s" },
    );
    expect(result).toEqual({});
  });

  it("falls back to sessionId='default' when ctx.sessionId is missing", async () => {
    let registered: (event: { prompt: string; messages: unknown[] }, ctx: { sessionId?: string }) => Promise<unknown>;
    const api = {
      on: (_name: string, handler: typeof registered) => {
        registered = handler;
      },
    } as unknown as Parameters<typeof installTriageHook>[0];
    installTriageHook(api, {
      messagesRepo,
      rawEventsRepo,
      pendingBuffer,
      capabilities,
      llmClient: makeStubLLM({
        kind: "chitchat",
        confidence: 0.5,
        reasoning: "x",
      }),
      logger,
    });
    // No throw, returns a sane object.
    const result = (await registered!(
      { prompt: "hi", messages: [] },
      {},
    )) as { prependContext: string; prependSystemContext: string };
    expect(result.prependContext).toBe("");
    expect(result.prependSystemContext.length).toBeGreaterThan(0);
  });
});
