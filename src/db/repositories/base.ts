/**
 * Generic SQLite-backed implementation of the `Repository<T, ID>` contract.
 *
 * Builds parameterised `SELECT` / `INSERT` / `UPDATE` from a constructor-
 * supplied column list. better-sqlite3 is synchronous; we wrap return values
 * in `Promise.resolve(...)` so the interface stays uniform for any future
 * async adapter.
 *
 * Append-only tables (messages, raw_events, schema_evolutions,
 * reextract_jobs, capability_health) MUST override `softDelete` either to
 * throw a clearer error or to flip the appropriate column; the base impl
 * throws `StateMachineError('STRATA_E_STATE_TRANSITION', ...)` so a typo
 * never silently no-ops.
 */
import type Database from "better-sqlite3";

import {
  StateMachineError,
  ValidationError,
} from "../../core/errors.js";
import type { FindManyOptions, Repository } from "../repository.js";

export interface SQLiteRepositoryOptions {
  /** Override `() => new Date().toISOString()`. Useful for deterministic tests. */
  now?: () => string;
}

export class SQLiteRepository<T extends object, ID = number>
  implements Repository<T, ID> {
  protected readonly db: Database.Database;
  protected readonly table: string;
  /** Every non-PK column we will write to. Order matters for INSERT. */
  protected readonly columns: readonly string[];
  /** The primary-key column. Default: `'id'`. */
  protected readonly pkColumn: string;
  protected readonly now: () => string;

  constructor(
    db: Database.Database,
    table: string,
    columns: readonly string[],
    opts: SQLiteRepositoryOptions & { pkColumn?: string } = {},
  ) {
    this.db = db;
    this.table = table;
    this.columns = columns;
    this.pkColumn = opts.pkColumn ?? "id";
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** All column names this repo writes to, plus the PK column. */
  protected get allColumns(): readonly string[] {
    return this.pkColumn === "id" || this.columns.includes(this.pkColumn)
      ? this.columns.includes(this.pkColumn)
        ? this.columns
        : ["id", ...this.columns]
      : [this.pkColumn, ...this.columns];
  }

  async findById(id: ID): Promise<T | null> {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE ${this.pkColumn} = ? LIMIT 1`)
      .get(id as unknown as string | number);
    return (row ?? null) as T | null;
  }

  async findMany(
    filter: Partial<T> = {},
    options: FindManyOptions<T> = {},
  ): Promise<T[]> {
    const { sql, bindings } = this.buildWhere(filter);
    let query = `SELECT * FROM ${this.table}${sql}`;
    if (options.orderBy) {
      const dir = options.direction === "desc" ? "DESC" : "ASC";
      query += ` ORDER BY ${String(options.orderBy)} ${dir}`;
    }
    // SQLite requires LIMIT to be present when OFFSET is supplied; -1 means "no limit".
    if (options.limit !== undefined || options.offset !== undefined) {
      query += ` LIMIT ?`;
      bindings.push(options.limit ?? -1);
    }
    if (options.offset !== undefined) {
      query += ` OFFSET ?`;
      bindings.push(options.offset);
    }
    const rows = this.db.prepare(query).all(...bindings);
    return rows as T[];
  }

  async count(filter: Partial<T> = {}): Promise<number> {
    const { sql, bindings } = this.buildWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM ${this.table}${sql}`)
      .get(...bindings) as { c: number };
    return row.c;
  }

  async insert(data: Partial<T>): Promise<T> {
    const writable = this.allColumns;
    const cols: string[] = [];
    const placeholders: string[] = [];
    const bindings: unknown[] = [];

    for (const col of writable) {
      if (col === "id" && data[col as keyof T] === undefined) continue;
      if (col in data) {
        cols.push(col);
        placeholders.push("?");
        bindings.push((data as Record<string, unknown>)[col]);
      }
    }

    if (cols.length === 0) {
      throw new ValidationError(
        "STRATA_E_VALIDATION",
        `insert(${this.table}) requires at least one column`,
      );
    }

    const sql = `INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
    const row = this.db.prepare(sql).get(...bindings) as T;
    return row;
  }

  async update(id: ID, patch: Partial<T>): Promise<T> {
    const writable = new Set(this.columns);
    const keys = Object.keys(patch);

    for (const key of keys) {
      if (!writable.has(key)) {
        throw new ValidationError(
          "STRATA_E_VALIDATION",
          `update(${this.table}): unknown column '${key}'`,
        );
      }
    }

    if (keys.length === 0) {
      const existing = await this.findById(id);
      if (existing === null) {
        throw new ValidationError(
          "STRATA_E_VALIDATION",
          `update(${this.table}): row with ${this.pkColumn} = ${String(id)} not found`,
        );
      }
      return existing;
    }

    const setClauses = keys.map((k) => `${k} = ?`).join(", ");
    const bindings = keys.map((k) => (patch as Record<string, unknown>)[k]);
    bindings.push(id as unknown as string | number);
    const sql = `UPDATE ${this.table} SET ${setClauses} WHERE ${this.pkColumn} = ? RETURNING *`;
    const row = this.db.prepare(sql).get(...bindings) as T | undefined;
    if (!row) {
      throw new ValidationError(
        "STRATA_E_VALIDATION",
        `update(${this.table}): row with ${this.pkColumn} = ${String(id)} not found`,
      );
    }
    return row;
  }

  async softDelete(_id: ID): Promise<void> {
    throw new StateMachineError(
      "STRATA_E_STATE_TRANSITION",
      `softDelete is not supported on ${this.table} — override in the concrete repository to define semantics, or use update(...) to transition status explicitly.`,
    );
  }

  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    // better-sqlite3's `db.transaction(fn)` wrapper is synchronous — it cannot
    // wait on a Promise — so we manually issue BEGIN / COMMIT / ROLLBACK. The
    // SQLite connection holds the transaction open across awaits inside `fn`
    // because every statement runs on the same single connection; if `fn`
    // rejects we roll back everything done since BEGIN.
    this.db.exec("BEGIN");
    let result: R;
    try {
      result = await fn();
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.db.exec("COMMIT");
    return result;
  }

  /** Build `WHERE col1 = ? AND col2 = ?` from a Partial filter. */
  private buildWhere(filter: Partial<T>): {
    sql: string;
    bindings: unknown[];
  } {
    const entries = Object.entries(filter).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return { sql: "", bindings: [] };
    const sql =
      " WHERE " + entries.map(([k]) => `${k} = ?`).join(" AND ");
    const bindings = entries.map(([, v]) => v);
    return { sql, bindings };
  }
}
