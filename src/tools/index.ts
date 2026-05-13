/**
 * Barrel + plugin-side registration for the six `strata_*` event tools.
 *
 * `registerEventTools(api, runtime)` is called from `src/index.ts::register`
 * after the message hooks and pending-buffer timeout loop are wired. Each
 * tool registers via `api.registerTool(factory)`; the factory receives the
 * per-session `OpenClawPluginToolContext` so `sessionId` is captured at
 * session start, not at module load.
 *
 * See `openspec/changes/add-event-tools/specs/event-tools/spec.md`.
 */
import type {
  OpenClawPluginApi,
  AnyAgentTool as SdkAnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

import type { StrataRuntime } from "../runtime.js";
import { abandonEventTool } from "./abandon_event.js";
import { commitEventTool } from "./commit_event.js";
import { createPendingEventTool } from "./create_pending_event.js";
import { proposeCapabilityTool } from "./propose_capability.js";
import { queryTableTool } from "./query_table.js";
import { renderDashboardTool } from "./render_dashboard.js";
import { runBuildTool } from "./run_build.js";
import { searchEventsTool } from "./search_events.js";
import { stopBuildTool } from "./stop_build.js";
import { supersedeEventTool } from "./supersede_event.js";
import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { updatePendingEventTool } from "./update_pending_event.js";

const DEFAULT_SESSION_ID = "default";

export {
  createPendingEventTool,
  type CreatePendingEventInput,
  type CreatePendingEventDetails,
  createPendingEventSchema,
} from "./create_pending_event.js";
export {
  updatePendingEventTool,
  type UpdatePendingEventInput,
  type UpdatePendingEventDetails,
  updatePendingEventSchema,
} from "./update_pending_event.js";
export {
  commitEventTool,
  commitEventCore,
  type CommitEventInput,
  type CommitEventDetails,
  commitEventSchema,
} from "./commit_event.js";
export {
  supersedeEventTool,
  type SupersedeEventInput,
  type SupersedeEventDetails,
  supersedeEventSchema,
} from "./supersede_event.js";
export {
  abandonEventTool,
  type AbandonEventInput,
  type AbandonEventDetails,
  abandonEventSchema,
} from "./abandon_event.js";
export {
  searchEventsTool,
  type SearchEventsInput,
  type SearchEventsDetails,
  type SearchEventsResultRow,
  searchEventsSchema,
} from "./search_events.js";
export {
  proposeCapabilityTool,
  type ProposeCapabilityInput,
  type ProposeCapabilityDetails,
  proposeCapabilitySchema,
} from "./propose_capability.js";
export {
  runBuildTool,
  type RunBuildInput,
  type RunBuildToolDetails,
  runBuildSchema,
} from "./run_build.js";
export {
  queryTableTool,
  type QueryTableInput,
  type QueryTableDetails,
  queryTableSchema,
} from "./query_table.js";
export {
  renderDashboardTool,
  type RenderDashboardInput,
  type RenderDashboardDetails,
  renderDashboardSchema,
} from "./render_dashboard.js";
export {
  stopBuildTool,
  type StopBuildInput,
  type StopBuildDetails,
  stopBuildSchema,
} from "./stop_build.js";
export type {
  AnyAgentTool,
  BuildToolDeps,
  DashboardToolDeps,
  EventToolDeps,
  QueryToolDeps,
} from "./types.js";

/**
 * Build the six tool objects for a given session-bound deps bundle. Exported
 * for the plugin-entry tests which exercise the factory directly.
 */
export function buildEventTools(
  deps: EventToolDeps & {
    db: import("better-sqlite3").Database;
  },
): AnyAgentTool[] {
  return [
    createPendingEventTool(deps),
    updatePendingEventTool(deps),
    commitEventTool(deps),
    supersedeEventTool(deps),
    abandonEventTool(deps),
    searchEventsTool(deps),
    proposeCapabilityTool(deps),
    runBuildTool(deps),
    queryTableTool(deps),
    renderDashboardTool(deps),
    stopBuildTool(deps),
  ];
}

/**
 * Register all six `strata_*` agent tools with the OpenClaw API. Each tool
 * is exposed via an `OpenClawPluginToolFactory` so per-session context is
 * fresh on every session.
 */
export function registerEventTools(
  api: OpenClawPluginApi,
  runtime: StrataRuntime,
): void {
  api.registerTool((ctx: OpenClawPluginToolContext) => {
    const sessionId = ctx.sessionId ?? DEFAULT_SESSION_ID;
    if (!ctx.sessionId) {
      runtime.logger
        .child({ module: "tools.register" })
        .warn(
          "OpenClawPluginToolContext has no sessionId; falling back to 'default'",
        );
    }
    const deps: EventToolDeps & { db: import("better-sqlite3").Database } = {
      rawEventsRepo: runtime.rawEventsRepo,
      proposalsRepo: runtime.proposalsRepo,
      pendingBuffer: runtime.pendingBuffer,
      logger: runtime.logger,
      sessionId,
      db: runtime.db,
      pipelineDeps: {
        db: runtime.db,
        registry: runtime.capabilities,
        rawEventsRepo: runtime.rawEventsRepo,
        capabilityHealthRepo: runtime.capabilityHealthRepo,
        logger: runtime.logger,
      },
      buildDeps: {
        db: runtime.db,
        buildsRepo: runtime.buildsRepo,
        capabilityRegistryRepo: runtime.capabilityRegistryRepo,
        capabilityHealthRepo: runtime.capabilityHealthRepo,
        schemaEvolutionsRepo: runtime.schemaEvolutionsRepo,
        capabilities: runtime.capabilities,
        agentsMdSource: runtime.agentsMdSource,
        buildsDir: runtime.config.paths.buildsDir,
        userCapabilitiesDir: runtime.config.paths.capabilitiesDir,
        maxTurnsPerPhase: 80,
        buildSessionRegistry: runtime.buildSessionRegistry,
      },
      queryDeps: {
        db: runtime.db,
        capabilityRegistryRepo: runtime.capabilityRegistryRepo,
        logger: runtime.logger,
      },
      dashboardDeps: {
        db: runtime.db,
        capabilityRegistryRepo: runtime.capabilityRegistryRepo,
        dashboardRegistry: runtime.dashboardRegistry,
        logger: runtime.logger,
      },
    };
    // Cast our locally-shaped `AnyAgentTool[]` to the SDK's deeper typed
    // shape; runtime fields match exactly (name/label/description/parameters/
    // execute). See `design.md` D1.
    return buildEventTools(deps) as unknown as SdkAnyAgentTool[];
  });
}
