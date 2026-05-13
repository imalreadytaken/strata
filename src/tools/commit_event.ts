/**
 * `strata_commit_event` — transition a pending raw_event to `committed`,
 * stamp `committed_at`, drain the pending buffer. The inline-keyboard
 * callback (next change, `add-callbacks`) calls `commitEventCore(...)`
 * directly to share this exact behaviour.
 *
 * See `STRATA_SPEC.md` §5.3.3.
 */
import { z } from "zod";

import { runPipelineForEvent } from "../capabilities/pipeline_runner.js";
import type { AnyAgentTool, EventToolDeps } from "./types.js";
import { payloadTextResult, type ToolResult } from "./result.js";
import { toJsonSchema } from "./zod_to_json_schema.js";

export const commitEventSchema = z.object({
  event_id: z.number().int().describe("raw_events.id of the pending row to commit."),
});

export type CommitEventInput = z.infer<typeof commitEventSchema>;

export interface CommitEventDetails {
  event_id: number;
  status: "committed";
  /**
   * `true` when the bound capability's pipeline successfully wrote a
   * business-table row. `false` for events without `capability_name`, when
   * no `pipelineDeps` is wired (e.g. unit-test harness), or when the
   * pipeline failed (logged at `error`; the committed raw_event row is
   * preserved either way — the user's fact is never lost).
   */
  capability_written: boolean;
  /** Set when the pipeline returned a `business_row_id`. */
  business_row_id?: number;
  summary: string;
}

const NAME = "strata_commit_event";
const DESCRIPTION = `Commit a pending raw_event to make it a permanent fact.

Use when:
- The user explicitly confirms ("记一下", "OK", "yes")
- The user's response strongly implies confirmation

Refuses if the event is not currently in 'pending' state.`;

export function commitEventTool(deps: EventToolDeps): AnyAgentTool {
  return {
    name: NAME,
    label: "Commit pending event",
    description: DESCRIPTION,
    parameters: toJsonSchema(commitEventSchema),
    async execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<ToolResult<CommitEventDetails>> {
      const input = commitEventSchema.parse(rawParams);
      const details = await commitEventCore(deps, input.event_id);
      return payloadTextResult<CommitEventDetails>(details);
    },
  };
}

/**
 * Shared core logic between the agent tool and the inline-keyboard callback.
 * Exported so `add-callbacks` (next change) can invoke the same code path.
 */
export async function commitEventCore(
  deps: EventToolDeps,
  eventId: number,
): Promise<CommitEventDetails> {
  const current = await deps.rawEventsRepo.findById(eventId);
  if (!current) {
    throw new Error(`raw_event #${eventId} not found`);
  }
  if (current.status !== "pending") {
    throw new Error(
      `raw_event #${eventId} is not in pending state (current: ${current.status})`,
    );
  }

  const now = new Date().toISOString();
  const updated = await deps.rawEventsRepo.update(eventId, {
    status: "committed",
    committed_at: now,
    updated_at: now,
  });

  try {
    await deps.pendingBuffer.remove(current.session_id, eventId);
  } catch (err) {
    deps.logger
      .child({ module: "tools.commit_event" })
      .warn("pendingBuffer.remove failed; timeout loop will reconcile", {
        session_id: current.session_id,
        event_id: eventId,
        error: (err as Error).message,
      });
  }

  let capability_written = false;
  let business_row_id: number | undefined;
  if (updated.capability_name && deps.pipelineDeps) {
    const outcome = await runPipelineForEvent({
      rawEvent: updated,
      toolDeps: deps.pipelineDeps,
    });
    capability_written = outcome.capability_written;
    if (outcome.business_row_id !== undefined) {
      business_row_id = outcome.business_row_id;
    }
  }

  const details: CommitEventDetails = {
    event_id: updated.id,
    status: "committed",
    capability_written,
    summary: updated.source_summary,
  };
  if (business_row_id !== undefined) {
    details.business_row_id = business_row_id;
  }
  return details;
}
