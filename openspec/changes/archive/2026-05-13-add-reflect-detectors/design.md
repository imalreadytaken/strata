## Context

`STRATA_SPEC.md` §5.7 sketches Reflect Agent as a cron that emits proposals. The detection sub-layer is independently testable and useful — it surfaces the signal regardless of what later transforms them into action. We carve it out so each piece can be tested with seeded fixtures + the real DB.

Each detector is a pure DB read function: same input → same signals. The optional LLM call inside `detectNewCapabilityEmergence` is gated on `deps.llmClient` being present AND backed by a real model (heuristic backend → we use the slug fallback).

## Goals / Non-Goals

**Goals:**
- Detectors are testable with fixture data, no mocks of `Date`/`Math`/`random`.
- Thresholds live in one exported constant (`REFLECT_THRESHOLDS`) so the cron change can override from `config.reflect.*`.
- `EvolutionSignal` introspection is SQL-only — read `sqlite_master.sql` for the business table's column list, then `SELECT COUNT(...) GROUP BY col` per TEXT column.
- All signals carry a `signal_strength` in `[0, 1]` so the proposal generator can rank.
- LLM is optional and pluggable. When absent, suggested names are deterministic.

**Non-Goals:**
- No correlation across signals (e.g., "schema-evolution candidates also have decay signals"). Each detector is independent.
- No deduplication across runs. If the same signal fires twice (because the proposal hasn't been processed yet), the proposal-generator change handles cooldown — not us.
- No per-capability custom rules. Detection logic is uniform.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/reflect/types.ts` | new | Signal union types + `ReflectThresholds`, `REFLECT_THRESHOLDS`. |
| `src/reflect/scanner.ts` | new | `scanRawEvents(deps, opts)`. |
| `src/reflect/emergence_detector.ts` | new | `detectNewCapabilityEmergence`, `detectSchemaEvolutionNeed`. |
| `src/reflect/decay_detector.ts` | new | `detectArchiveCandidates`. |
| `src/reflect/index.ts` | new | Barrel. |
| `src/reflect/scanner.test.ts`, `emergence_detector.test.ts`, `decay_detector.test.ts` | new | Per-detector tests with seeded fixtures. |

## Decisions

### D1 — Heuristic clustering by `event_type` (not embeddings)

The spec wants embedding-based clustering. We don't have embeddings yet. The honest V1: bucket `unclassified` + `unbound-capability` events by their `event_type` string (or `'unclassified'` for null). Each non-empty bucket past thresholds becomes one signal. A future change wires real clustering on top.

### D2 — Optional LLM upgrade for the suggested_name

`detectNewCapabilityEmergence(deps)` accepts `deps.llmClient?: LLMClient` AND `deps.useLLM?: boolean`. When both are true and `llmClient` is the real backend (not heuristic), we synthesise a smart-tier prompt with sample event summaries and ask for a `{ suggested_name, rationale }`. On any failure (or when the deps say no LLM), fall back to `slugify(event_type)`.

We detect "real backend" indirectly: the deps bag passes `llmClient` directly. Callers (cron) decide whether to pass it.

### D3 — Skew detection via SQL

For each active capability, run:

```sql
SELECT
  <textCol> AS value,
  COUNT(*) AS n
FROM <primary_table>
WHERE <textCol> IS NOT NULL
GROUP BY <textCol>
```

…then compute total / max ratio. A column qualifies as "TEXT-like" when `PRAGMA table_info(<primary_table>)` reports `type LIKE 'TEXT%'` AND the column name doesn't end in `_at` (timestamps look skewed by nature). We skip `id`, `raw_event_id`, `currency` (skew is the expected use).

### D4 — `signal_strength` formulas

- Emergence: `min(size / 30, 0.95)` — caps below 1 to leave room for the LLM to disagree.
- Schema evolution: `min(maxRatio, 0.95)` — same cap rationale.
- Decay: `min(daysSinceWrite / 180, 0.95)` — 180 days inactive → near-max signal.

### D5 — Defaults pinned in `REFLECT_THRESHOLDS`

```ts
{
  emergence: { min_cluster_size: 10, min_span_days: 7 },
  evolution: { field_skew_threshold: 0.6, min_rows_for_skew_check: 30 },
  decay: { days_since_last_write: 90, days_since_last_read: 30 },
}
```

The cron change reads `config.reflect.*` and merges over these defaults at runtime; detectors can accept overrides via `opts.thresholds` for tests.

### D6 — Excluded columns: `id`, `raw_event_id`, `currency`, `*_at`

Per D3, the skew check skips these because they're either intrinsically skewed (currency is mostly CNY) or unique (id). The skew of `merchant` or `category` is what we're after.

## Risks / Trade-offs

- **Heuristic clustering misses semantic relationships** — "买了咖啡" and "drank latte" land in different `event_type` buckets when both should be `consumption`. Pre-LLM, this is acceptable; the agent assigns event_type during capture so most buckets converge over time.
- **Skew detection can false-positive on small business tables.** Mitigated by `min_rows_for_skew_check=30`.
- **Decay thresholds are aggressive.** A user who only reads once a month sees an archive proposal in their face often. The cron change throttles via the existing `proposals.cooldown_until` mechanism.
