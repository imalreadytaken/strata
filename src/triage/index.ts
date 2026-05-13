/**
 * Triage classifier — given an inbound user message + context, decide which
 * skill the agent should run (`capture` / `query` / `build_request` /
 * `correction` / `chitchat`). The classifier is a pure function over an
 * `LLMClient` seam so it is testable without an LLM and swappable when a
 * real OpenClaw inference path lands.
 *
 * See `STRATA_SPEC.md` §5.6 (code shape) + §7.1 (system prompt) and
 * `openspec/changes/add-triage-and-capture-skill/specs/triage/spec.md`.
 */
import { z } from "zod";

import { toJsonSchema } from "../tools/zod_to_json_schema.js";

export const triageKindSchema = z.enum([
  "capture",
  "query",
  "build_request",
  "correction",
  "chitchat",
]);

export type TriageKind = z.infer<typeof triageKindSchema>;

export const triageResultSchema = z.object({
  kind: triageKindSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

export const triageInputSchema = z.object({
  user_message: z.string().min(1),
  recent_messages: z.array(z.string()).default([]),
  active_capabilities: z.array(z.string()).default([]),
  pending_event_summaries: z.array(z.string()).default([]),
});

export type TriageInput = z.infer<typeof triageInputSchema>;

/**
 * The §7.1 prompt verbatim, exported for reuse by the future LLM-backed
 * `LLMClient` implementation (and for the heuristic client's `reasoning`
 * strings to reference).
 */
export const TRIAGE_PROMPT = `You are the intent classifier for Strata, a personal data sediment system.
Given a user message and context, classify the intent.

Available kinds:
- capture: User is sharing factual life data (consumption, exercise, mood, etc.)
- query: User is asking about historical data ("how much did I spend last month")
- build_request: User explicitly asks to add a new capability or modify existing
- correction: User is correcting a previously recorded fact
- chitchat: Other (greetings, casual conversation, etc.)

Return JSON matching the schema. Be precise: when uncertain, prefer chitchat
over capture (we'd rather miss a record than fabricate one).

Context provided:
- User's recent 3 messages
- List of active capabilities
- Pending events in current session`;

/**
 * Thin one-method seam. The heuristic backend ignores `responseSchema`; a
 * future LLM-backed implementation forwards it to the provider's JSON-mode
 * surface. Schema validation happens once, inside `classifyIntent`.
 */
export interface LLMClient {
  infer(params: {
    system: string;
    user: string;
    responseSchema?: unknown;
  }): Promise<string>;
}

/**
 * Classify an inbound message into one of five intent kinds. Pure: same
 * input + same `LLMClient` ⇒ same output.
 */
export async function classifyIntent(
  rawInput: unknown,
  llm: LLMClient,
): Promise<TriageResult> {
  const input = triageInputSchema.parse(rawInput);
  const user = JSON.stringify({
    user_message: input.user_message,
    recent_messages: input.recent_messages,
    active_capabilities: input.active_capabilities,
    pending_event_summaries: input.pending_event_summaries,
  });

  const raw = await llm.infer({
    system: TRIAGE_PROMPT,
    user,
    responseSchema: toJsonSchema(triageResultSchema),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `triage: failed to parse LLM response as JSON: ${(err as Error).message}`,
    );
  }
  return triageResultSchema.parse(parsed);
}

export { HeuristicLLMClient, HEURISTIC_RULES } from "./heuristics.js";
