/**
 * `strata_render_dashboard` — read-only tool that turns a capability's
 * dashboard.json widgets into Telegram-ready markdown the agent quotes back.
 *
 * When `capability_name` is omitted, every registered capability's
 * dashboard is rendered, joined by `---`. The tool is a thin wrapper over
 * `renderDashboard(deps, capability_name)` so the same engine powers
 * any future surface (cron, slash command, etc.).
 *
 * See `openspec/changes/add-dashboard/specs/dashboard/spec.md`.
 */
import { z } from "zod";

import { renderDashboard } from "../dashboard/renderer.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const renderDashboardSchema = z.object({
  capability_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Capability whose dashboard to render. Omit to render every registered capability, joined by `---`.",
    ),
});

export type RenderDashboardInput = z.infer<typeof renderDashboardSchema>;

export interface RenderDashboardDetails {
  markdown: string;
  capability_count: number;
  widget_count: number;
}

const NAME = "strata_render_dashboard";
const DESCRIPTION = `Render a capability's KPI / list widgets as Telegram-ready markdown.

Use when:
- The user asks "show me my expenses dashboard" / "本月概览" / "what's my <X> looking like".

How to read the response:
- \`details.markdown\` is the formatted block. Quote it verbatim to the user.
- \`details.widget_count\` tells you how much data the widget actually rendered (0 means the capability has no dashboard.json registered).

Limitations:
- Read-only. Do NOT mix with capture / supersede / abandon in the same turn.
- Currently text-only (Telegram markdown). No charts or images.`;

export function renderDashboardTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Render capability dashboard",
    description: DESCRIPTION,
    parameters: toJsonSchema(renderDashboardSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<RenderDashboardDetails>> {
      const input = renderDashboardSchema.parse(rawParams);
      if (!deps.dashboardDeps) {
        throw new Error(
          "strata_render_dashboard requires deps.dashboardDeps — runtime did not wire them",
        );
      }
      const result = await renderDashboard(
        deps.dashboardDeps,
        input.capability_name,
      );
      return payloadTextResult<RenderDashboardDetails>(result);
    },
  };
}
