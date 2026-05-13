/**
 * Per-concrete-repository integration test.
 *
 * Applies the eight system migrations to a fresh DB, then exercises every
 * repository's softDelete semantics and the bespoke helper methods named by
 * `STRATA_SPEC.md` §5.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateMachineError } from "../../core/errors.js";
import { openDatabase, type Database } from "../connection.js";
import { applyMigrations } from "../migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../index.js";
import {
  BuildsRepository,
  CapabilityHealthRepository,
  CapabilityRegistryRepository,
  MessagesRepository,
  ProposalsRepository,
  RawEventsRepository,
  ReextractJobsRepository,
  SchemaEvolutionsRepository,
} from "./index.js";

const FIXED_NOW = "2026-05-11T12:00:00+00:00";
const NOW_FN = () => FIXED_NOW;

describe("repositories (against the real system tables)", () => {
  let tmp: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-repos-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------
  // append-only / state-machine: softDelete must throw
  // -----------------------------------------------------------------
  describe("softDelete on append-only / non-lifecycle tables throws", () => {
    it("messages", async () => {
      const repo = new MessagesRepository(db);
      await expect(repo.softDelete(1)).rejects.toBeInstanceOf(StateMachineError);
    });

    it("raw_events", async () => {
      const repo = new RawEventsRepository(db);
      await expect(repo.softDelete(1)).rejects.toBeInstanceOf(StateMachineError);
    });

    it("schema_evolutions", async () => {
      const repo = new SchemaEvolutionsRepository(db);
      await expect(repo.softDelete(1)).rejects.toBeInstanceOf(StateMachineError);
    });

    it("reextract_jobs", async () => {
      const repo = new ReextractJobsRepository(db);
      await expect(repo.softDelete(1)).rejects.toBeInstanceOf(StateMachineError);
    });

    it("capability_health", async () => {
      const repo = new CapabilityHealthRepository(db);
      await expect(repo.softDelete("expenses")).rejects.toBeInstanceOf(
        StateMachineError,
      );
    });
  });

  // -----------------------------------------------------------------
  // lifecycle tables: softDelete flips status and stamps time
  // -----------------------------------------------------------------
  describe("softDelete on lifecycle tables flips status and stamps time", () => {
    it("capability_registry → status='archived', archived_at = now", async () => {
      const repo = new CapabilityRegistryRepository(db, { now: NOW_FN });
      await repo.insert({
        name: "expenses",
        version: 1,
        status: "active",
        meta_path: "/x/meta.json",
        primary_table: "expenses",
        created_at: FIXED_NOW,
      });
      await repo.softDelete("expenses");
      const row = await repo.findById("expenses");
      expect(row?.status).toBe("archived");
      expect(row?.archived_at).toBe(FIXED_NOW);
    });

    it("builds → phase='cancelled', completed_at = now", async () => {
      const repo = new BuildsRepository(db, { now: NOW_FN });
      const inserted = await repo.insert({
        session_id: "s",
        trigger_kind: "user_request",
        target_capability: "expenses",
        target_action: "create",
        phase: "plan",
        changes_done: 0,
        created_at: FIXED_NOW,
      });
      await repo.softDelete(inserted.id);
      const row = await repo.findById(inserted.id);
      expect(row?.phase).toBe("cancelled");
      expect(row?.completed_at).toBe(FIXED_NOW);
    });

    it("proposals → status='declined', responded_at = now", async () => {
      const repo = new ProposalsRepository(db, { now: NOW_FN });
      const inserted = await repo.insert({
        source: "reflect_agent",
        kind: "new_capability",
        title: "x",
        summary: "y",
        rationale: "z",
        status: "pending",
        created_at: FIXED_NOW,
      });
      await repo.softDelete(inserted.id);
      const row = await repo.findById(inserted.id);
      expect(row?.status).toBe("declined");
      expect(row?.responded_at).toBe(FIXED_NOW);
    });
  });

  // -----------------------------------------------------------------
  // helper methods
  // -----------------------------------------------------------------
  describe("MessagesRepository.getNextTurnIndex", () => {
    it("returns 0 for an empty session", async () => {
      const repo = new MessagesRepository(db);
      expect(await repo.getNextTurnIndex("fresh-session")).toBe(0);
    });

    it("increments with each insert", async () => {
      const repo = new MessagesRepository(db);
      for (let i = 0; i < 3; i++) {
        await repo.insert({
          session_id: "s1",
          channel: "telegram",
          role: "user",
          content: `m${i}`,
          content_type: "text",
          turn_index: i,
          received_at: FIXED_NOW,
        });
      }
      expect(await repo.getNextTurnIndex("s1")).toBe(3);
      expect(await repo.getNextTurnIndex("s2")).toBe(0);
    });
  });

  describe("RawEventsRepository.findExpiredPending", () => {
    it("returns only the pending rows past the cutoff", async () => {
      const messages = new MessagesRepository(db);
      const msg = await messages.insert({
        session_id: "s",
        channel: "telegram",
        role: "user",
        content: "hi",
        content_type: "text",
        turn_index: 0,
        received_at: FIXED_NOW,
      });

      const repo = new RawEventsRepository(db);

      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60_000).toISOString();

      const fresh = await repo.insert({
        session_id: "s",
        event_type: "consumption",
        status: "pending",
        extracted_data: "{}",
        source_summary: "fresh",
        primary_message_id: msg.id,
        related_message_ids: "[]",
        extraction_version: 1,
        created_at: fiveMinAgo,
        updated_at: fiveMinAgo,
      });
      const stale = await repo.insert({
        session_id: "s",
        event_type: "consumption",
        status: "pending",
        extracted_data: "{}",
        source_summary: "stale",
        primary_message_id: msg.id,
        related_message_ids: "[]",
        extraction_version: 1,
        created_at: thirtyFiveMinAgo,
        updated_at: thirtyFiveMinAgo,
      });

      const expired = await repo.findExpiredPending(30);
      const ids = expired.map((e) => e.id);
      expect(ids).toContain(stale.id);
      expect(ids).not.toContain(fresh.id);
    });
  });

  describe("CapabilityHealthRepository increments", () => {
    it("incrementWrite is atomic and upserts on first call", async () => {
      const reg = new CapabilityRegistryRepository(db, { now: NOW_FN });
      await reg.insert({
        name: "expenses",
        version: 1,
        status: "active",
        meta_path: "/x",
        primary_table: "expenses",
        created_at: FIXED_NOW,
      });

      const repo = new CapabilityHealthRepository(db, { now: NOW_FN });
      await repo.incrementWrite("expenses");
      await repo.incrementWrite("expenses");
      await repo.incrementWrite("expenses");

      const row = await repo.findById("expenses");
      expect(row?.total_writes).toBe(3);
      expect(row?.last_write_at).toBe(FIXED_NOW);
    });

    it("incrementRead and incrementCorrection are independent counters", async () => {
      const reg = new CapabilityRegistryRepository(db, { now: NOW_FN });
      await reg.insert({
        name: "moods",
        version: 1,
        status: "active",
        meta_path: "/x",
        primary_table: "moods",
        created_at: FIXED_NOW,
      });
      const repo = new CapabilityHealthRepository(db, { now: NOW_FN });
      await repo.incrementWrite("moods");
      await repo.incrementRead("moods");
      await repo.incrementRead("moods");
      await repo.incrementCorrection("moods");

      const row = await repo.findById("moods");
      expect(row?.total_writes).toBe(1);
      expect(row?.total_reads).toBe(2);
      expect(row?.total_corrections).toBe(1);
    });
  });

  describe("ReextractJobsRepository.increment", () => {
    it("atomically increments a single counter", async () => {
      const reg = new CapabilityRegistryRepository(db, { now: NOW_FN });
      await reg.insert({
        name: "x",
        version: 1,
        status: "active",
        meta_path: "/p",
        primary_table: "x",
        created_at: FIXED_NOW,
      });
      const evo = new SchemaEvolutionsRepository(db);
      const ev = await evo.insert({
        capability_name: "x",
        from_version: 0,
        to_version: 1,
        change_type: "capability_create",
        diff: "{}",
        proposed_at: FIXED_NOW,
      });

      const repo = new ReextractJobsRepository(db);
      const job = await repo.insert({
        schema_evolution_id: ev.id,
        capability_name: "x",
        strategy: "derive_existing",
        status: "running",
        rows_total: 10,
        rows_done: 0,
        rows_failed: 0,
        rows_low_confidence: 0,
      });
      await repo.increment(job.id, "rows_done");
      await repo.increment(job.id, "rows_done", 4);
      await repo.increment(job.id, "rows_failed");

      const row = await repo.findById(job.id);
      expect(row?.rows_done).toBe(5);
      expect(row?.rows_failed).toBe(1);
    });
  });
});
