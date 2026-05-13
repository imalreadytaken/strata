/**
 * Strata `dashboard.json` schema.
 *
 * A dashboard is an ordered list of widgets. Each widget either resolves to a
 * single number (`kind: 'kpi'`) or to a list of rows (`kind: 'list'`). The
 * widget's data comes from a strict subset of the `strata_query_table`
 * parameter set, so dashboards inherit the same column-validation +
 * `?`-binding posture used by the agent.
 *
 * See `openspec/changes/add-dashboard/specs/dashboard/spec.md`.
 */
import { z } from "zod";

const COLUMN_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
const HARD_LIMIT = 100;

const AggregateFn = z.enum(["sum", "count", "avg", "min", "max"]);

export const WidgetQuerySchema = z.object({
  filter: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  aggregate: z
    .object({
      fn: AggregateFn,
      column: z.string().regex(COLUMN_NAME_RE),
    })
    .optional(),
  order_by: z.string().regex(COLUMN_NAME_RE).optional(),
  order_direction: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(HARD_LIMIT).optional(),
  select: z.array(z.string().regex(COLUMN_NAME_RE)).min(1).optional(),
});

export type WidgetQuery = z.infer<typeof WidgetQuerySchema>;

/** Output formatter applied to a widget's resolved value(s). */
export const WidgetFormatSchema = z.enum(["money", "count", "date", "text"]);
export type WidgetFormat = z.infer<typeof WidgetFormatSchema>;

export const WidgetKindSchema = z.enum(["kpi", "list"]);
export type WidgetKind = z.infer<typeof WidgetKindSchema>;

export const WidgetSchema = z
  .object({
    kind: WidgetKindSchema,
    title: z.string().min(1),
    query: WidgetQuerySchema,
    format: WidgetFormatSchema.optional(),
  })
  .superRefine((widget, ctx) => {
    if (widget.kind === "kpi") {
      // KPI must resolve to a single value: either an aggregate or a text formatter.
      const format = widget.format ?? "text";
      if (format !== "text" && !widget.query.aggregate) {
        ctx.addIssue({
          code: "custom",
          message: `KPI widget '${widget.title}' requires query.aggregate when format='${format}'`,
        });
      }
    }
  });

export type Widget = z.infer<typeof WidgetSchema>;

export const DashboardSchema = z.object({
  widgets: z.array(WidgetSchema).min(1),
});

export type Dashboard = z.infer<typeof DashboardSchema>;
