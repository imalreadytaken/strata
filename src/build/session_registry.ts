/**
 * `BuildSessionRegistry` — in-memory map of currently-running builds to
 * their AbortControllers.
 *
 * `strata_run_build` calls `register` as soon as the orchestrator has
 * inserted the `builds` row (via the `onBuildIdAssigned` callback) and
 * `complete` in a `finally` so every terminal path (success, failure,
 * cancellation, or thrown exception) deregisters. `strata_stop_build`
 * calls `abort(buildId)` to fire the controller's signal; the
 * orchestrator's existing `abortIfNeeded` hook does the rest.
 *
 * In-memory by design: `AbortController` is not serialisable and stop is
 * meaningful only for builds running in the current process. The `builds`
 * table already records the durable state. See `add-build-stop` D1/D2.
 */
import type { Logger } from "../core/logger.js";

export interface BuildSessionEntry {
  controller: AbortController;
  sessionId: string;
  startedAt: string;
}

export interface BuildSessionListItem {
  buildId: number;
  sessionId: string;
  startedAt: string;
}

export class BuildSessionRegistry {
  private readonly entries = new Map<number, BuildSessionEntry>();
  private readonly log: Logger;

  constructor(logger: Logger) {
    this.log = logger.child({ module: "build.session_registry" });
  }

  register(
    buildId: number,
    controller: AbortController,
    sessionId: string,
  ): void {
    const startedAt = new Date().toISOString();
    if (this.entries.has(buildId)) {
      this.log.warn("re-registering build session — previous entry replaced", {
        build_id: buildId,
      });
    }
    this.entries.set(buildId, { controller, sessionId, startedAt });
    this.log.debug("build session registered", {
      build_id: buildId,
      session_id: sessionId,
    });
  }

  abort(buildId: number): { stopped: boolean } {
    const entry = this.entries.get(buildId);
    if (!entry) {
      return { stopped: false };
    }
    entry.controller.abort();
    this.log.info("build session aborted", { build_id: buildId });
    return { stopped: true };
  }

  complete(buildId: number): void {
    const dropped = this.entries.delete(buildId);
    if (dropped) {
      this.log.debug("build session completed", { build_id: buildId });
    }
  }

  get(buildId: number): BuildSessionEntry | undefined {
    return this.entries.get(buildId);
  }

  list(): BuildSessionListItem[] {
    return Array.from(this.entries.entries()).map(([buildId, entry]) => ({
      buildId,
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
    }));
  }

  size(): number {
    return this.entries.size;
  }
}
