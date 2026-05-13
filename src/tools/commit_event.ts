/**
 * `strata_commit_event` — transition a pending raw_event to `committed`,
 * stamp `committed_at`, drain the pending buffer. The inline-keyboard
 * callback (next change, `add-callbacks`) calls `commitEventCore(...)`
 * directly to share this exact behaviour.
 *
 * See `STRATA_SPEC.md` §5.3.3.
 */
import { z } from "zod";

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
   * Always `false` in P2. P3 wires a pipeline runner that may flip it `true`
   * when the bound capability writes a business-table row.
   */
  capability_written: boolean;
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

  return {
    event_id: updated.id,
    status: "committed",
    capability_written: false,
    summary: updated.source_summary,
  };
}
