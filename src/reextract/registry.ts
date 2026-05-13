/**
 * Re-extraction strategy registry.
 *
 * Strategies register themselves at boot via `defaultRegistry.register(strategy)`.
 * The worker consults the registry by `job.strategy` (string) to dispatch.
 */
import { ValidationError } from "../core/errors.js";
import type { ReextractStrategy } from "./types.js";

export class ReextractStrategyRegistry {
  private readonly map = new Map<string, ReextractStrategy>();

  register(strategy: ReextractStrategy): void {
    if (this.map.has(strategy.name)) {
      throw new ValidationError(
        "STRATA_E_VALIDATION",
        `strategy '${strategy.name}' is already registered`,
      );
    }
    this.map.set(strategy.name, strategy);
  }

  get(name: string): ReextractStrategy | undefined {
    return this.map.get(name);
  }

  list(): ReextractStrategy[] {
    return [...this.map.values()];
  }

  /** Test-only: clear the registry between cases. */
  _reset(): void {
    this.map.clear();
  }
}

export const defaultRegistry = new ReextractStrategyRegistry();
