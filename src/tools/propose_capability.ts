/**
 * `strata_propose_capability` — record a user-driven build request as a
 * `proposals` row. Build Bridge (future) reads `proposals WHERE
 * status='pending' AND source='user_request'` to pick up the queue.
 *
 * Note: this writes to `proposals`, not `raw_events`. Build requests are
 * about the system, not about the user's life ledger.
 *
 * See `openspec/changes/add-build-skill/specs/build-skill/spec.md`.
 */
import { z } from "zod";

import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const proposeCapabilitySchema = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      "Short label, e.g. 'Track weight'. Used in dashboards + future build-orchestrator picker.",
    ),
  summary: z
    .string()
    .min(1)
    .describe(
      "One-sentence description of what the user wants. Used as the build's PLAN.md seed.",
    ),
  rationale: z
    .string()
    .min(1)
    .describe(
      "Why the user wants it — drawn from their message. Helps the orchestrator confirm the build is worth running.",
    ),
  target_capability: z
    .string()
    .min(1)
    .optional()
    .describe(
      "When the user is asking about an existing capability (rare for kind='new_capability'); omit otherwise.",
    ),
  estimated_time_minutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Agent's guess at build cost; informs the orchestrator scheduling."),
});

export type ProposeCapabilityInput = z.infer<typeof proposeCapabilitySchema>;

export interface ProposeCapabilityDetails {
  proposal_id: number;
  status: "pending";
}

const NAME = "strata_propose_capability";
const DESCRIPTION = `Record a user-driven build request as a row in 'proposals'.

Use when the user wants Strata to add a NEW capability to track something:
- "我想加个体重追踪"
- "track sleep for me"
- "记录梦境的能力"
- "/build add a journaling capability"

Do NOT use for:
- Modifications to an existing capability (a schema-evolution flow is not yet shipped — ask the user to phrase as a new domain).
- The user simply wants to LOG one fact (use strata_create_pending_event with the existing 'capture' skill).
- The user asks "what capabilities do I have?" (use strata_search_events / read-only path).

The proposal lands at status='pending', source='user_request',
kind='new_capability'. Build Bridge (when shipped) will scan pending
proposals and queue a co-build.`;

export function proposeCapabilityTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Propose new capability",
    description: DESCRIPTION,
    parameters: toJsonSchema(proposeCapabilitySchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<ProposeCapabilityDetails>> {
      const input = proposeCapabilitySchema.parse(rawParams);
      const now = new Date().toISOString();

      const row = await deps.proposalsRepo.insert({
        source: "user_request",
        kind: "new_capability",
        title: input.title,
        summary: input.summary,
        rationale: input.rationale,
        target_capability: input.target_capability ?? null,
        estimated_time_minutes: input.estimated_time_minutes ?? null,
        status: "pending",
        created_at: now,
      });

      return payloadTextResult<ProposeCapabilityDetails>({
        proposal_id: row.id,
        status: "pending",
      });
    },
  };
}
