/**
 * OpenClaw `message_received` / `message_sent` hooks that persist every
 * inbound user message and every successfully-delivered assistant message
 * to the `messages` table.
 *
 * Hooks NEVER block the agent: persistence failures are logged and
 * swallowed. See `openspec/changes/add-message-hooks/specs/message-hooks/spec.md`.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import type { Logger } from "../core/logger.js";
import type { MessagesRepository } from "../db/repositories/messages.js";

export interface MessageHookDeps {
  messagesRepo: MessagesRepository;
  logger: Logger;
}

interface InboundEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

interface OutboundEvent {
  to: string;
  content: string;
  success: boolean;
  error?: string;
}

interface MessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

/**
 * Resolve a stable Strata `session_id` from the OpenClaw message context.
 * Prefers `conversationId` when the SDK supplies one; falls back to a
 * synthetic `<channelId>:<participant>` so we never write a NULL session.
 */
function resolveSessionId(ctx: MessageContext, participant: string): string {
  return ctx.conversationId ?? `${ctx.channelId}:${participant}`;
}

function toIsoTimestamp(ms: number | undefined): string {
  if (ms === undefined) return new Date().toISOString();
  return new Date(ms).toISOString();
}

/**
 * Handler for the `message_received` hook. Exported for unit tests; the
 * production hook installation in `installMessageHooks` curries `deps`.
 */
export async function handleMessageReceived(
  deps: MessageHookDeps,
  event: InboundEvent,
  ctx: MessageContext,
): Promise<void> {
  const session_id = resolveSessionId(ctx, event.from);
  const log = deps.logger.child({ module: "hooks.messages", direction: "inbound" });

  try {
    const turn_index = await deps.messagesRepo.getNextTurnIndex(session_id);
    await deps.messagesRepo.insert({
      session_id,
      channel: ctx.channelId,
      role: "user",
      content: event.content,
      content_type: "text",
      turn_index,
      received_at: toIsoTimestamp(event.timestamp),
    });
  } catch (err) {
    log.error("failed to persist inbound message", {
      session_id,
      channelId: ctx.channelId,
      from: event.from,
      error: (err as Error).message,
      code: (err as { code?: string }).code,
    });
  }
}

/**
 * Handler for the `message_sent` hook. Records `role='assistant'` rows for
 * messages OpenClaw confirms were delivered. Failed sends are skipped (logged
 * at debug level) — the user never saw that content, so the transcript
 * shouldn't pretend they did.
 */
export async function handleMessageSent(
  deps: MessageHookDeps,
  event: OutboundEvent,
  ctx: MessageContext,
): Promise<void> {
  const log = deps.logger.child({ module: "hooks.messages", direction: "outbound" });

  if (!event.success) {
    log.debug("skipping failed outbound message", {
      channelId: ctx.channelId,
      to: event.to,
      error: event.error,
    });
    return;
  }

  const session_id = resolveSessionId(ctx, event.to);
  try {
    const turn_index = await deps.messagesRepo.getNextTurnIndex(session_id);
    await deps.messagesRepo.insert({
      session_id,
      channel: ctx.channelId,
      role: "assistant",
      content: event.content,
      content_type: "text",
      turn_index,
      received_at: new Date().toISOString(),
    });
  } catch (err) {
    log.error("failed to persist outbound message", {
      session_id,
      channelId: ctx.channelId,
      to: event.to,
      error: (err as Error).message,
      code: (err as { code?: string }).code,
    });
  }
}

/**
 * Register both message lifecycle hooks against the supplied OpenClaw API.
 * The hooks share dependencies (logger, messagesRepo).
 */
export function installMessageHooks(
  api: OpenClawPluginApi,
  deps: MessageHookDeps,
): void {
  api.on("message_received", (event, ctx) =>
    handleMessageReceived(deps, event as InboundEvent, ctx as MessageContext),
  );
  api.on("message_sent", (event, ctx) =>
    handleMessageSent(deps, event as OutboundEvent, ctx as MessageContext),
  );
}
