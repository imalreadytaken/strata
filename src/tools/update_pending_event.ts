/**
 * `strata_update_pending_event` — merge a patch into a pending raw_events
 * row's `extracted_data`, append the follow-up message id to
 * `related_message_ids`, optionally replace `source_summary`. Refuses if
 * the row is not in `pending` state.
 *
 * See `STRATA_SPEC.md` §5.3.2.
 */
import { z } from "zod";

import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const updatePendingEventSchema = z.object({
  event_id: z.number().int().describe("raw_events.id to update."),
  patch: z
    .record(z.string(), z.unknown())
    .describe("Fields to merge into the existing extracted_data."),
  new_summary: z
    .string()
    .min(1)
    .optional()
    .describe("Replace source_summary when present."),
  related_message_id: z
    .number()
    .int()
    .describe("messages.id of the follow-up message — appended to related_message_ids."),
});

export type UpdatePendingEventInput = z.infer<typeof updatePendingEventSchema>;

export interface UpdatePendingEventDetails {
  event_id: number;
  status: "updated";
  summary: string;
}

const NAME = "strata_update_pending_event";
const DESCRIPTION = `Update fields of an existing pending raw_event.

Use when:
- The user adds more details to a recently created pending event
- The user corrects a field while the event is still pending
  ("不对，是 ¥48 不是 ¥45")

Refuses if the event is not currently in 'pending' state — for
cross-session corrections of committed rows, use strata_supersede_event.`;

export function updatePendingEventTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Update pending event",
    description: DESCRIPTION,
    parameters: toJsonSchema(updatePendingEventSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<UpdatePendingEventDetails>> {
      const input = updatePendingEventSchema.parse(rawParams);
      const current = await deps.rawEventsRepo.findById(input.event_id);
      if (!current) {
        throw new Error(`raw_event #${input.event_id} not found`);
      }
      if (current.status !== "pending") {
        throw new Error(
          `raw_event #${input.event_id} is not in pending state (current: ${current.status})`,
        );
      }

      const mergedData = {
        ...(JSON.parse(current.extracted_data) as Record<string, unknown>),
        ...input.patch,
      };
      const relatedIds = JSON.parse(current.related_message_ids) as number[];
      const nextRelated = relatedIds.includes(input.related_message_id)
        ? relatedIds
        : [...relatedIds, input.related_message_id];

      const now = new Date().toISOString();
      const updated = await deps.rawEventsRepo.update(input.event_id, {
        extracted_data: JSON.stringify(mergedData),
        related_message_ids: JSON.stringify(nextRelated),
        source_summary: input.new_summary ?? current.source_summary,
        updated_at: now,
      });

      return payloadTextResult<UpdatePendingEventDetails>({
        event_id: updated.id,
        status: "updated",
        summary: updated.source_summary,
      });
    },
  };
}
