/**
 * Reflect Agent — emergence + schema-evolution detectors.
 *
 * Emergence: committed raw_events with no active capability accumulate.
 * Once a per-`event_type` bucket crosses the size + duration thresholds,
 * we surface a `new_capability` signal. Optional LLM upgrade for the
 * suggested name.
 *
 * Schema evolution: each active capability's primary table is introspected
 * for TEXT columns with a dominant value past the skew threshold. Surfaces
 * a `schema_evolution` signal naming the column + dominant value.
 *
 * See `openspec/changes/add-reflect-detectors/specs/reflect-detectors/spec.md`.
 */
import type Database from "better-sqlite3";

import type { Logger } from "../core/logger.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { RawEventRow } from "../db/repositories/raw_events.js";
import type { LLMClient } from "../triage/index.js";
import { scanRawEvents, type ScanRawEventsOptions } from "./scanner.js";
import {
  REFLECT_THRESHOLDS,
  type EmergenceSignal,
  type EvolutionSignal,
  type ReflectThresholds,
} from "./types.js";

export interface EmergenceDeps {
  db: Database.Database;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  logger: Logger;
  llmClient?: LLMClient;
}

export interface DetectEmergenceOptions extends ScanRawEventsOptions {
  thresholds?: Partial<ReflectThresholds>;
  /** When true AND `deps.llmClient` is supplied, ask the LLM to name the cluster. */
  useLLM?: boolean;
}

const SKEW_EXCLUDED_COLS = new Set(["id", "raw_event_id", "currency"]);

function thresholds(opts?: { thresholds?: Partial<ReflectThresholds> }): ReflectThresholds {
  return {
    emergence: { ...REFLECT_THRESHOLDS.emergence, ...opts?.thresholds?.emergence },
    evolution: { ...REFLECT_THRESHOLDS.evolution, ...opts?.thresholds?.evolution },
    decay: { ...REFLECT_THRESHOLDS.decay, ...opts?.thresholds?.decay },
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function maybeUpgradeWithLLM(
  llmClient: LLMClient,
  bucket: string,
  samples: RawEventRow[],
  fallbackName: string,
  log: Logger,
): Promise<{ suggested_name: string; rationale: string }> {
  const system = `You are naming a candidate Strata capability. Given a cluster of unclassified user-life events, propose a snake_case name (short, English, e.g. 'weight_tracking') and a one-sentence rationale.

Return JSON: { "suggested_name": "...", "rationale": "..." }.

Be conservative: if the events look heterogeneous, return the input event_type slug as suggested_name.`;
  const user = JSON.stringify({
    event_type: bucket,
    sample_summaries: samples.slice(0, 8).map((s) => s.source_summary),
  });
  try {
    const raw = await llmClient.infer({ system, user });
    const parsed = JSON.parse(raw) as { suggested_name?: unknown; rationale?: unknown };
    const suggested_name =
      typeof parsed.suggested_name === "string" && parsed.suggested_name.length > 0
        ? slugify(parsed.suggested_name)
        : fallbackName;
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.length > 0
        ? parsed.rationale
        : `cluster of ${samples.length} events of type '${bucket}'`;
    return { suggested_name, rationale };
  } catch (err) {
    log.warn("emergence LLM upgrade failed; using slug fallback", {
      bucket,
      error: (err as Error).message,
    });
    return {
      suggested_name: fallbackName,
      rationale: `cluster of ${samples.length} events of type '${bucket}'`,
    };
  }
}

export async function detectNewCapabilityEmergence(
  deps: EmergenceDeps,
  opts: DetectEmergenceOptions = {},
): Promise<EmergenceSignal[]> {
  const t = thresholds(opts).emergence;
  const log = deps.logger.child({ module: "reflect.emergence" });

  const allEvents = await scanRawEvents({ db: deps.db }, opts);
  const activeCaps = new Set(
    (
      await deps.capabilityRegistryRepo.findMany({ status: "active" })
    ).map((r) => r.name),
  );
  const eligible = allEvents.filter(
    (e) => e.capability_name === null || !activeCaps.has(e.capability_name),
  );

  // Bucket by event_type (null → 'unclassified').
  const buckets = new Map<string, RawEventRow[]>();
  for (const e of eligible) {
    const key = e.event_type || "unclassified";
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(e);
  }

  const signals: EmergenceSignal[] = [];
  for (const [bucket, events] of buckets) {
    if (events.length < t.min_cluster_size) continue;
    const times = events.map((e) => Date.parse(e.created_at)).sort((a, b) => a - b);
    const spanDays = (times[times.length - 1]! - times[0]!) / 86_400_000;
    if (spanDays < t.min_span_days) continue;

    const fallbackName = slugify(bucket);
    let nameAndRationale = {
      suggested_name: fallbackName,
      rationale: `cluster of ${events.length} events of type '${bucket}' spanning ${spanDays.toFixed(1)} days`,
    };
    if (opts.useLLM && deps.llmClient) {
      nameAndRationale = await maybeUpgradeWithLLM(
        deps.llmClient,
        bucket,
        events,
        fallbackName,
        log,
      );
    }

    signals.push({
      kind: "new_capability",
      suggested_name: nameAndRationale.suggested_name,
      rationale: nameAndRationale.rationale,
      evidence_event_ids: events.map((e) => e.id),
      signal_strength: Math.min(events.length / 30, 0.95),
    });
  }
  return signals;
}

// ------------------------------------------------------------------------
// Schema evolution
// ------------------------------------------------------------------------

interface TableColumnInfo {
  name: string;
  type: string;
}

function listTextColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  return rows
    .filter((r) => /^TEXT(?:\b|\()/i.test(r.type ?? ""))
    .map((r) => r.name)
    .filter(
      (n) =>
        !SKEW_EXCLUDED_COLS.has(n) &&
        !n.endsWith("_at"),
    );
}

export async function detectSchemaEvolutionNeed(
  deps: EmergenceDeps,
  opts: DetectEmergenceOptions = {},
): Promise<EvolutionSignal[]> {
  const t = thresholds(opts).evolution;
  const log = deps.logger.child({ module: "reflect.evolution" });
  const signals: EvolutionSignal[] = [];
  const activeCaps = await deps.capabilityRegistryRepo.findMany({ status: "active" });

  for (const cap of activeCaps) {
    let textCols: string[];
    try {
      textCols = listTextColumns(deps.db, cap.primary_table);
    } catch (err) {
      log.warn("PRAGMA table_info failed; skipping capability", {
        capability: cap.name,
        error: (err as Error).message,
      });
      continue;
    }

    for (const col of textCols) {
      let rows: Array<{ value: string | null; n: number }>;
      try {
        rows = deps.db
          .prepare(
            `SELECT ${col} AS value, COUNT(*) AS n FROM ${cap.primary_table} WHERE ${col} IS NOT NULL GROUP BY ${col}`,
          )
          .all() as Array<{ value: string | null; n: number }>;
      } catch (err) {
        log.warn("skew query failed", {
          capability: cap.name,
          column: col,
          error: (err as Error).message,
        });
        continue;
      }
      if (rows.length === 0) continue;
      const total = rows.reduce((s, r) => s + r.n, 0);
      if (total < t.min_rows_for_skew_check) continue;
      const top = rows.reduce((a, b) => (b.n > a.n ? b : a));
      const ratio = top.n / total;
      if (ratio < t.field_skew_threshold) continue;
      signals.push({
        kind: "schema_evolution",
        target_capability: cap.name,
        column: col,
        dominant_value: top.value ?? "",
        ratio,
        rationale: `${cap.primary_table}.${col} = '${top.value}' is ${Math.round(ratio * 100)}% of ${total} rows; consider a subcategory split.`,
        signal_strength: Math.min(ratio, 0.95),
      });
    }
  }
  return signals;
}
