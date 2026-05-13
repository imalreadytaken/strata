/**
 * `strata_stop_build` — agent-callable abort for an in-flight Build Bridge run.
 *
 * Resolves the build via `buildsRepo.findById` (so `not_found` is distinct
 * from `not_running`), then fires the `AbortController` registered by
 * `strata_run_build`. The orchestrator's existing `abortIfNeeded` checks
 * between phases do the actual teardown.
 *
 * See `openspec/changes/add-build-stop/specs/build-stop/spec.md`.
 */
import { z } from "zod";

import { payloadTextResult, type ToolResult } from "./result.js";
import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const stopBuildSchema = z.object({
  build_id: z
    .number()
    .int()
    .positive()
    .describe("`builds.id` of the in-flight run to abort."),
});

export type StopBuildInput = z.infer<typeof stopBuildSchema>;

export interface StopBuildDetails {
  status: "stopped" | "not_running" | "not_found" | "rejected";
  build_id?: number;
  phase?: string;
  failureReason?: string;
}

const NAME = "strata_stop_build";
const DESCRIPTION = `Abort an in-flight Build Bridge run.

Use when:
- The user wants to halt a build they previously dispatched via strata_run_build.
- A long-running build appears wedged (no progress, runaway tokens).

Behaviour:
- 'stopped'      — the controller was fired; the orchestrator will mark the row 'cancelled' at its next phase boundary.
- 'not_running'  — the build exists but is no longer in the in-process registry (already finished, or it was started by another Strata instance).
- 'not_found'    — no row in 'builds' with that id.
- 'rejected'     — Strata isn't wired with a build session registry (test / partial deployment).

Stop is asynchronous: integration writes that are already in flight (DB inserts, capability dir creation) complete; the next phase boundary in the orchestrator returns 'cancelled'.`;

export function stopBuildTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Stop Build Bridge run",
    description: DESCRIPTION,
    parameters: toJsonSchema(stopBuildSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<StopBuildDetails>> {
      const input = stopBuildSchema.parse(rawParams);
      if (!deps.buildDeps) {
        return payloadTextResult<StopBuildDetails>({
          status: "rejected",
          failureReason: "buildDeps not wired on EventToolDeps",
        });
      }
      const registry = deps.buildDeps.buildSessionRegistry;
      if (!registry) {
        return payloadTextResult<StopBuildDetails>({
          status: "rejected",
          failureReason: "buildSessionRegistry not wired on buildDeps",
        });
      }
      const row = await deps.buildDeps.buildsRepo.findById(input.build_id);
      if (!row) {
        return payloadTextResult<StopBuildDetails>({
          status: "not_found",
        });
      }
      const result = registry.abort(input.build_id);
      if (result.stopped) {
        return payloadTextResult<StopBuildDetails>({
          status: "stopped",
          build_id: input.build_id,
        });
      }
      return payloadTextResult<StopBuildDetails>({
        status: "not_running",
        build_id: input.build_id,
        phase: row.phase,
      });
    },
  };
}
