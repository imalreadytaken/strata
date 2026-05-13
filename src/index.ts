import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { installMessageHooks } from "./hooks/index.js";
import { bootRuntime } from "./runtime.js";

/**
 * Strata plugin entry.
 *
 * `register(api)` is OpenClaw's hand-off point. We:
 *
 *   1. boot the Strata runtime (open DB, run system migrations, build
 *      every repository) — idempotent across multiple registrations
 *   2. install the message_received / message_sent hooks so every IM
 *      message is persisted to the `messages` table
 *
 * Future phases attach more registrations here:
 *
 *   P2 — strata_* tools, inline-keyboard callback handler, pending-buffer
 *        timeout loop, triage classifier, capture skill
 *   P3 — capability loader + pipeline runner
 *   P4 — Build Bridge entry points (build skill, progress forwarder)
 *   P5 — Reflect Agent cron + push handler
 *   P6 — Re-extraction worker + query skill + dashboard widgets
 *
 * See `docs/STRATA_SPEC.md` §5 for the full module design and
 * `openspec/AGENTS.md` for the hard constraints any generated capability
 * must obey.
 */
export default {
  id: "strata",
  name: "Strata",
  description:
    "Local-first personal data sedimentation and software forge — captures life events, lets capabilities emerge, co-builds new ones via Claude Code.",

  /**
   * The plugin currently exposes no user-facing OpenClaw configuration;
   * Strata reads its own config from `~/.strata/config.json` via
   * `core/config.ts::loadConfig`. We will fill this in if/when an OpenClaw
   * setting (e.g. an enable/disable toggle) is genuinely needed.
   */
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },

  async register(api: OpenClawPluginApi): Promise<void> {
    try {
      const runtime = await bootRuntime(api);
      installMessageHooks(api, {
        messagesRepo: runtime.messagesRepo,
        logger: runtime.logger,
      });
      runtime.logger.info("Strata plugin registered", {
        db_path: runtime.config.database.path,
      });
    } catch (err) {
      api.logger?.error?.(
        `Strata register() failed: ${(err as Error).message}`,
      );
      throw err;
    }
  },
};
