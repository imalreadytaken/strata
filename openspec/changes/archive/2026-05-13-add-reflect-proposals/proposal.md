## Why

`reflect-detectors` produces typed `ReflectSignal[]`. The next link in the chain is turning those into rows in `proposals` (the existing table from P1) so the user can review them. Two side concerns matter:

1. **Dedup** — the cron fires weekly; the same signal may surface multiple weeks in a row. We don't want to flood the user with duplicate proposals. The check: skip when a `pending` proposal already exists for the same `kind` + `target_capability` (for evolution/decay) or for the same `kind` + same `evidence_event_ids` overlap (for emergence).
2. **Cooldown** — when the user previously *declined* a proposal, the row carries `cooldown_until`. Until that timestamp passes, we don't regenerate the same proposal.

`pushProposalsToUser` is intentionally thin — it stamps `pushed_to_user_at` and calls a supplied `notify` callback (the cron change wires it to Telegram).

References: `STRATA_SPEC.md` §5.7 (Reflect overview), §3.1 `proposals` table (`status='pending'`, `cooldown_until`, `pushed_to_user_at`, `evidence_event_ids`).

## What Changes

- Add `reflect-proposals` capability covering:
  - **`generateProposals(signals, deps): Promise<GenerateProposalsResult>`** — for each signal:
    - Look up potential duplicate `pending` rows (by `kind` + `target_capability` or `kind` + evidence overlap).
    - Look up cooldown candidates (declined rows where `cooldown_until > now()`).
    - On match: skip (counted in `skipped[]`).
    - Otherwise INSERT a `proposals` row: `source='reflect_agent'`, `kind=<signal.kind>`, `title=...`, `summary=...`, `rationale=...`, `proposed_design=...`, `signal_strength=...`, `evidence_event_ids=JSON`, `status='pending'`.
    - Returns `{ inserted: ProposalRow[]; skipped: SkippedReason[] }`.
  - **`pushProposalsToUser(proposals, deps): Promise<void>`** — for each `inserted` row, call `deps.notify(row)` (caller-supplied) AND stamp `pushed_to_user_at = now()`. Failures in `notify` are warn-logged and don't propagate.
  - **`renderProposalCard(row): { text: string }`** — pure helper that returns an IM-friendly summary of one proposal (the cron's `notify` will use this).

## Capabilities

### New Capabilities
- `reflect-proposals`: signal → proposals-row writer with dedup + cooldown + push hook.

### Modified Capabilities
*(none — uses existing `proposals` repo)*

## Impact

- **Files added**:
  - `src/reflect/proposal_generator.ts` — `generateProposals`, `renderProposalCard`, `GenerateProposalsResult` types.
  - `src/reflect/push.ts` — `pushProposalsToUser`, `PushDeps`.
  - `src/reflect/proposal_generator.test.ts`, `src/reflect/push.test.ts`.
- **Files modified**:
  - `src/reflect/index.ts` — re-exports.
- **Non-goals**:
  - No IM transport. `notify` is a callback the caller supplies (the cron change wires it to Telegram via the existing channels surface).
  - No automatic build triggering on `'approved'` proposals. The build-trigger change (B) handles that.
  - No proposal expiry sweep — the row's `expires_at` column exists; a future cron change can clean it.
