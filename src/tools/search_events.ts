/**
 * `strata_search_events` — agent-facing read-only search across `raw_events`.
 *
 * LIKE on `source_summary` (case-insensitive via `COLLATE NOCASE`) plus
 * optional `event_type` / `status` / `created_at` range filters. Vector +
 * FTS search is deferred until the embedding worker exists (P6).
 *
 * See `STRATA_SPEC.md` §5.3.5.
 */
import type Database from "better-sqlite3";

import { z } from "zod";

import type { AnyAgentTool, EventToolDeps } from "./types.js";
import type { RawEventStatus } from "../db/repositories/raw_events.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

const HARD_LIMIT = 50;
const DEFAULT_LIMIT = 10;

export const searchEventsSchema = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe("LIKE substring matched against source_summary (case-insensitive)."),
  event_type: z.string().min(1).optional(),
  status: z
    .enum(["pending", "committed", "superseded", "abandoned"])
    .optional(),
  since: z.string().min(1).optional().describe("ISO 8601: filter created_at >= since."),
  until: z.string().min(1).optional().describe("ISO 8601: filter created_at <= until."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HARD_LIMIT)
    .optional()
    .describe(`Max results; default ${DEFAULT_LIMIT}, hard-capped at ${HARD_LIMIT}.`),
});

export type SearchEventsInput = z.infer<typeof searchEventsSchema>;

export interface SearchEventsResultRow {
  event_id: number;
  status: RawEventStatus;
  event_type: string;
  capability_name: string | null;
  source_summary: string;
  event_occurred_at: string | null;
  created_at: string;
  extraction_confidence: number | null;
}

export interface SearchEventsDetails {
  count: number;
  results: SearchEventsResultRow[];
}

const NAME = "strata_search_events";
const DESCRIPTION = `Search raw_events by summary, type, status, and time range.

Useful for:
- Finding a past event the user wants to correct ("上周一咖啡其实是 ¥48")
- Surveying recent records of a kind ("最近三笔消费是什么?")

Returns the latest matching events first (committed before pending; ties
broken by created_at DESC). Hard-capped at 50 results.`;

interface SearchDeps extends EventToolDeps {
  db: Database.Database;
}

interface RawSearchRow {
  id: number;
  status: RawEventStatus;
  event_type: string;
  capability_name: string | null;
  source_summary: string;
  event_occurred_at: string | null;
  created_at: string;
  extraction_confidence: number | null;
}

export function searchEventsTool(deps: SearchDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Search raw events",
    description: DESCRIPTION,
    parameters: toJsonSchema(searchEventsSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<SearchEventsDetails>> {
      const input = searchEventsSchema.parse(rawParams);

      const wheres: string[] = [];
      const bindings: unknown[] = [];

      if (input.query) {
        wheres.push("source_summary LIKE ? COLLATE NOCASE");
        bindings.push(`%${input.query}%`);
      }
      if (input.event_type) {
        wheres.push("event_type = ?");
        bindings.push(input.event_type);
      }
      if (input.status) {
        wheres.push("status = ?");
        bindings.push(input.status);
      }
      if (input.since) {
        wheres.push("created_at >= ?");
        bindings.push(input.since);
      }
      if (input.until) {
        wheres.push("created_at <= ?");
        bindings.push(input.until);
      }

      const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, HARD_LIMIT);
      bindings.push(limit);

      const sql = `
        SELECT id, status, event_type, capability_name, source_summary,
               event_occurred_at, created_at, extraction_confidence
          FROM raw_events
          ${whereSql}
         ORDER BY (committed_at IS NULL) ASC, committed_at DESC, created_at DESC
         LIMIT ?
      `;
      const rows = deps.db.prepare(sql).all(...bindings) as RawSearchRow[];
      const results: SearchEventsResultRow[] = rows.map((r) => ({
        event_id: r.id,
        status: r.status,
        event_type: r.event_type,
        capability_name: r.capability_name,
        source_summary: r.source_summary,
        event_occurred_at: r.event_occurred_at,
        created_at: r.created_at,
        extraction_confidence: r.extraction_confidence,
      }));

      return payloadTextResult<SearchEventsDetails>({
        count: results.length,
        results,
      });
    },
  };
}
