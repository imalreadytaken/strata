/**
 * Reflect Agent — Telegram interactive handler for the `strata-propose`
 * namespace. Parses `approve:<id>` / `decline:<id>` callback payloads
 * and updates the corresponding `proposals` row. Edits the source
 * message to acknowledge the user's action and clears buttons.
 */
import type { PluginInteractiveTelegramHandlerContext } from "openclaw/plugin-sdk/core";

import type { Logger } from "../core/logger.js";
import type { ProposalsRepository } from "../db/repositories/proposals.js";

const COOLDOWN_MS = 30 * 86_400_000;
const ACTIONS = new Set<ReflectCallbackAction>(["approve", "decline"]);

export type ReflectCallbackAction = "approve" | "decline";

export interface ParsedReflectPayload {
  action: ReflectCallbackAction;
  proposalId: number;
}

export interface ReflectButton {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
}

export type ReflectKeyboard = Array<Array<ReflectButton>>;

export function parseReflectPayload(payload: string): ParsedReflectPayload | null {
  const idx = payload.indexOf(":");
  if (idx <= 0 || idx === payload.length - 1) return null;
  const action = payload.slice(0, idx);
  const idStr = payload.slice(idx + 1);
  if (!ACTIONS.has(action as ReflectCallbackAction)) return null;
  if (!/^\d+$/.test(idStr)) return null;
  const proposalId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  return { action: action as ReflectCallbackAction, proposalId };
}

export function buildReflectKeyboard(proposalId: number): ReflectKeyboard {
  return [
    [
      {
        text: "✅ approve",
        callback_data: `strata-propose:approve:${proposalId}`,
        style: "success",
      },
      {
        text: "❌ decline",
        callback_data: `strata-propose:decline:${proposalId}`,
        style: "danger",
      },
    ],
  ];
}

export interface ReflectCallbackDeps {
  proposalsRepo: ProposalsRepository;
  logger: Logger;
  now?: () => Date;
}

export function handleReflectCallback(
  deps: ReflectCallbackDeps,
): (ctx: PluginInteractiveTelegramHandlerContext) => Promise<void> {
  return async (ctx) => {
    const log = deps.logger.child({ module: "reflect.callback" });
    const parsed = parseReflectPayload(ctx.callback.payload);
    if (!parsed) {
      log.warn("malformed strata-propose payload", {
        payload: ctx.callback.payload,
      });
      return;
    }
    const now = (deps.now ?? (() => new Date()))();

    let row;
    try {
      row = await deps.proposalsRepo.findById(parsed.proposalId);
    } catch (err) {
      log.warn("proposalsRepo.findById failed", {
        proposal_id: parsed.proposalId,
        error: (err as Error).message,
      });
    }
    if (!row) {
      log.info("strata-propose callback on missing proposal; clearing buttons", {
        proposal_id: parsed.proposalId,
      });
      await safeEdit(ctx, `proposal #${parsed.proposalId} not found`, log);
      return;
    }

    try {
      if (parsed.action === "approve") {
        await deps.proposalsRepo.update(parsed.proposalId, {
          status: "approved",
          responded_at: now.toISOString(),
        });
        await safeEdit(
          ctx,
          renderAck(ctx, "✅ approved — Build Bridge will pick this up when ready"),
          log,
        );
      } else {
        const cooldownUntil = new Date(now.getTime() + COOLDOWN_MS).toISOString();
        await deps.proposalsRepo.update(parsed.proposalId, {
          status: "declined",
          responded_at: now.toISOString(),
          cooldown_until: cooldownUntil,
        });
        await safeEdit(
          ctx,
          renderAck(ctx, "❌ declined — won't surface this proposal for 30 days"),
          log,
        );
      }
    } catch (err) {
      log.warn("reflect callback DB update failed", {
        proposal_id: parsed.proposalId,
        action: parsed.action,
        error: (err as Error).message,
      });
    }
  };
}

function renderAck(
  ctx: PluginInteractiveTelegramHandlerContext,
  mark: string,
): string {
  const original = ctx.callback.messageText ?? "";
  if (original.length === 0) return mark;
  return `${original}\n\n${mark}`;
}

async function safeEdit(
  ctx: PluginInteractiveTelegramHandlerContext,
  text: string,
  log: ReturnType<Logger["child"]>,
): Promise<void> {
  try {
    await ctx.respond.editMessage({ text, buttons: [] });
  } catch (err) {
    log.warn("editMessage failed", { error: (err as Error).message });
  }
}
