/**
 * Markdown renderer for capability dashboards.
 *
 * Produces a Telegram-friendly text payload — no HTML, no images. Each
 * capability becomes a block; widgets within a block are either KPI bullets
 * or numbered lists. Per-widget failures render inline as `⚠️ <error>`; the
 * surrounding widgets still resolve.
 */
import type Database from "better-sqlite3";

import type { Logger } from "../core/logger.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { DashboardRegistry } from "./registry.js";
import type { Widget, WidgetFormat } from "./types.js";
import {
  executeWidgetQuery,
  type WidgetResult,
} from "./widget_query.js";

export interface RenderDashboardDeps {
  db: Database.Database;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  dashboardRegistry: DashboardRegistry;
  logger: Logger;
}

export interface RenderDashboardResult {
  markdown: string;
  capability_count: number;
  widget_count: number;
}

const CURRENCY_SIGN: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  JPY: "¥",
  GBP: "£",
};

function currencyPrefix(code: string): string {
  return CURRENCY_SIGN[code] ?? "";
}

function formatCount(value: number | null): string {
  if (value === null) return "0";
  return Math.round(value).toLocaleString("en-US");
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return String(value);
  return value.slice(0, 10);
}

function formatText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * `currency` arg is the row's currency value (or `null`). We display
 * `<prefix><amount>.<dd> (<code>)` so it's unambiguous even when two
 * widgets in the same block reference different currencies.
 */
function formatMoney(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const code = currency && currency.length > 0 ? currency : "CNY";
  const prefix = currencyPrefix(code);
  const amount = (value / 100).toFixed(2);
  return `${prefix}${amount} (${code})`;
}

function applyFormat(
  format: WidgetFormat,
  value: unknown,
  currency: string | null,
): string {
  switch (format) {
    case "money": {
      const n = typeof value === "number" ? value : value === null ? null : Number(value);
      return formatMoney(Number.isFinite(n as number) ? (n as number) : null, currency);
    }
    case "count":
      return formatCount(
        typeof value === "number" ? value : value === null ? null : Number(value),
      );
    case "date":
      return formatDate(value);
    case "text":
    default:
      return formatText(value);
  }
}

function pickRowCurrency(rows: Array<Record<string, unknown>>): string | null {
  for (const r of rows) {
    if (typeof r.currency === "string" && r.currency.length > 0) {
      return r.currency;
    }
  }
  return null;
}

async function renderWidget(
  deps: RenderDashboardDeps,
  capability_name: string,
  widget: Widget,
): Promise<string> {
  const format: WidgetFormat = widget.format ?? "text";
  let result: WidgetResult;
  try {
    result = await executeWidgetQuery(
      {
        db: deps.db,
        capabilityRegistryRepo: deps.capabilityRegistryRepo,
        logger: deps.logger,
      },
      capability_name,
      widget.query,
    );
  } catch (err) {
    return `• ${widget.title}: ⚠️ ${(err as Error).message}`;
  }

  if (widget.kind === "kpi") {
    const aggValue =
      "aggregate" in result ? result.aggregate.value : null;
    // For `money` we need a currency. Pull it from the first row of the
    // primary table (cheap one-shot SELECT) when the table has a currency column.
    let currency: string | null = null;
    if (format === "money") {
      try {
        const row = deps.db
          .prepare(
            `SELECT currency FROM ${result.primary_table} LIMIT 1`,
          )
          .get() as { currency?: string } | undefined;
        currency = row?.currency ?? null;
      } catch {
        currency = null;
      }
    }
    return `• ${widget.title}: ${applyFormat(format, aggValue, currency)}`;
  }

  // list widget
  const rows = "rows" in result ? result.rows : [];
  if (rows.length === 0) {
    return `*${widget.title}*\n  _(no rows)_`;
  }
  const currency = pickRowCurrency(rows);
  const lines = rows.map((row, idx) => {
    const text = summariseRow(row, format, currency);
    return `${idx + 1}. ${text}`;
  });
  return `*${widget.title}*\n${lines.join("\n")}`;
}

/**
 * Choose 1–3 representative fields from a row and format them inline.
 * Priority: the row's most-text-like identifier (merchant / title / name),
 * a money field if present, an `occurred_at` date.
 */
function summariseRow(
  row: Record<string, unknown>,
  format: WidgetFormat,
  currency: string | null,
): string {
  const parts: string[] = [];
  const labelKey = ["merchant", "title", "name", "label", "subject"].find(
    (k) => typeof row[k] === "string" && (row[k] as string).length > 0,
  );
  if (labelKey) parts.push(String(row[labelKey]));

  const moneyKey = Object.keys(row).find((k) => k.endsWith("_minor"));
  if (moneyKey && typeof row[moneyKey] === "number") {
    parts.push(formatMoney(row[moneyKey] as number, currency));
  }

  if (typeof row.occurred_at === "string") {
    parts.push(formatDate(row.occurred_at));
  }

  if (parts.length > 0) return parts.join(" – ");
  // Fallback: stringify whichever fields are present.
  const compact = Object.entries(row)
    .filter(([k]) => k !== "id" && k !== "raw_event_id" && k !== "created_at" && k !== "updated_at")
    .map(([k, v]) => `${k}=${applyFormat(format, v, currency)}`)
    .slice(0, 3)
    .join(", ");
  return compact || "(empty row)";
}

/**
 * Render one or all capability dashboards as Telegram-friendly markdown.
 * `capability_name` undefined → every registered capability, alphabetised.
 */
export async function renderDashboard(
  deps: RenderDashboardDeps,
  capability_name?: string,
): Promise<RenderDashboardResult> {
  const log = deps.logger.child({ module: "dashboard.renderer" });

  const targets: Array<{ name: string; widgets: Widget[] }> = [];
  if (capability_name) {
    const d = deps.dashboardRegistry.get(capability_name);
    if (!d) {
      return {
        markdown: `*${capability_name}*\n(no dashboard widgets configured)`,
        capability_count: 0,
        widget_count: 0,
      };
    }
    targets.push({ name: capability_name, widgets: d.widgets });
  } else {
    for (const entry of deps.dashboardRegistry.list()) {
      targets.push({ name: entry.name, widgets: entry.dashboard.widgets });
    }
  }

  if (targets.length === 0) {
    return {
      markdown: "*No dashboards registered.*",
      capability_count: 0,
      widget_count: 0,
    };
  }

  const blocks: string[] = [];
  let widget_count = 0;
  for (const t of targets) {
    const widgetLines: string[] = [];
    for (const w of t.widgets) {
      const line = await renderWidget(deps, t.name, w);
      widgetLines.push(line);
      widget_count += 1;
    }
    blocks.push(`*${t.name}*\n\n${widgetLines.join("\n")}`);
  }

  log.debug("dashboard rendered", {
    capability_count: targets.length,
    widget_count,
  });

  return {
    markdown: blocks.join("\n\n---\n\n"),
    capability_count: targets.length,
    widget_count,
  };
}
