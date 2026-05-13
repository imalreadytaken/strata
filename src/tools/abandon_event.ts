/**
 * `strata_abandon_event` — transition a pending raw_event to `abandoned`,
 * stamp `abandoned_reason`, drain the buffer. Symmetrical to commit.
 *
 * See `STRATA_SPEC.md` §5.3.5.
 */
import { z } from "zod";

import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const abandonEventSchema = z.object({
  event_id: z
    .number()
    .int()
    .describe("raw_events.id of the pending row to abandon."),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Free-text abandoned_reason; defaults to 'user_declined' when omitted.",
    ),
});

export type AbandonEventInput = z.infer<typeof abandonEventSchema>;

export interface AbandonEventDetails {
  event_id: number;
  status: "abandoned";
  reason: string;
}

const DEFAULT_REASON = "user_declined";

const NAME = "strata_abandon_event";
const DESCRIPTION = `Abandon a pending raw_event so it is never persisted as a fact.

Use when:
- The user explicitly declines ("不记", "no", "cancel")
- The agent realises the event is a duplicate or test record

Refuses if the event is not currently in 'pending' state.`;

export function abandonEventTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Abandon pending event",
    description: DESCRIPTION,
    parameters: toJsonSchema(abandonEventSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<AbandonEventDetails>> {
      const input = abandonEventSchema.parse(rawParams);
      const current = await deps.rawEventsRepo.findById(input.event_id);
      if (!current) {
        throw new Error(`raw_event #${input.event_id} not found`);
      }
      if (current.status !== "pending") {
        throw new Error(
          `raw_event #${input.event_id} is not in pending state (current: ${current.status})`,
        );
      }

      const reason = input.reason ?? DEFAULT_REASON;
      const now = new Date().toISOString();
      const updated = await deps.rawEventsRepo.update(input.event_id, {
        status: "abandoned",
        abandoned_reason: reason,
        updated_at: now,
      });

      try {
        await deps.pendingBuffer.remove(current.session_id, input.event_id);
      } catch (err) {
        deps.logger
          .child({ module: "tools.abandon_event" })
          .warn("pendingBuffer.remove failed; timeout loop will reconcile", {
            session_id: current.session_id,
            event_id: input.event_id,
            error: (err as Error).message,
          });
      }

      return payloadTextResult<AbandonEventDetails>({
        event_id: updated.id,
        status: "abandoned",
        reason,
      });
    },
  };
}
