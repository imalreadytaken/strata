/**
 * Telegram inline-keyboard handler for the `strata` namespace.
 *
 * The OpenClaw SDK strips the registered namespace from the raw callback
 * data, so a button whose `callback_data` is `'strata:commit:42'` arrives
 * with `ctx.callback.payload = 'commit:42'`. We parse `<action>:<eventId>`,
 * dispatch the matching state transition, then edit the original message
 * so the UI converges to a final state.
 *
 * See `STRATA_SPEC.md` §5.5 and
 * `openspec/changes/add-callbacks/specs/callbacks/spec.md`.
 */
import type { PluginInteractiveTelegramHandlerContext } from "openclaw/plugin-sdk/core";

import { commitEventCore } from "../tools/commit_event.js";
import type { EventToolDeps } from "../tools/types.js";

/**
 * Mirror of the SDK's `PluginInteractiveButtons` — kept local because the
 * public `openclaw/plugin-sdk/*` entry points don't re-export this type.
 * The shape matches `plugins/types.d.ts::PluginInteractiveButtons` exactly,
 * so the SDK's `ctx.respond.editMessage` accepts the value at runtime.
 */
export type PluginInteractiveButtons = Array<
  Array<{
    text: string;
    callback_data: string;
    style?: "danger" | "success" | "primary";
  }>
>;

export type StrataCallbackAction = "commit" | "edit" | "abandon";

export interface ParsedStrataPayload {
  action: StrataCallbackAction;
  eventId: number;
}

const ACTIONS = new Set<StrataCallbackAction>(["commit", "edit", "abandon"]);

const TEMPLATE_QUESTION = "要记下吗?";
const COMMITTED_MARK = "✅ 已记录";
const ABANDONED_MARK = "❌ 不记";
const EDITING_MARK = "✏️ 等你说要改什么";
const ABANDONED_REASON = "user_declined_via_inline";

/** Parse the namespace-stripped callback payload. Returns null on any malformed input. */
export function parseStrataPayload(payload: string): ParsedStrataPayload | null {
  const idx = payload.indexOf(":");
  if (idx <= 0 || idx === payload.length - 1) return null;
  const action = payload.slice(0, idx);
  const idStr = payload.slice(idx + 1);
  if (!ACTIONS.has(action as StrataCallbackAction)) return null;
  if (!/^\d+$/.test(idStr)) return null;
  const eventId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  return { action: action as StrataCallbackAction, eventId };
}

/** Build the canonical confirmation keyboard. `callback_data` matches the registered namespace. */
export function buildStrataKeyboard(
  eventId: number,
  opts: { showEdit?: boolean } = {},
): PluginInteractiveButtons {
  const buttons: PluginInteractiveButtons[number] = [
    { text: "✅ 记录", callback_data: `strata:commit:${eventId}`, style: "success" },
  ];
  if (opts.showEdit !== false) {
    buttons.push({ text: "✏️ 调整", callback_data: `strata:edit:${eventId}` });
  }
  buttons.push({
    text: "❌ 不记",
    callback_data: `strata:abandon:${eventId}`,
    style: "danger",
  });
  return [buttons];
}

/**
 * Factory that closes over the deps bag and returns the SDK-shaped handler.
 * `deps.sessionId` is overridden per-callback to `ctx.conversationId` by
 * `registerStrataCallbacks` so the buffer drain hits the right session.
 */
export function handleStrataCallback(
  baseDeps: EventToolDeps,
): (ctx: PluginInteractiveTelegramHandlerContext) => Promise<void> {
  return async (ctx) => {
    const log = baseDeps.logger.child({ module: "callbacks.inline_keyboard" });
    const parsed = parseStrataPayload(ctx.callback.payload);
    if (!parsed) {
      log.warn("malformed strata callback payload", {
        payload: ctx.callback.payload,
        chat_id: ctx.callback.chatId,
        messageId: ctx.callback.messageId,
      });
      return;
    }

    const sessionId = ctx.conversationId || baseDeps.sessionId;
    const deps: EventToolDeps = { ...baseDeps, sessionId };
    const baseCtx = {
      action: parsed.action,
      event_id: parsed.eventId,
      session_id: sessionId,
      chat_id: ctx.callback.chatId,
      messageId: ctx.callback.messageId,
    };
    log.info("strata callback received", baseCtx);

    switch (parsed.action) {
      case "commit":
        await handleCommit(ctx, deps, parsed.eventId, log);
        return;
      case "abandon":
        await handleAbandon(ctx, deps, parsed.eventId, log);
        return;
      case "edit":
        await handleEdit(ctx, deps, parsed.eventId, log);
        return;
    }
  };
}

type Log = ReturnType<EventToolDeps["logger"]["child"]>;

async function handleCommit(
  ctx: PluginInteractiveTelegramHandlerContext,
  deps: EventToolDeps,
  eventId: number,
  log: Log,
): Promise<void> {
  let summary: string | undefined;
  try {
    const result = await commitEventCore(deps, eventId);
    summary = result.summary;
  } catch (err) {
    log.info("commit failed (likely double-tap); converging UI anyway", {
      event_id: eventId,
      error: (err as Error).message,
    });
    const row = await deps.rawEventsRepo.findById(eventId);
    summary = row?.source_summary ?? `event #${eventId}`;
  }
  const text = renderEditedText(ctx.callback.messageText, summary, COMMITTED_MARK);
  await ctx.respond.editMessage({ text, buttons: [] });
}

async function handleAbandon(
  ctx: PluginInteractiveTelegramHandlerContext,
  deps: EventToolDeps,
  eventId: number,
  log: Log,
): Promise<void> {
  const current = await deps.rawEventsRepo.findById(eventId);
  let summary = current?.source_summary ?? `event #${eventId}`;
  if (current && current.status === "pending") {
    const now = new Date().toISOString();
    await deps.rawEventsRepo.update(eventId, {
      status: "abandoned",
      abandoned_reason: ABANDONED_REASON,
      updated_at: now,
    });
    try {
      await deps.pendingBuffer.remove(deps.sessionId, eventId);
    } catch (err) {
      log.warn("pendingBuffer.remove failed; timeout loop will reconcile", {
        event_id: eventId,
        session_id: deps.sessionId,
        error: (err as Error).message,
      });
    }
  } else {
    log.info("abandon on non-pending row (double-tap or stale); converging UI", {
      event_id: eventId,
      current_status: current?.status,
    });
  }
  const text = renderEditedText(ctx.callback.messageText, summary, ABANDONED_MARK);
  await ctx.respond.editMessage({ text, buttons: [] });
}

async function handleEdit(
  ctx: PluginInteractiveTelegramHandlerContext,
  deps: EventToolDeps,
  eventId: number,
  log: Log,
): Promise<void> {
  const current = await deps.rawEventsRepo.findById(eventId);
  if (!current) {
    log.info("edit on missing row; converging UI", { event_id: eventId });
  }
  const summary = current?.source_summary ?? `event #${eventId}`;
  const text = renderEditedText(ctx.callback.messageText, summary, EDITING_MARK);
  await ctx.respond.editMessage({ text, buttons: [] });
}

/**
 * Compute the post-action message text. If the original text contained
 * `'要记下吗?'` we replace it with the mark; otherwise we synthesise
 * `${summary} ${mark}` so the edit always has a valid body.
 */
function renderEditedText(
  messageText: string | undefined,
  summary: string,
  mark: string,
): string {
  if (messageText && messageText.includes(TEMPLATE_QUESTION)) {
    return messageText.replace(TEMPLATE_QUESTION, mark);
  }
  return `${summary} ${mark}`;
}
