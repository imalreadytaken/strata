import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { registerStrataCallbacks } from "./callbacks/index.js";
import { installMessageHooks } from "./hooks/index.js";
import { startPendingTimeoutLoop } from "./pending_buffer/index.js";
import {
  defaultRegistry as defaultReextractRegistry,
  deriveExistingStrategy,
  reextractMessagesStrategy,
  reextractRawEventsStrategy,
  startReextractWorker,
} from "./reextract/index.js";
import { handleReflectCallback } from "./reflect/callback.js";
import { startReflectAgent } from "./reflect/cron.js";
import { bootRuntime } from "./runtime.js";
import { registerEventTools } from "./tools/index.js";
import { installTriageHook } from "./triage/hook.js";

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
 *   P2 — strata_* tools (done), inline-keyboard callback handler (done),
 *        pending-buffer timeout loop (done), triage classifier (done — see
 *        `src/triage/`; not yet wired into a hook, that lands in P5), capture
 *        skill markdown (done — see `src/skills/capture/SKILL.md`)
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

  /**
   * OpenClaw's plugin contract requires `register: (api) => void` —
   * synchronous, no Promise. But Strata's `bootRuntime` is async
   * (config + capability loader use `fs/promises`, repos return
   * `Promise<T>` by convention). We bridge with a fire-and-forget IIFE:
   *
   * - `register()` returns synchronously.
   * - Hooks, tools, callback handlers, and background loops register
   *   ~50–200ms later when bootRuntime resolves. OpenClaw's hook table is
   *   stateful (every `api.on(...)` / `api.registerTool(...)` mutates it
   *   as it lands), so deferred registration still wires up correctly.
   * - Any inbound message arriving inside that boot window simply
   *   doesn't see Strata's hooks — Strata's whole DB write + triage
   *   chain is skipped for that one message. Acceptable for personal
   *   dogfood; revisit when we add a proper "startup gate" surface.
   * - A boot failure logs to OpenClaw's logger; we deliberately do not
   *   re-throw out of the IIFE because nothing would catch it.
   */
  register(api: OpenClawPluginApi): void {
    void (async () => {
      try {
        const runtime = await bootRuntime(api);
        installMessageHooks(api, {
          messagesRepo: runtime.messagesRepo,
          logger: runtime.logger,
        });
        startPendingTimeoutLoop({
          pendingBuffer: runtime.pendingBuffer,
          rawEventsRepo: runtime.rawEventsRepo,
          timeoutMinutes: runtime.config.pending.timeoutMinutes,
          logger: runtime.logger,
        });
        registerEventTools(api, runtime);
        registerStrataCallbacks(api, runtime);
        installTriageHook(api, {
          messagesRepo: runtime.messagesRepo,
          rawEventsRepo: runtime.rawEventsRepo,
          pendingBuffer: runtime.pendingBuffer,
          capabilities: runtime.capabilities,
          llmClient: runtime.llmClient,
          logger: runtime.logger,
        });
        runtime.stopReflect = startReflectAgent({
          db: runtime.db,
          capabilityRegistryRepo: runtime.capabilityRegistryRepo,
          capabilityHealthRepo: runtime.capabilityHealthRepo,
          proposalsRepo: runtime.proposalsRepo,
          llmClient: runtime.llmClient,
          logger: runtime.logger,
        });
        api.registerInteractiveHandler({
          channel: "telegram",
          namespace: "strata-propose",
          handler: handleReflectCallback({
            proposalsRepo: runtime.proposalsRepo,
            logger: runtime.logger,
          }),
        });

        // Register the default reextract strategies. Each register() throws
        // on duplicate name; the try/catch makes a re-boot idempotent.
        for (const strategy of [
          deriveExistingStrategy,
          reextractRawEventsStrategy,
          reextractMessagesStrategy,
        ]) {
          try {
            defaultReextractRegistry.register(strategy);
          } catch {
            // already registered (idempotent re-boot); fine.
          }
        }
        runtime.stopReextract = startReextractWorker(
          {
            db: runtime.db,
            capabilityRegistryRepo: runtime.capabilityRegistryRepo,
            reextractJobsRepo: runtime.reextractJobsRepo,
            schemaEvolutionsRepo: runtime.schemaEvolutionsRepo,
            logger: runtime.logger,
          },
          {
            enabled: runtime.config.reextract.enabled,
            intervalMs:
              runtime.config.reextract.poll_interval_seconds * 1000,
          },
        );
        runtime.logger.info("Strata plugin registered", {
          db_path: runtime.config.database.path,
        });
      } catch (err) {
        api.logger?.error?.(
          `Strata register() failed: ${(err as Error).message}`,
        );
        // Fire-and-forget: nothing would catch a re-throw here. We log
        // and let OpenClaw observe the plugin as "registered but partial".
      }
    })();
  },
};
