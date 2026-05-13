/**
 * `strata_create_pending_event` — INSERT a `pending` raw_events row and
 * register it with the session-scoped pending buffer. The Capture skill
 * (next change) instructs the LLM to call this whenever the user shares
 * structured life data.
 *
 * See `openspec/changes/add-event-tools/specs/event-tools/spec.md` and
 * `STRATA_SPEC.md` §5.3.1.
 */
import { z } from "zod";

import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const createPendingEventSchema = z.object({
  event_type: z
    .string()
    .min(1)
    .describe(
      "Semantic kind: consumption | mood | workout | reading | health | asset | relation | unclassified | ...",
    ),
  capability_name: z
    .string()
    .min(1)
    .optional()
    .describe("Matching capability name when one is registered; omit otherwise."),
  extracted_data: z
    .record(z.string(), z.unknown())
    .describe("Structured payload extracted from the message; stored as JSON."),
  source_summary: z
    .string()
    .min(1)
    .describe("One-line user-facing summary."),
  event_occurred_at: z
    .string()
    .min(1)
    .optional()
    .describe("ISO 8601 with timezone if the user mentioned a specific time."),
  primary_message_id: z
    .number()
    .int()
    .describe("messages.id that triggered this event."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Extraction confidence; >= 0.7 is treated as auto-committable."),
});

export type CreatePendingEventInput = z.infer<typeof createPendingEventSchema>;

export interface CreatePendingEventDetails {
  event_id: number;
  status: "awaiting_confirmation";
  summary: string;
}

const NAME = "strata_create_pending_event";
const DESCRIPTION = `Create a pending raw_event awaiting user confirmation.

Use when the user has shared structured data that should be persisted
(consumption / workout / mood / reading / health / asset / relation / ...)
AND the event is clear enough to summarize.

Do NOT use for:
- Simple questions (use a query skill instead)
- Vague statements ("today was tough" without specifics)
- Build requests (use a build skill instead)`;

export function createPendingEventTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Create pending event",
    description: DESCRIPTION,
    parameters: toJsonSchema(createPendingEventSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<CreatePendingEventDetails>> {
      const input = createPendingEventSchema.parse(rawParams);
      const now = new Date().toISOString();

      const row = await deps.rawEventsRepo.insert({
        session_id: deps.sessionId,
        event_type: input.event_type,
        status: "pending",
        extracted_data: JSON.stringify(input.extracted_data),
        source_summary: input.source_summary,
        primary_message_id: input.primary_message_id,
        related_message_ids: JSON.stringify([input.primary_message_id]),
        event_occurred_at: input.event_occurred_at ?? null,
        capability_name: input.capability_name ?? null,
        extraction_version: 1,
        extraction_confidence: input.confidence,
        created_at: now,
        updated_at: now,
      });

      try {
        await deps.pendingBuffer.add(deps.sessionId, row.id);
      } catch (err) {
        deps.logger
          .child({ module: "tools.create_pending_event" })
          .warn("pendingBuffer.add failed; timeout loop will reconcile", {
            session_id: deps.sessionId,
            event_id: row.id,
            error: (err as Error).message,
          });
      }

      return payloadTextResult<CreatePendingEventDetails>({
        event_id: row.id,
        status: "awaiting_confirmation",
        summary: row.source_summary,
      });
    },
  };
}
