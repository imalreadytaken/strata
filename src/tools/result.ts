/**
 * Tool-result helpers.
 *
 * OpenClaw's `AnyAgentTool.execute(...)` must resolve to an
 * `AgentToolResult<TDetails>` whose shape is `{ content: TextContent[], details }`.
 * We ship a tiny `payloadTextResult(...)` that stringifies the payload as the
 * text content and returns it as `details` so callers (tests, the inline-
 * keyboard callback in `add-callbacks`) can read the typed object directly.
 *
 * Kept local rather than imported from `openclaw/dist/.../agents/tools/common.js`
 * because that module is not in the package's public `exports` map; relying on
 * the internal path would break on the next SDK bump.
 */

interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult<TDetails> {
  content: TextContent[];
  details: TDetails;
}

/**
 * Build an `AgentToolResult` whose text content is `JSON.stringify(payload)` and
 * whose typed `details` are the same payload.
 */
export function payloadTextResult<TDetails>(payload: TDetails): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}
