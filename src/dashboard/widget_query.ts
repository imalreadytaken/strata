/**
 * `executeWidgetQuery` — shared query engine for dashboard widgets.
 *
 * Mirrors `strata_query_table`'s posture: resolve capability via the
 * registry, validate every column reference against the live schema, and
 * bind every value through `?` placeholders. Returns either
 * `{ aggregate }` (when `query.aggregate` is set) or `{ rows }`.
 */
import type Database from "better-sqlite3";

import type { Logger } from "../core/logger.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { WidgetQuery } from "./types.js";

const HARD_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 5;
const COLUMN_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

export interface WidgetQueryDeps {
  db: Database.Database;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  logger: Logger;
}

export interface WidgetAggregateResult {
  aggregate: {
    fn: "sum" | "count" | "avg" | "min" | "max";
    column: string;
    value: number | null;
  };
  primary_table: string;
}

export interface WidgetRowsResult {
  rows: Array<Record<string, unknown>>;
  primary_table: string;
}

export type WidgetResult = WidgetAggregateResult | WidgetRowsResult;

function listColumns(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function assertKnownColumn(
  col: string,
  known: Set<string>,
  label: string,
): void {
  if (!COLUMN_NAME_RE.test(col)) {
    throw new Error(`${label} '${col}' contains invalid characters`);
  }
  if (!known.has(col)) {
    throw new Error(`${label} '${col}' is not a column of the target table`);
  }
}

export async function executeWidgetQuery(
  deps: WidgetQueryDeps,
  capability_name: string,
  query: WidgetQuery,
): Promise<WidgetResult> {
  const cap = await deps.capabilityRegistryRepo.findById(capability_name);
  if (!cap) {
    throw new Error(
      `capability '${capability_name}' is not registered (or not active)`,
    );
  }
  if (cap.status !== "active") {
    throw new Error(
      `capability '${capability_name}' status is '${cap.status}' — only 'active' capabilities can be queried`,
    );
  }

  const columns = new Set(listColumns(deps.db, cap.primary_table));
  if (columns.size === 0) {
    throw new Error(
      `capability '${capability_name}' primary_table '${cap.primary_table}' has no columns (does the table exist?)`,
    );
  }

  if (query.filter) {
    for (const k of Object.keys(query.filter)) {
      assertKnownColumn(k, columns, "filter column");
    }
  }
  if (query.order_by) {
    assertKnownColumn(query.order_by, columns, "order_by");
  }
  if (query.select) {
    for (const c of query.select) {
      assertKnownColumn(c, columns, "select column");
    }
  }
  if (query.aggregate) {
    if (query.aggregate.fn !== "count") {
      assertKnownColumn(query.aggregate.column, columns, "aggregate column");
    }
  }

  const hasOccurredAt = columns.has("occurred_at");
  if ((query.since || query.until) && !hasOccurredAt) {
    throw new Error(
      `since/until requires an 'occurred_at' column on ${cap.primary_table}`,
    );
  }

  const wheres: string[] = [];
  const bindings: unknown[] = [];
  if (query.filter) {
    for (const [k, v] of Object.entries(query.filter)) {
      if (v === null) {
        wheres.push(`${k} IS NULL`);
      } else {
        wheres.push(`${k} = ?`);
        bindings.push(v);
      }
    }
  }
  if (query.since) {
    wheres.push("occurred_at >= ?");
    bindings.push(query.since);
  }
  if (query.until) {
    wheres.push("occurred_at <= ?");
    bindings.push(query.until);
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  if (query.aggregate) {
    const { fn, column } = query.aggregate;
    const expr =
      fn === "count" ? "COUNT(*)" : `${fn.toUpperCase()}(${column})`;
    const sql = `SELECT ${expr} AS value FROM ${cap.primary_table} ${whereSql}`;
    const row = deps.db.prepare(sql).get(...bindings) as { value: unknown };
    const value =
      typeof row.value === "number" || row.value === null
        ? (row.value as number | null)
        : Number(row.value);
    return {
      aggregate: { fn, column, value },
      primary_table: cap.primary_table,
    };
  }

  const selectCols = query.select ?? Array.from(columns);
  const orderSql = query.order_by
    ? `ORDER BY ${query.order_by} ${query.order_direction === "asc" ? "ASC" : "DESC"}`
    : "";
  const limit = Math.min(query.limit ?? DEFAULT_LIST_LIMIT, HARD_LIMIT);
  bindings.push(limit);
  const sql = `
    SELECT ${selectCols.join(", ")}
      FROM ${cap.primary_table}
      ${whereSql}
      ${orderSql}
     LIMIT ?
  `;
  const rows = deps.db
    .prepare(sql)
    .all(...bindings) as Array<Record<string, unknown>>;
  return { rows, primary_table: cap.primary_table };
}
