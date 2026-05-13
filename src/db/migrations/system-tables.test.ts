/**
 * Integration test for the eight system-table migrations.
 *
 * Verifies that:
 *   - all eight files apply cleanly to a fresh DB
 *   - a re-run is a no-op
 *   - every CHECK constraint mentioned in the requirement is enforced
 *   - the FTS5 trigger populates `messages_fts`
 *   - FK enforcement (foreign_keys=ON) works
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../migrations.js";
import { openDatabase, type Database } from "../connection.js";
import { SYSTEM_MIGRATIONS_DIR } from "../index.js";

const SYSTEM_TABLE_NAMES = [
  "messages",
  "raw_events",
  "capability_registry",
  "schema_evolutions",
  "reextract_jobs",
  "builds",
  "proposals",
  "capability_health",
];

describe("system-tables migrations", () => {
  let tmp: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-sys-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("applies all 8 migrations on a fresh DB", () => {
    const summary = applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    expect(summary.applied).toEqual([
      "001_messages.sql",
      "002_raw_events.sql",
      "003_capability_registry.sql",
      "004_schema_evolutions.sql",
      "005_reextract_jobs.sql",
      "006_builds.sql",
      "007_proposals.sql",
      "008_capability_health.sql",
    ]);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    for (const name of SYSTEM_TABLE_NAMES) {
      expect(tables).toContain(name);
    }
    expect(tables).toContain("messages_fts");
  });

  it("re-running is a no-op", () => {
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    const summary = applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toHaveLength(8);
  });

  describe("CHECK constraints", () => {
    beforeEach(() => {
      applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    });

    it("messages.role rejects an unknown value", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (session_id, channel, role, content, turn_index, received_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("s", "telegram", "tool", "hi", 0, new Date().toISOString()),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("messages.content_type rejects an unknown value", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (session_id, channel, role, content, content_type, turn_index, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("s", "telegram", "user", "hi", "video", 0, new Date().toISOString()),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("raw_events.status rejects an unknown value", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO messages (session_id, channel, role, content, turn_index, received_at) VALUES ('s','telegram','user','hello',0,?)",
      ).run(now);
      expect(() =>
        db
          .prepare(
            "INSERT INTO raw_events (session_id, event_type, status, extracted_data, source_summary, primary_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("s", "consumption", "maybe", "{}", "test", 1, now, now),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("raw_events.extraction_confidence rejects out-of-range", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO messages (session_id, channel, role, content, turn_index, received_at) VALUES ('s','telegram','user','hello',0,?)",
      ).run(now);
      expect(() =>
        db
          .prepare(
            "INSERT INTO raw_events (session_id, event_type, status, extracted_data, source_summary, primary_message_id, extraction_confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("s", "consumption", "pending", "{}", "test", 1, 1.5, now, now),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("capability_registry.status rejects an unknown value", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            "INSERT INTO capability_registry (name, version, status, meta_path, primary_table, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("expenses", 1, "paused", "/x/meta.json", "expenses", now),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("schema_evolutions.change_type rejects an unknown value", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO capability_registry (name, version, status, meta_path, primary_table, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("expenses", 1, "active", "/x/meta.json", "expenses", now);
      expect(() =>
        db
          .prepare(
            "INSERT INTO schema_evolutions (capability_name, from_version, to_version, change_type, diff, proposed_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("expenses", 0, 1, "weird", "{}", now),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("reextract_jobs.status rejects an unknown value", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO capability_registry (name, version, status, meta_path, primary_table, created_at) VALUES ('expenses', 1, 'active', '/x', 'expenses', ?)",
      ).run(now);
      db.prepare(
        "INSERT INTO schema_evolutions (id, capability_name, from_version, to_version, change_type, diff, proposed_at) VALUES (1, 'expenses', 0, 1, 'capability_create', '{}', ?)",
      ).run(now);
      expect(() =>
        db
          .prepare(
            "INSERT INTO reextract_jobs (schema_evolution_id, capability_name, strategy, status) VALUES (?, ?, ?, ?)",
          )
          .run(1, "expenses", "derive_existing", "whatever"),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("builds.phase rejects an unknown value", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            "INSERT INTO builds (session_id, trigger_kind, target_capability, target_action, phase, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("s", "user_request", "expenses", "create", "reviewing", now),
      ).toThrowError(/CHECK constraint failed/);
    });

    it("proposals.status rejects an unknown value", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            "INSERT INTO proposals (source, kind, title, summary, rationale, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("reflect_agent", "new_capability", "x", "y", "z", "rejected", now),
      ).toThrowError(/CHECK constraint failed/);
    });
  });

  describe("FTS5 trigger", () => {
    beforeEach(() => {
      applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    });

    it("populates messages_fts on INSERT", () => {
      const now = new Date().toISOString();
      const info = db
        .prepare(
          "INSERT INTO messages (session_id, channel, role, content, turn_index, received_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("s", "telegram", "user", "coffee at blue bottle", 0, now);
      const insertedId = info.lastInsertRowid as number;

      const hit = db
        .prepare<[string], { rowid: number }>(
          "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?",
        )
        .get("coffee");
      expect(hit?.rowid).toBe(insertedId);
    });

    it("reflects content edits via the UPDATE trigger", () => {
      const now = new Date().toISOString();
      const info = db
        .prepare(
          "INSERT INTO messages (session_id, channel, role, content, turn_index, received_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("s", "telegram", "user", "coffee", 0, now);
      const id = info.lastInsertRowid as number;

      db.prepare("UPDATE messages SET content = 'matcha latte' WHERE id = ?").run(id);

      const old = db
        .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'coffee'")
        .get();
      const fresh = db
        .prepare<[string], { rowid: number }>(
          "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?",
        )
        .get("matcha");
      expect(old).toBeUndefined();
      expect(fresh?.rowid).toBe(id);
    });
  });

  describe("FK enforcement", () => {
    beforeEach(() => {
      applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    });

    it("rejects a raw_events row whose primary_message_id is dangling", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            "INSERT INTO raw_events (session_id, event_type, status, extracted_data, source_summary, primary_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("s", "consumption", "pending", "{}", "test", 999, now, now),
      ).toThrowError(/FOREIGN KEY constraint failed/);
    });

    it("rejects a schema_evolutions row whose capability_name is unknown", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            "INSERT INTO schema_evolutions (capability_name, from_version, to_version, change_type, diff, proposed_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("missing", 0, 1, "capability_create", "{}", now),
      ).toThrowError(/FOREIGN KEY constraint failed/);
    });
  });
});
