/**
 * Barrel export for the dashboard subsystem.
 *
 * See `openspec/specs/dashboard/spec.md` (added by `add-dashboard`).
 */
export { DashboardRegistry } from "./registry.js";
export { loadCapabilityDashboard } from "./loader.js";
export type { LoadCapabilityDashboardArgs } from "./loader.js";
export {
  executeWidgetQuery,
  type WidgetQueryDeps,
  type WidgetAggregateResult,
  type WidgetRowsResult,
  type WidgetResult,
} from "./widget_query.js";
export {
  renderDashboard,
  type RenderDashboardDeps,
  type RenderDashboardResult,
} from "./renderer.js";
export {
  DashboardSchema,
  WidgetSchema,
  WidgetQuerySchema,
  type Dashboard,
  type Widget,
  type WidgetQuery,
  type WidgetKind,
  type WidgetFormat,
} from "./types.js";
