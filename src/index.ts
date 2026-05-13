import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Strata plugin entry.
 *
 * This is the minimum-viable, compilable stub. Subsequent phases will:
 *
 *   P1 — wire `register(api)` to bootstrap the SQLite database, run system-table
 *        migrations, and load all installed capabilities.
 *   P2 — register `onUserMessage` / `onAssistantMessage` hooks, the six
 *        `strata_*` event tools, the capture skill, and the inline-keyboard
 *        callback handler.
 *   P3 — load capabilities from `~/.strata/capabilities/<name>/current/`.
 *   P4 — start the Build Bridge orchestrator.
 *   P5 — start the Reflect Agent cron.
 *   P6 — start the Re-extraction worker.
 *
 * See `docs/STRATA_SPEC.md` §5 for the full module design and `openspec/AGENTS.md`
 * for the hard constraints any generated capability must obey.
 */
export default {
  id: "strata",
  name: "Strata",
  description:
    "Local-first personal data sedimentation and software forge — captures life events, lets capabilities emerge, co-builds new ones via Claude Code.",

  /**
   * The plugin currently exposes no user-facing configuration; capability-specific
   * knobs live in their own `meta.json`. We will fill this in once the
   * `src/core/config.ts` module exists (P1).
   */
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },

  register(_api: OpenClawPluginApi): void {
    // Intentionally empty — P0 bootstrap stub. See JSDoc above for the
    // phase-by-phase wiring plan.
  },
};
