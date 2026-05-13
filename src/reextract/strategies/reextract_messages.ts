/**
 * `reextract_messages` strategy — re-extracts one column by going back to
 * the original conversation: the raw_event's `primary_message_id` +
 * `related_message_ids`. Heaviest of the three strategies; useful when
 * the new column needs context the raw_event didn't preserve.
 */
import type { RawEventRow } from "../../db/repositories/raw_events.js";
import type {
  ReextractRow,
  ReextractStrategy,
  StrategyOutcome,
} from "../types.js";
import { runLlmReextract } from "./llm_shared.js";

interface MessageContentRow {
  id: number;
  content: string;
  received_at: string;
}

export const reextractMessagesStrategy: ReextractStrategy = {
  name: "reextract_messages",
  async process(row, job, deps): Promise<StrategyOutcome> {
    const rawEventId = (row as ReextractRow & { raw_event_id?: number }).raw_event_id;
    if (typeof rawEventId !== "number") {
      return {
        kind: "failed",
        error: `row #${row.id} has no raw_event_id column`,
      };
    }
    const rawEvent = deps.db
      .prepare("SELECT * FROM raw_events WHERE id = ?")
      .get(rawEventId) as RawEventRow | undefined;
    if (!rawEvent) {
      return {
        kind: "failed",
        error: `raw_event #${rawEventId} not found`,
      };
    }

    const primary = rawEvent.primary_message_id;
    let related: number[] = [];
    try {
      const parsed = JSON.parse(rawEvent.related_message_ids);
      if (Array.isArray(parsed)) {
        related = parsed.filter((n): n is number => typeof n === "number");
      }
    } catch {
      /* fall through to [] */
    }
    const ids = Array.from(new Set([primary, ...related].filter((n) => typeof n === "number")));
    if (ids.length === 0) {
      return {
        kind: "failed",
        error: `raw_event #${rawEventId} has no message ids`,
      };
    }

    const placeholders = ids.map(() => "?").join(",");
    const messages = deps.db
      .prepare(
        `SELECT id, content, received_at FROM messages WHERE id IN (${placeholders}) ORDER BY received_at ASC`,
      )
      .all(...ids) as MessageContentRow[];
    if (messages.length === 0) {
      return {
        kind: "failed",
        error: `no messages found for raw_event #${rawEventId}`,
      };
    }

    const context = messages.map((m) => m.content).join("\n");
    return runLlmReextract(row, job, deps, context);
  },
};
