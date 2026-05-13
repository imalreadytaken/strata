import type Database from "better-sqlite3";

import { StateMachineError } from "../../core/errors.js";
import { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export interface MessageRow {
  id: number;
  session_id: string;
  channel: string;
  role: "user" | "assistant" | "system";
  content: string;
  content_type: "text" | "image" | "audio" | "file" | "callback";
  turn_index: number;
  received_at: string;
  raw_event_id: number | null;
  raw_event_role: "primary" | "context" | "correction" | "confirmation" | null;
  embedding: Buffer | null;
}

const MESSAGE_COLUMNS = [
  "session_id",
  "channel",
  "role",
  "content",
  "content_type",
  "turn_index",
  "received_at",
  "raw_event_id",
  "raw_event_role",
  "embedding",
] as const;

export class MessagesRepository extends SQLiteRepository<MessageRow, number> {
  constructor(db: Database.Database, opts: SQLiteRepositoryOptions = {}) {
    super(db, "messages", MESSAGE_COLUMNS, opts);
  }

  /** Append-only: corrections happen at the raw_event layer. */
  override async softDelete(_id: number): Promise<void> {
    throw new StateMachineError(
      "STRATA_E_STATE_TRANSITION",
      "messages is append-only (AGENTS.md #1) — corrections happen at the raw_events layer via supersede_event_id",
    );
  }

  /**
   * Returns the next `turn_index` for a given session. First message in a
   * session gets `turn_index = 0`, then 1, 2, ...
   */
  async getNextTurnIndex(session_id: string): Promise<number> {
    const row = this.db
      .prepare<[string], { next: number }>(
        "SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM messages WHERE session_id = ?",
      )
      .get(session_id);
    return row?.next ?? 0;
  }

  /** Convenience for the async embedding worker. */
  async updateEmbedding(id: number, embedding: Float32Array): Promise<void> {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db
      .prepare("UPDATE messages SET embedding = ? WHERE id = ?")
      .run(buf, id);
  }
}
