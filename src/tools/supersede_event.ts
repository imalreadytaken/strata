/**
 * `strata_supersede_event` — cross-session correction of a committed
 * raw_event. INSERTs a new `committed` row with `supersedes_event_id`, then
 * marks the old row `superseded`. Both writes run inside a single SQLite
 * transaction so a partial failure rolls back cleanly.
 *
 * See `STRATA_SPEC.md` §5.3.4.
 */
import { z } from "zod";

import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const supersedeEventSchema = z.object({
  old_event_id: z
    .number()
    .int()
    .describe("The committed raw_event being corrected."),
  new_extracted_data: z
    .record(z.string(), z.unknown())
    .describe("Replacement structured payload."),
  new_summary: z
    .string()
    .min(1)
    .describe("Replacement one-line summary."),
  correction_message_id: z
    .number()
    .int()
    .describe("messages.id of the correction message."),
});

export type SupersedeEventInput = z.infer<typeof supersedeEventSchema>;

export interface SupersedeEventDetails {
  new_event_id: number;
  old_event_id: number;
  status: "superseded";
}

const NAME = "strata_supersede_event";
const DESCRIPTION = `Supersede an old committed event with new information.

Use for cross-session corrections of previously-recorded facts:
- "上周一咖啡其实是 ¥48 不是 ¥45"

First use strata_search_events to find the old event id.
The old row is marked 'superseded'; a new 'committed' row links back via
supersedes_event_id, preserving the audit trail.`;

export function supersedeEventTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Supersede committed event",
    description: DESCRIPTION,
    parameters: toJsonSchema(supersedeEventSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<SupersedeEventDetails>> {
      const input = supersedeEventSchema.parse(rawParams);
      const old = await deps.rawEventsRepo.findById(input.old_event_id);
      if (!old) {
        throw new Error(`raw_event #${input.old_event_id} not found`);
      }
      if (old.status !== "committed") {
        throw new Error(
          `can only supersede committed events; raw_event #${input.old_event_id} is '${old.status}'`,
        );
      }

      const now = new Date().toISOString();
      const newRowId = await deps.rawEventsRepo.transaction(async () => {
        const inserted = await deps.rawEventsRepo.insert({
          session_id: old.session_id,
          event_type: old.event_type,
          status: "committed",
          extracted_data: JSON.stringify(input.new_extracted_data),
          source_summary: input.new_summary,
          primary_message_id: input.correction_message_id,
          related_message_ids: JSON.stringify([input.correction_message_id]),
          event_occurred_at: old.event_occurred_at,
          capability_name: old.capability_name,
          extraction_version: old.extraction_version,
          extraction_confidence: old.extraction_confidence,
          supersedes_event_id: old.id,
          committed_at: now,
          created_at: now,
          updated_at: now,
        });

        await deps.rawEventsRepo.update(old.id, {
          status: "superseded",
          superseded_by_event_id: inserted.id,
          updated_at: now,
        });

        return inserted.id;
      });

      return payloadTextResult<SupersedeEventDetails>({
        new_event_id: newRowId,
        old_event_id: input.old_event_id,
        status: "superseded",
      });
    },
  };
}
