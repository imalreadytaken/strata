/**
 * Tiny adapter that turns a Zod 4 schema into JSON Schema for OpenClaw's
 * `AgentTool.parameters` slot. The SDK is typed `TSchema` (TypeBox); at
 * runtime it accepts any JSON-Schema-shaped object, so we ship the JSON
 * Schema produced by Zod 4's built-in generator and cast to `unknown` for
 * the SDK type.
 *
 * See `openspec/changes/add-event-tools/design.md` D1.
 */
import { z, type ZodType } from "zod";

/**
 * Convert a Zod schema to a JSON-Schema-2020-12 object suitable for OpenClaw
 * (and the underlying Anthropic/OpenAI tool surfaces).
 */
export function toJsonSchema(schema: ZodType): unknown {
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
}
