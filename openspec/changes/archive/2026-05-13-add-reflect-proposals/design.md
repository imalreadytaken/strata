## Context

The proposals table already supports both Reflect and user-initiated sources. The generator just maps `ReflectSignal` shape → `ProposalRow` shape with sensible field renders. Dedup and cooldown are the two non-trivial bits.

## Goals / Non-Goals

**Goals:**
- `generateProposals` is pure-ish: same input → same DB writes. Idempotent across calls when no time advances.
- `skipped[]` carries explicit reasons (`'duplicate_pending'`, `'cooldown'`) so the cron can log them.
- `pushProposalsToUser` doesn't itself talk to IM — `deps.notify` is the boundary.
- Rendering an IM card is pure: input row → text. Tests pin the format.

**Non-Goals:**
- No batching of related signals. One signal → one proposal row.
- No `confidence`-based prioritisation. The order of `signals` is the order of inserts.
- No automatic state transitions (`approved` / `declined`). Those happen via user callbacks, owned by the cron change.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/reflect/proposal_generator.ts` | new | `generateProposals`, `renderProposalCard`, `GenerateProposalsResult`. |
| `src/reflect/push.ts` | new | `pushProposalsToUser`, `PushDeps`. |
| `src/reflect/proposal_generator.test.ts` | new | Per-signal-kind insert; dedup; cooldown; idempotent re-run. |
| `src/reflect/push.test.ts` | new | Push calls notify per row; stamps pushed_to_user_at; notify failure swallowed. |
| `src/reflect/index.ts` | modified | Re-exports. |

## Decisions

### D1 — Dedup by `(kind, target_capability)` for evolution/decay; by overlap of `evidence_event_ids` for emergence

- Evolution / decay: a `kind='schema_evolution' AND target_capability='expenses'` pending row implies "we already told the user about this." Skip.
- Emergence: `target_capability` is `null` (or the would-be name, which differs across runs). Instead we check if any pending `kind='new_capability'` proposal already references one of the new signal's evidence event ids in its `evidence_event_ids` JSON. Overlap → skip.

### D2 — Cooldown is checked against declined rows

A pending row blocks via D1's dedup; a declined row blocks via cooldown. We read declined proposals whose `cooldown_until > now()`; same key match → skip.

### D3 — `renderProposalCard` keeps it short

The IM card is one line of header + 2–3 lines of body. The full rationale is in the row; the card is a teaser.

```
🌱 Strata proposal #N (schema_evolution)
expenses.category='dining' is 70% of 50 rows.
Consider a subcategory split. (signal: 0.70)
```

### D4 — `pushProposalsToUser` updates `pushed_to_user_at` even when `notify` fails

The user might still see the proposal via a future query; "this proposal was attempted to be pushed at <ts>" is operationally useful. Failure of `notify` itself logs at warn.

### D5 — Skipped reasons are typed

`SkippedReason = { kind: ReflectSignal['kind']; reason: 'duplicate_pending' | 'cooldown'; identity: string }`. Cron-side code can count + report.

## Risks / Trade-offs

- **Emergence dedup is overlap-based**, so a partial-overlap cluster (e.g., 12 new events + 3 from a previous signal) still generates a fresh proposal. Acceptable: the new evidence is genuinely different.
- **Cooldown timestamps are user-set via the callback** in the next change. Until then, no rows ever land in cooldown unless something else writes them.
