/**
 * Reflect Agent — signal types + thresholds.
 *
 * Each detector returns one or more typed signals. The next change
 * (`add-reflect-proposals`) turns them into `proposals` rows.
 */

export interface EmergenceSignal {
  kind: "new_capability";
  suggested_name: string;
  rationale: string;
  evidence_event_ids: number[];
  signal_strength: number;
}

export interface EvolutionSignal {
  kind: "schema_evolution";
  target_capability: string;
  column: string;
  dominant_value: string;
  ratio: number;
  rationale: string;
  signal_strength: number;
}

export interface DecaySignal {
  kind: "capability_archive";
  target_capability: string;
  days_since_last_write: number;
  /** `Number.POSITIVE_INFINITY` when `last_read_at` is NULL. */
  days_since_last_read: number;
  rationale: string;
  signal_strength: number;
}

export type ReflectSignal = EmergenceSignal | EvolutionSignal | DecaySignal;

export interface ReflectThresholds {
  emergence: {
    min_cluster_size: number;
    min_span_days: number;
  };
  evolution: {
    field_skew_threshold: number;
    min_rows_for_skew_check: number;
  };
  decay: {
    days_since_last_write: number;
    days_since_last_read: number;
  };
}

export const REFLECT_THRESHOLDS: ReflectThresholds = {
  emergence: { min_cluster_size: 10, min_span_days: 7 },
  evolution: { field_skew_threshold: 0.6, min_rows_for_skew_check: 30 },
  decay: { days_since_last_write: 90, days_since_last_read: 30 },
};
