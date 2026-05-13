/**
 * Plugin-side registration for the Telegram strata-namespace callback
 * handler. Discord/Slack registrations would mirror this when those
 * channels need parity; see `add-callbacks` design.md.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import type { StrataRuntime } from "../runtime.js";
import type { EventToolDeps } from "../tools/types.js";
import { handleStrataCallback } from "./inline_keyboard.js";

export { handleStrataCallback, parseStrataPayload, buildStrataKeyboard } from "./inline_keyboard.js";
export type {
  StrataCallbackAction,
  ParsedStrataPayload,
} from "./inline_keyboard.js";

const FALLBACK_SESSION = "default";

export function registerStrataCallbacks(
  api: OpenClawPluginApi,
  runtime: StrataRuntime,
): void {
  // Per-callback session id is captured inside the handler closure via
  // ctx.conversationId; the base deps just need the shared repo + buffer
  // refs. Using FALLBACK_SESSION here is harmless because the handler
  // unconditionally overrides `sessionId` with `ctx.conversationId`.
  //
  // `pipelineDeps` is passed through so the inline-keyboard commit path
  // runs the bound capability's pipeline (mirrors `registerEventTools`).
  const baseDeps: EventToolDeps = {
    rawEventsRepo: runtime.rawEventsRepo,
    pendingBuffer: runtime.pendingBuffer,
    logger: runtime.logger,
    sessionId: FALLBACK_SESSION,
    pipelineDeps: {
      db: runtime.db,
      registry: runtime.capabilities,
      rawEventsRepo: runtime.rawEventsRepo,
      capabilityHealthRepo: runtime.capabilityHealthRepo,
      logger: runtime.logger,
    },
  };
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: "strata",
    handler: handleStrataCallback(baseDeps),
  });
}
