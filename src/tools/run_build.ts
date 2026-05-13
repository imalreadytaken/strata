/**
 * `strata_run_build` — agent-callable end-to-end build dispatcher.
 *
 * Given a `proposal_id`, looks up the proposal, runs `runBuild`, and (when
 * the orchestrator returns `ready_for_integration`) runs `runIntegration`.
 * Returns a tagged outcome the agent can quote back to the user.
 *
 * See `openspec/changes/add-build-trigger/specs/build-trigger/spec.md`.
 */
import { z } from "zod";

import {
  runBuild as defaultRunBuild,
  type BuildRunResult,
} from "../build/orchestrator.js";
import {
  runIntegration as defaultRunIntegration,
  type IntegrationResult,
} from "../build/integration.js";
import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const runBuildSchema = z.object({
  proposal_id: z
    .number()
    .int()
    .positive()
    .describe("`proposals.id` of the user-approved (or pending) build request."),
});

export type RunBuildInput = z.infer<typeof runBuildSchema>;

export interface RunBuildToolDetails {
  status:
    | "integrated"
    | "orchestrator_failed"
    | "integration_failed"
    | "cancelled"
    | "rejected";
  build_id?: number;
  failureReason?: string;
  integrated?: string[];
}

const NAME = "strata_run_build";
const DESCRIPTION = `Dispatch a Build Bridge run end-to-end for a previously recorded proposal.

Use when:
- The user explicitly asks Strata to build a previously-proposed capability.
- A proposal is in 'pending' or 'approved' status and you want to attempt the build now.

Do NOT use for:
- Recording a NEW build request (use strata_propose_capability first).
- Querying build history (no tool yet; future addition).

Returns a tagged status:
- 'integrated'             — full success; new capability is on disk + registered.
- 'orchestrator_failed'    — Claude Code phases failed; nothing integrated.
- 'integration_failed'     — orchestrator succeeded but integration failed.
- 'cancelled'              — the run was aborted (signal / cancel).
- 'rejected'               — refused before dispatch (bad proposal status, missing deps).
The 'failureReason' field carries the orchestrator/integration tag when present.`;

export function runBuildTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Run Build Bridge",
    description: DESCRIPTION,
    parameters: toJsonSchema(runBuildSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<RunBuildToolDetails>> {
      const input = runBuildSchema.parse(rawParams);

      if (!deps.buildDeps) {
        return payloadTextResult<RunBuildToolDetails>({
          status: "rejected",
          failureReason:
            "buildDeps not wired on EventToolDeps; the plugin entry needs to populate it before this tool can dispatch",
        });
      }

      const proposal = await deps.proposalsRepo.findById(input.proposal_id);
      if (!proposal) {
        return payloadTextResult<RunBuildToolDetails>({
          status: "rejected",
          failureReason: `proposal #${input.proposal_id} not found`,
        });
      }
      if (proposal.status !== "pending" && proposal.status !== "approved") {
        return payloadTextResult<RunBuildToolDetails>({
          status: "rejected",
          failureReason: `proposal #${input.proposal_id} status is '${proposal.status}'; can only dispatch 'pending' or 'approved'`,
        });
      }

      const buildDeps = deps.buildDeps;
      const runBuildFn = buildDeps.runBuild ?? defaultRunBuild;
      const runIntegrationFn = buildDeps.runIntegration ?? defaultRunIntegration;

      // Create a fresh AbortController so `strata_stop_build` can fire the
      // signal during plan/decompose/apply phases. The registry is optional
      // — when undefined the build is just un-stoppable. We track the
      // assigned build_id so `complete` runs in the finally below.
      const controller = new AbortController();
      const registry = buildDeps.buildSessionRegistry;
      let registeredBuildId: number | undefined;

      try {
        const buildResult: BuildRunResult = await runBuildFn({
          proposalId: input.proposal_id,
          sessionId: `tool:${deps.sessionId}`,
          signal: controller.signal,
          ...(registry
            ? {
                onBuildIdAssigned: (buildId: number) => {
                  registeredBuildId = buildId;
                  registry.register(buildId, controller, `tool:${deps.sessionId}`);
                },
              }
            : {}),
          deps: {
            buildsRepo: buildDeps.buildsRepo,
            proposalsRepo: deps.proposalsRepo,
            capabilityRegistryRepo: buildDeps.capabilityRegistryRepo,
            capabilities: buildDeps.capabilities,
            agentsMdSource: buildDeps.agentsMdSource,
            buildsDir: buildDeps.buildsDir,
            maxTurnsPerPhase: buildDeps.maxTurnsPerPhase,
            logger: deps.logger,
            ...(buildDeps.progressForwarder
              ? { progressForwarder: buildDeps.progressForwarder }
              : {}),
          },
        });

        if (buildResult.status === "failed") {
          return payloadTextResult<RunBuildToolDetails>({
            status: "orchestrator_failed",
            build_id: buildResult.build_id,
            failureReason: buildResult.failureReason,
          });
        }
        if (buildResult.status === "cancelled") {
          return payloadTextResult<RunBuildToolDetails>({
            status: "cancelled",
            build_id: buildResult.build_id,
          });
        }

        const integrationResult: IntegrationResult = await runIntegrationFn({
          buildResult,
          deps: {
            buildsRepo: buildDeps.buildsRepo,
            proposalsRepo: deps.proposalsRepo,
            capabilityRegistryRepo: buildDeps.capabilityRegistryRepo,
            capabilityHealthRepo: buildDeps.capabilityHealthRepo,
            schemaEvolutionsRepo: buildDeps.schemaEvolutionsRepo,
            db: buildDeps.db,
            userCapabilitiesDir: buildDeps.userCapabilitiesDir,
            logger: deps.logger,
          },
        });

        if (integrationResult.status === "integrated") {
          return payloadTextResult<RunBuildToolDetails>({
            status: "integrated",
            build_id: integrationResult.build_id,
            integrated: integrationResult.integrated.map((c) => c.name),
          });
        }
        return payloadTextResult<RunBuildToolDetails>({
          status: "integration_failed",
          build_id: integrationResult.build_id,
          failureReason: integrationResult.failureReason,
          integrated: integrationResult.integrated.map((c) => c.name),
        });
      } finally {
        // Deregister regardless of outcome — every terminal status, plus
        // any thrown exception, must clear the registry slot so future
        // builds with the same id don't see stale controllers.
        if (registry && registeredBuildId !== undefined) {
          registry.complete(registeredBuildId);
        }
      }
    },
  };
}

