## Why

Reflect Agent's job (`STRATA_SPEC.md` §5.7) is to scan `raw_events` + `capability_health` on a cron, surface three kinds of signals, and turn them into `proposals` rows for the user to approve. The signal-detection layer is purely DB → typed-signal: no LLM needed for the minimum-viable heuristic, no cron, no IM push. We isolate it as its own change so the next two changes (`add-reflect-proposals`, `add-reflect-cron`) layer cleanly on top.

The three detectors:

1. **Emergence** — committed `raw_events` with no bound capability (or bound to an unregistered one) accumulate; once one such cluster passes size + duration thresholds, it's a candidate for a new capability.
2. **Schema evolution** — within an active capability's business table, an enum/text column whose values are heavily skewed (e.g., 80% of `expenses.category='dining'`) is a signal that the schema would benefit from a subcategory split.
3. **Decay** — an active capability whose `last_write_at` is more than `archive.days_since_last_write` days ago AND `last_read_at` is more than `archive.days_since_last_read` days ago is a candidate for archival.

References: `STRATA_SPEC.md` §5.7 (Reflect Agent overview), §5.7.1 (Pattern detector), §5.7.2 (Emergence + schema-evolution detectors), §5.7.3 (Decay detector), §10.1 (`reflect.*` + `emergence.*` + `archive.*` thresholds).

## What Changes

- Add `reflect-detectors` capability covering:
  - **`ReflectSignal`** discriminated union: `EmergenceSignal | EvolutionSignal | DecaySignal`. Every signal carries `kind`, `signal_strength` (0..1), and a per-kind body.
  - **`scanRawEvents(deps, opts): Promise<RawEventRow[]>`** — `SELECT * FROM raw_events WHERE status='committed' AND created_at >= since` via the existing repo + a small SQL helper. The default since is `now - 90 days`.
  - **`detectNewCapabilityEmergence(deps): Promise<EmergenceSignal[]>`** — picks committed events whose `capability_name` is null or names a capability not in the registry. Buckets by `event_type` (or `'unclassified'`). For each bucket that meets `min_cluster_size` (default 10) AND `min_span_days` (default 7), emits one signal with `suggested_name`, `evidence_event_ids`, and a heuristic `signal_strength` (`min(size / 30, 0.95)`). When `deps.llmClient` is supplied, the suggested_name + rationale upgrade via a `smart`-tier classify call; absent that, a slugified `event_type` is the fallback.
  - **`detectSchemaEvolutionNeed(deps): Promise<EvolutionSignal[]>`** — for each `capability_registry` row with `status='active'`, introspects the business table's TEXT columns. For columns with ≥ `min_rows_for_skew_check` (default 30) total rows AND a dominant value ratio ≥ `field_skew_threshold` (default 0.6), emits one `schema_evolution` signal naming the column + dominant value.
  - **`detectArchiveCandidates(deps): Promise<DecaySignal[]>`** — for each `capability_registry` row with `status='active'`, reads `capability_health`. When `days_since(last_write_at) > days_since_last_write` (default 90) AND `days_since(last_read_at) > days_since_last_read` (default 30), emits one `capability_archive` signal.
  - **`REFLECT_THRESHOLDS`** constant carrying all four numeric defaults so the next change's `config.reflect.*` overrides can replace them at runtime.

## Capabilities

### New Capabilities
- `reflect-detectors`: pure DB → typed-signal detection layer for Reflect Agent.

### Modified Capabilities
*(none — uses repositories only; LLM is optional)*

## Impact

- **Files added**:
  - `src/reflect/types.ts` — `ReflectSignal`, `EmergenceSignal`, `EvolutionSignal`, `DecaySignal`, `ReflectThresholds`, `REFLECT_THRESHOLDS`.
  - `src/reflect/scanner.ts` — `scanRawEvents`.
  - `src/reflect/emergence_detector.ts` — `detectNewCapabilityEmergence`, `detectSchemaEvolutionNeed`.
  - `src/reflect/decay_detector.ts` — `detectArchiveCandidates`.
  - `src/reflect/index.ts` — barrel.
  - Four `*.test.ts` files with seeded-DB fixtures.
- **Non-goals**:
  - No embedding-based clustering. `event_type` bucketing is the V1 heuristic; once an embedding worker exists, the cluster step swaps in.
  - No proposal-row writes. Detectors return typed signals; the next change persists them.
  - No cron. This change exposes pure functions; the cron + plugin entry hook live in `add-reflect-cron`.
