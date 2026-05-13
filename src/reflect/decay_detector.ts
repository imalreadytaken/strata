/**
 * Reflect Agent — decay (archive-candidate) detector.
 *
 * An active capability whose `last_write_at` is past
 * `thresholds.decay.days_since_last_write` AND whose `last_read_at`
 * is past `thresholds.decay.days_since_last_read` is a candidate for
 * archival. NULL timestamps are treated as infinite staleness.
 */
import type { Logger } from "../core/logger.js";
import type { CapabilityHealthRepository } from "../db/repositories/capability_health.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import {
  REFLECT_THRESHOLDS,
  type DecaySignal,
  type ReflectThresholds,
} from "./types.js";

export interface DecayDeps {
  capabilityRegistryRepo: CapabilityRegistryRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  logger: Logger;
}

export interface DetectDecayOptions {
  thresholds?: Partial<ReflectThresholds>;
  now?: () => Date;
}

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 86_400_000;
}

export async function detectArchiveCandidates(
  deps: DecayDeps,
  opts: DetectDecayOptions = {},
): Promise<DecaySignal[]> {
  const t = {
    ...REFLECT_THRESHOLDS.decay,
    ...opts.thresholds?.decay,
  };
  const now = (opts.now ?? (() => new Date()))();
  const signals: DecaySignal[] = [];

  const active = await deps.capabilityRegistryRepo.findMany({ status: "active" });
  for (const cap of active) {
    const health = await deps.capabilityHealthRepo.findById(cap.name);
    const daysWrite = daysSince(health?.last_write_at ?? null, now);
    const daysRead = daysSince(health?.last_read_at ?? null, now);
    if (daysWrite <= t.days_since_last_write) continue;
    if (daysRead <= t.days_since_last_read) continue;
    const writeAge = Number.isFinite(daysWrite) ? daysWrite : 365;
    signals.push({
      kind: "capability_archive",
      target_capability: cap.name,
      days_since_last_write: daysWrite,
      days_since_last_read: daysRead,
      rationale: `Last write ${Number.isFinite(daysWrite) ? Math.round(daysWrite) : "never"}d ago, last read ${Number.isFinite(daysRead) ? Math.round(daysRead) : "never"}d ago.`,
      signal_strength: Math.min(writeAge / 180, 0.95),
    });
  }
  return signals;
}
