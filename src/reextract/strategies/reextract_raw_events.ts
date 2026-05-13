/**
 * `reextract_raw_events` strategy — re-extracts one column from the
 * linked `raw_events` row's already-parsed `extracted_data` plus
 * `source_summary`. Cheaper than `reextract_messages` because no
 * conversation-context rebuild is needed.
 */
import type { RawEventRow } from "../../db/repositories/raw_events.js";
import type { ReextractRow, ReextractStrategy, StrategyOutcome } from "../types.js";
import { runLlmReextract } from "./llm_shared.js";

export const reextractRawEventsStrategy: ReextractStrategy = {
  name: "reextract_raw_events",
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
    let extracted: unknown;
    try {
      extracted = JSON.parse(rawEvent.extracted_data);
    } catch {
      extracted = rawEvent.extracted_data; // ship as-is when not valid JSON
    }
    const context =
      `${rawEvent.source_summary}\n\nextracted_data: ${JSON.stringify(extracted, null, 2)}`;
    return runLlmReextract(row, job, deps, context);
  },
};
