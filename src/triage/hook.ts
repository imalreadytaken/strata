/**
 * Triage hook — wires `classifyIntent` into the OpenClaw
 * `before_prompt_build` lifecycle so every inbound user message lands in
 * the agent's system prompt with a routing hint.
 *
 * The static "Strata is here, these are the tools" block goes in
 * `prependSystemContext` (cacheable across turns); the per-turn triage
 * result goes in `prependContext`. A triage failure logs at `warn` and
 * returns `{}` so the agent run is never blocked by a classifier bug.
 *
 * See `openspec/changes/add-triage-hook/specs/triage-hook/spec.md`.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import type { CapabilityRegistry } from "../capabilities/types.js";
import type { Logger } from "../core/logger.js";
import type { MessagesRepository } from "../db/repositories/messages.js";
import type { RawEventsRepository } from "../db/repositories/raw_events.js";
import type { PendingBuffer } from "../pending_buffer/index.js";
import {
  classifyIntent,
  type LLMClient,
  type TriageInput,
  type TriageResult,
} from "./index.js";

export interface RoutingHookDeps {
  messagesRepo: MessagesRepository;
  rawEventsRepo: RawEventsRepository;
  pendingBuffer: PendingBuffer;
  capabilities: CapabilityRegistry;
  llmClient: LLMClient;
  logger: Logger;
}

export interface BuildTriageInputDeps {
  messagesRepo: MessagesRepository;
  rawEventsRepo: RawEventsRepository;
  pendingBuffer: PendingBuffer;
  capabilities: CapabilityRegistry;
  sessionId: string;
  userMessage: string;
}

/** Recent-history depth fed to the classifier. */
const RECENT_USER_MESSAGE_LIMIT = 3;

/**
 * Pull the classifier-input bundle from Strata's own data layer (not the
 * provider-specific `event.messages` array, whose shape varies across
 * channels).
 */
export async function buildTriageInput(
  deps: BuildTriageInputDeps,
): Promise<TriageInput> {
  const recentRows = await deps.messagesRepo.findMany(
    { session_id: deps.sessionId, role: "user" },
    {
      orderBy: "received_at",
      direction: "desc",
      limit: RECENT_USER_MESSAGE_LIMIT,
    },
  );
  const recent_messages = recentRows.map((row) => row.content);

  const active_capabilities = [...deps.capabilities.keys()];

  const pendingIds = await deps.pendingBuffer.getAll(deps.sessionId);
  const summaries: string[] = [];
  for (const id of pendingIds) {
    const row = await deps.rawEventsRepo.findById(id);
    if (!row) continue;
    summaries.push(`#${id}: ${row.source_summary}`);
  }

  return {
    user_message: deps.userMessage,
    recent_messages,
    active_capabilities,
    pending_event_summaries: summaries,
  };
}

/** All `strata_*` tool names — used by the routing templates and asserted in tests. */
const STRATA_TOOLS = [
  "strata_create_pending_event",
  "strata_update_pending_event",
  "strata_commit_event",
  "strata_supersede_event",
  "strata_abandon_event",
  "strata_search_events",
] as const;

function renderStaticBlock(input: TriageInput): string {
  const capsLine =
    input.active_capabilities.length === 0
      ? "(none yet — Build Bridge can create one)"
      : input.active_capabilities.join(", ");
  return [
    "## Strata is active in this session",
    "",
    `Active capabilities: ${capsLine}.`,
    "",
    "Available tools (all on the strata_* namespace):",
    `- ${STRATA_TOOLS[0]} — create a pending raw_event awaiting user confirmation`,
    `- ${STRATA_TOOLS[1]} — patch a pending event (corrections / additions)`,
    `- ${STRATA_TOOLS[2]} — confirm a pending event → status='committed'`,
    `- ${STRATA_TOOLS[3]} — cross-session correction of a committed event`,
    `- ${STRATA_TOOLS[4]} — decline a pending event → status='abandoned'`,
    `- ${STRATA_TOOLS[5]} — search past raw_events by summary / type / time`,
    "",
    "Raw event state machine: pending → committed | superseded | abandoned.",
  ].join("\n");
}

function renderPerTurnBlock(triage: TriageResult, input: TriageInput): string {
  if (triage.kind === "chitchat") return "";

  const header = [
    "## Strata triage",
    `User intent: ${triage.kind.toUpperCase()} (confidence ${triage.confidence.toFixed(2)}; reasoning: ${triage.reasoning}).`,
  ];
  const pending = input.pending_event_summaries.length
    ? `Pending events in this session: ${input.pending_event_summaries.join("; ")}`
    : "Pending events in this session: none.";

  switch (triage.kind) {
    case "capture":
      return [
        ...header,
        "Recommended skill: capture (src/skills/capture/SKILL.md).",
        pending,
        "",
        "Tool sequence: extract structured data → strata_create_pending_event → ask the user to confirm in text → on 'yes' call strata_commit_event, on 'no' call strata_abandon_event. If the user adds detail or corrects in the same session, call strata_update_pending_event with their follow-up message id.",
      ].join("\n");
    case "correction":
      return [
        ...header,
        "Recommended path: find the prior committed event then supersede it.",
        pending,
        "",
        "Tool sequence: strata_search_events (use query + event_type + time range to confirm the target) → strata_supersede_event with the new structured data and the correction message id.",
      ].join("\n");
    case "query":
      return [
        ...header,
        "Recommended path: read-only search across raw_events.",
        pending,
        "",
        "Tool sequence: strata_search_events. Filter by event_type / status / time range; the result includes source_summary you can quote back. Do NOT create or mutate any events for a query.",
      ].join("\n");
    case "build_request":
      return [
        ...header,
        "Recommended path: acknowledge conversationally — Build Bridge is not yet shipped.",
        pending,
        "",
        "When the user asks Strata to add a new capability, respond explaining that the capability-creation flow is still under construction and offer to capture the request as a `raw_event` for later (event_type='build_request').",
      ].join("\n");
    default:
      return ""; // unreachable; here for exhaustiveness
  }
}

/** Pure: turn a triage result into the two prompt-injection strings. */
export function renderRoutingContext(
  triage: TriageResult,
  input: TriageInput,
): { prependSystemContext: string; prependContext: string } {
  return {
    prependSystemContext: renderStaticBlock(input),
    prependContext: renderPerTurnBlock(triage, input),
  };
}

/** Register the `before_prompt_build` handler. Idempotent only if `api.on` is. */
export function installTriageHook(
  api: OpenClawPluginApi,
  deps: RoutingHookDeps,
): void {
  api.on("before_prompt_build", async (event, ctx) => {
    const log = deps.logger.child({ module: "triage.hook" });
    const sessionId = ctx.sessionId ?? "default";

    try {
      const input = await buildTriageInput({
        messagesRepo: deps.messagesRepo,
        rawEventsRepo: deps.rawEventsRepo,
        pendingBuffer: deps.pendingBuffer,
        capabilities: deps.capabilities,
        sessionId,
        userMessage: event.prompt,
      });
      const triage = await classifyIntent(input, deps.llmClient);
      return renderRoutingContext(triage, input);
    } catch (err) {
      log.warn("triage hook failed; agent run proceeds without routing hint", {
        session_id: sessionId,
        error: (err as Error).message,
        code: (err as { code?: string }).code,
      });
      return {};
    }
  });
}
