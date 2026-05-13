/**
 * `strata_query_table` — controlled read-only query surface over a
 * capability's business table. Agent provides structured params (no raw
 * SQL); the tool validates every column reference against
 * `PRAGMA table_info(primary_table)`, parameterises every value, and
 * hard-caps `limit` at 100.
 *
 * See `openspec/changes/add-query-skill/specs/query-skill/spec.md`.
 */
import type Database from "better-sqlite3";

import { z } from "zod";

import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { Logger } from "../core/logger.js";
import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

const HARD_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const COLUMN_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

const AggregateFn = z.enum(["sum", "count", "avg", "min", "max"]);

export const queryTableSchema = z.object({
  capability_name: z
    .string()
    .min(1)
    .describe("Capability whose primary_table is queried; resolved via the registry."),
  filter: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Equality predicates: { column_name: value } → WHERE column = ? AND …"),
  since: z
    .string()
    .min(1)
    .optional()
    .describe("ISO 8601 — filter `occurred_at >= since`."),
  until: z
    .string()
    .min(1)
    .optional()
    .describe("ISO 8601 — filter `occurred_at <= until`."),
  order_by: z
    .string()
    .regex(COLUMN_NAME_RE)
    .optional()
    .describe("Column to ORDER BY."),
  order_direction: z.enum(["asc", "desc"]).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HARD_LIMIT)
    .optional()
    .describe(`Default ${DEFAULT_LIMIT}; hard cap ${HARD_LIMIT}.`),
  select: z
    .array(z.string().regex(COLUMN_NAME_RE))
    .min(1)
    .optional()
    .describe("Subset of columns to return. Default: all."),
  aggregate: z
    .object({
      fn: AggregateFn,
      column: z.string().regex(COLUMN_NAME_RE),
    })
    .optional()
    .describe(
      "One aggregate per call. count ignores `column`. When set, the response carries `aggregate` instead of `rows`.",
    ),
});

export type QueryTableInput = z.infer<typeof queryTableSchema>;

export interface QueryTableDetails {
  capability_name: string;
  rows?: Array<Record<string, unknown>>;
  count: number;
  aggregate?: {
    fn: "sum" | "count" | "avg" | "min" | "max";
    column: string;
    value: number | null;
  };
}

interface QueryTableInternalDeps {
  db: Database.Database;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  logger: Logger;
}

const NAME = "strata_query_table";
const DESCRIPTION = `Read-only structured query over a capability's business table.

Use for:
- Aggregates ("last month's total spend"): supply { aggregate: { fn: 'sum', column: 'amount_minor' }, since: ..., filter: { category: 'dining' } }.
- Filtered listings ("top 5 most recent transports"): supply { filter: { category: 'transport' }, order_by: 'occurred_at', order_direction: 'desc', limit: 5 }.
- Counts ("how many workouts this week"): { aggregate: { fn: 'count', column: 'id' }, since: '<week start>' }.

Do NOT use for:
- Searching the raw_events ledger (use strata_search_events).
- Reading messages directly.
- Mutations of any kind (this tool is read-only).

The tool validates every column reference against the live schema; unknown columns trigger a clear error.`;

interface ColumnInfo {
  name: string;
  type: string;
}

function listColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.map((r) => r.name);
}

function assertKnownColumn(col: string, known: Set<string>, label: string): void {
  if (!COLUMN_NAME_RE.test(col)) {
    throw new Error(`${label} '${col}' contains invalid characters`);
  }
  if (!known.has(col)) {
    throw new Error(`${label} '${col}' is not a column of the target table`);
  }
}

export function queryTableTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Query capability table",
    description: DESCRIPTION,
    parameters: toJsonSchema(queryTableSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<QueryTableDetails>> {
      const input = queryTableSchema.parse(rawParams);
      if (!deps.queryDeps) {
        throw new Error(
          "strata_query_table requires deps.queryDeps — runtime did not wire them",
        );
      }
      const queryDeps = deps.queryDeps;
      const cap = await queryDeps.capabilityRegistryRepo.findById(input.capability_name);
      if (!cap) {
        throw new Error(
          `capability '${input.capability_name}' is not registered (or not active)`,
        );
      }
      if (cap.status !== "active") {
        throw new Error(
          `capability '${input.capability_name}' status is '${cap.status}' — only 'active' capabilities can be queried`,
        );
      }

      const columns = new Set(listColumns(queryDeps.db, cap.primary_table));
      if (columns.size === 0) {
        throw new Error(
          `capability '${input.capability_name}' primary_table '${cap.primary_table}' has no columns (does the table exist?)`,
        );
      }

      // Validate references.
      if (input.filter) {
        for (const k of Object.keys(input.filter)) {
          assertKnownColumn(k, columns, "filter column");
        }
      }
      if (input.order_by) {
        assertKnownColumn(input.order_by, columns, "order_by");
      }
      if (input.select) {
        for (const c of input.select) {
          assertKnownColumn(c, columns, "select column");
        }
      }
      if (input.aggregate) {
        assertKnownColumn(input.aggregate.column, columns, "aggregate column");
      }
      const hasOccurredAt = columns.has("occurred_at");
      if ((input.since || input.until) && !hasOccurredAt) {
        throw new Error(
          `since/until requires an 'occurred_at' column on ${cap.primary_table}`,
        );
      }

      const wheres: string[] = [];
      const bindings: unknown[] = [];
      if (input.filter) {
        for (const [k, v] of Object.entries(input.filter)) {
          if (v === null) {
            wheres.push(`${k} IS NULL`);
          } else {
            wheres.push(`${k} = ?`);
            bindings.push(v);
          }
        }
      }
      if (input.since) {
        wheres.push("occurred_at >= ?");
        bindings.push(input.since);
      }
      if (input.until) {
        wheres.push("occurred_at <= ?");
        bindings.push(input.until);
      }
      const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

      // Aggregate path.
      if (input.aggregate) {
        const { fn, column } = input.aggregate;
        const expr =
          fn === "count" ? "COUNT(*)" : `${fn.toUpperCase()}(${column})`;
        const sql = `SELECT ${expr} AS value FROM ${cap.primary_table} ${whereSql}`;
        const row = queryDeps.db.prepare(sql).get(...bindings) as { value: unknown };
        const value =
          typeof row.value === "number" || row.value === null
            ? (row.value as number | null)
            : Number(row.value);
        return payloadTextResult<QueryTableDetails>({
          capability_name: cap.name,
          count: 1,
          aggregate: { fn, column, value },
        });
      }

      // Row path.
      const selectCols = input.select ?? Array.from(columns);
      const orderSql = input.order_by
        ? `ORDER BY ${input.order_by} ${input.order_direction === "asc" ? "ASC" : "DESC"}`
        : "";
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, HARD_LIMIT);
      bindings.push(limit);
      const sql = `
        SELECT ${selectCols.join(", ")}
          FROM ${cap.primary_table}
          ${whereSql}
          ${orderSql}
         LIMIT ?
      `;
      const rows = queryDeps.db.prepare(sql).all(...bindings) as Array<Record<string, unknown>>;
      return payloadTextResult<QueryTableDetails>({
        capability_name: cap.name,
        rows,
        count: rows.length,
      });
    },
  };
}
