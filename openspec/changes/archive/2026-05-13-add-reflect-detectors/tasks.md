## 1. Types + thresholds

- [x] 1.1 Create `src/reflect/types.ts`:
  - `EmergenceSignal = { kind: 'new_capability'; suggested_name: string; rationale: string; evidence_event_ids: number[]; signal_strength: number }`.
  - `EvolutionSignal = { kind: 'schema_evolution'; target_capability: string; column: string; dominant_value: string; ratio: number; rationale: string; signal_strength: number }`.
  - `DecaySignal = { kind: 'capability_archive'; target_capability: string; days_since_last_write: number; days_since_last_read: number; rationale: string; signal_strength: number }`.
  - `ReflectSignal = EmergenceSignal | EvolutionSignal | DecaySignal`.
  - `ReflectThresholds` interface with `emergence`, `evolution`, `decay` sub-objects.
  - `REFLECT_THRESHOLDS` const with the defaults from design D5.

## 2. Scanner

- [x] 2.1 Create `src/reflect/scanner.ts` exporting `scanRawEvents(deps, opts?: { sinceDays?: number; now?: () => Date }): Promise<RawEventRow[]>`. Default `sinceDays=90`. Reads via raw `db.prepare(...).all(...)` because the repo's `findMany` doesn't support date filters.

## 3. Emergence detector

- [x] 3.1 Create `src/reflect/emergence_detector.ts` exporting:
  - `detectNewCapabilityEmergence(deps, opts?: { thresholds?, useLLM? }): Promise<EmergenceSignal[]>`.
    - Pulls events from scanner.
    - Filters: `status='committed'`, `capability_name IS NULL` OR `capability_name NOT IN (active registry names)`.
    - Buckets by `event_type` (or `'unclassified'`).
    - For each bucket: compute `size`, `spanDays = (max(created_at) - min(created_at)) / 86400000`.
    - When `size >= min_cluster_size && spanDays >= min_span_days`, emit a signal. `suggested_name = slugify(event_type)`. `signal_strength = min(size/30, 0.95)`. `rationale` describes the bucket.
    - When `deps.llmClient` provided AND `useLLM`, replace `suggested_name`/`rationale` with the LLM's suggestion (graceful fallback on failure).
  - `detectSchemaEvolutionNeed(deps, opts?: { thresholds? }): Promise<EvolutionSignal[]>`.
    - For each active capability: `PRAGMA table_info(<primary_table>)` → TEXT cols (excluding `id`, `raw_event_id`, `currency`, `*_at`).
    - For each TEXT col: `SELECT col, COUNT(*) FROM table GROUP BY col` → compute total + max ratio.
    - When `total >= min_rows_for_skew_check && maxRatio >= field_skew_threshold`, emit signal.

## 4. Decay detector

- [x] 4.1 Create `src/reflect/decay_detector.ts` exporting `detectArchiveCandidates(deps, opts?: { thresholds?, now? }): Promise<DecaySignal[]>`:
  - For each active capability, read its `capability_health` row.
  - Compute `daysSinceLastWrite`, `daysSinceLastRead`. NULL `last_write_at`/`last_read_at` → treat as infinite.
  - When both exceed thresholds, emit signal. `signal_strength = min(daysSinceLastWrite/180, 0.95)`.

## 5. Barrel

- [x] 5.1 `src/reflect/index.ts` re-exports the three detector functions + scanner + types + `REFLECT_THRESHOLDS`.

## 6. Tests

- [x] 6.1 `src/reflect/scanner.test.ts`:
  - Returns committed events in the window.
  - Excludes `pending` / `abandoned`.
  - Respects `sinceDays`.
- [x] 6.2 `src/reflect/emergence_detector.test.ts`:
  - Emits a signal for an `unclassified` cluster meeting thresholds.
  - Drops a cluster below `min_cluster_size`.
  - Drops a cluster spanning < `min_span_days`.
  - Excludes events whose `capability_name` IS an active registry entry.
  - LLM upgrade: stub `llmClient.infer` to return a JSON suggested_name; signal's `suggested_name` matches.
  - LLM failure: stub throws → falls back to slugified `event_type`.
  - `detectSchemaEvolutionNeed`: skewed `category` column emits a signal; unskewed (uniform) does not; small table (< min_rows) is skipped.
- [x] 6.3 `src/reflect/decay_detector.test.ts`:
  - Both timestamps stale → signal emitted.
  - One timestamp fresh → no signal.
  - NULL `last_write_at` → signal emitted (treated as infinite age).
  - Active capability without a `capability_health` row → no crash; no signal.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-reflect-detectors --strict`.
