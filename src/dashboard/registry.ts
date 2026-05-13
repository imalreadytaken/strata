/**
 * In-memory registry of capability dashboards.
 *
 * The capability loader calls `register(name, dashboard)` once per capability
 * that ships a valid `dashboard.json`. The renderer reads via `get` or `list`.
 * Re-registering an existing name replaces the previous entry (useful for
 * tests; production only registers once per capability per boot).
 */
import type { Logger } from "../core/logger.js";
import type { Dashboard } from "./types.js";

export class DashboardRegistry {
  private readonly entries = new Map<string, Dashboard>();
  private readonly log: Logger;

  constructor(logger: Logger) {
    this.log = logger.child({ module: "dashboard.registry" });
  }

  register(name: string, dashboard: Dashboard): void {
    const replaced = this.entries.has(name);
    this.entries.set(name, dashboard);
    this.log.debug("dashboard registered", {
      name,
      widget_count: dashboard.widgets.length,
      replaced,
    });
  }

  get(name: string): Dashboard | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  list(): Array<{ name: string; dashboard: Dashboard }> {
    return Array.from(this.entries.entries())
      .map(([name, dashboard]) => ({ name, dashboard }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  size(): number {
    return this.entries.size;
  }
}
