## 1. Types

- [x] 1.1 Create `src/reflect/proposal_generator.ts` exporting:
  - `SkippedReason = { kind: ReflectSignal['kind']; reason: 'duplicate_pending' | 'cooldown'; identity: string }`.
  - `GenerateProposalsResult = { inserted: ProposalRow[]; skipped: SkippedReason[] }`.
  - `GenerateProposalsDeps = { proposalsRepo: ProposalsRepository; logger: Logger; now?: () => Date }`.

## 2. `generateProposals`

- [x] 2.1 Iterate `signals`. Per signal:
  - Compute `identity` (target_capability for evolution/decay; sorted evidence ids for emergence).
  - Load all `pending` and recently-`declined` rows from `proposalsRepo`.
  - Skip when pending row matches (evolution/decay by `kind+target_capability`; emergence by evidence overlap).
  - Skip when declined row matches AND `cooldown_until > now`.
  - Else INSERT a proposals row: `source='reflect_agent'`, `kind=<signal.kind>`, `title=<rendered>`, `summary=<rendered>`, `rationale=<signal.rationale>`, `proposed_design=JSON(signal)`, `signal_strength`, `evidence_event_ids=JSON(signal.evidence_event_ids when present)`, `target_capability=<signal.target_capability when present>`, `status='pending'`, `created_at=now`.
- [x] 2.2 Return `{ inserted, skipped }`.

## 3. `renderProposalCard`

- [x] 3.1 Pure function: row → `{ text: string }` per design D3 templates.

## 4. `pushProposalsToUser`

- [x] 4.1 Create `src/reflect/push.ts` exporting `pushProposalsToUser(proposals, deps): Promise<void>` where `deps = { proposalsRepo, notify: (row, card) => Promise<void>, logger, now? }`.
- [x] 4.2 For each row: render card, await `notify(row, card)` inside try/catch (warn-log on failure), then `proposalsRepo.update(row.id, { pushed_to_user_at: now })`.

## 5. Tests

- [x] 5.1 `src/reflect/proposal_generator.test.ts`:
  - One emergence signal → one inserted row with correct shape.
  - One evolution signal → one inserted row with `target_capability` set.
  - One decay signal → one inserted row.
  - Dedup: re-run with the same signal → second time `inserted.length === 0`, `skipped[0].reason === 'duplicate_pending'`.
  - Cooldown: pre-create a `declined` row with `cooldown_until > now`. New matching signal → skipped (`'cooldown'`).
  - Emergence overlap: pending row with `evidence_event_ids=[1,2,3]`; new signal with `[3,4,5]` → skipped (overlap).
  - `renderProposalCard`: returns a string containing the kind + key facts for each kind.
- [x] 5.2 `src/reflect/push.test.ts`:
  - `notify` called once per row; rows get `pushed_to_user_at` stamped.
  - `notify` rejection → warn log, no throw, `pushed_to_user_at` still stamped.

## 6. Barrel

- [x] 6.1 `src/reflect/index.ts` re-exports `generateProposals`, `renderProposalCard`, `pushProposalsToUser`, types.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-reflect-proposals --strict`.
