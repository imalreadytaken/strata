## 1. Runner

- [x] 1.1 Create `src/reflect/runner.ts` exporting `runReflectOnce(deps): Promise<ReflectRunResult>`:
  - `ReflectRunDeps = { db, capabilityRegistryRepo, capabilityHealthRepo, proposalsRepo, logger, llmClient?, notify?, useLLM?, thresholds?, now? }`.
  - `ReflectRunResult = { signals: ReflectSignal[]; generated: GenerateProposalsResult; pushed: number }`.
  - Calls `detectNewCapabilityEmergence` + `detectSchemaEvolutionNeed` + `detectArchiveCandidates`, concatenates signals, runs `generateProposals`, then `pushProposalsToUser(generated.inserted, ...)` when `deps.notify` is supplied.

## 2. Cron

- [x] 2.1 Create `src/reflect/cron.ts` exporting `startReflectAgent(deps, opts?): () => void`:
  - `opts = { schedule?: { dayOfWeek: 0–6; hour: 0–23 }; intervalMs?: number; now?: () => Date }`. Defaults: `dayOfWeek=0`, `hour=3`, `intervalMs=3_600_000`.
  - `setInterval(check, intervalMs)`. Inside: `if (day/hour mismatch) return; if (alreadyFiredThisWeek(now, deps.proposalsRepo)) return; await runReflectOnce(deps).catch(log)`.
  - Returns a `stop` function that `clearInterval`s; idempotent.
- [x] 2.2 `alreadyFiredThisWeek(now, repo)`: read `proposals` WHERE `source='reflect_agent'` AND `created_at >= now - 6 days`; true if any.

## 3. Callback

- [x] 3.1 Create `src/reflect/callback.ts` exporting:
  - `parseReflectPayload(payload): { action: 'approve' | 'decline'; proposalId: number } | null`.
  - `buildReflectKeyboard(proposalId): PluginInteractiveButtons` — `[[ ✅ approve, ❌ decline ]]` with `callback_data='strata-propose:<action>:<id>'`.
  - `handleReflectCallback(deps)`: parses payload; on `approve` → `proposalsRepo.update({ status: 'approved', responded_at: now })` + edit message; on `decline` → `{ status: 'declined', responded_at: now, cooldown_until: now+30d }` + edit message. Errors warn-logged, never propagated.

## 4. Plugin entry + runtime

- [x] 4.1 Modify `src/runtime.ts`: add `stopReflect?: () => void` to `StrataRuntime`.
- [x] 4.2 Modify `src/index.ts`: after `installTriageHook`, call `startReflectAgent(deps)` and `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata-propose', handler: handleReflectCallback(deps) })`. Stow the stop handle on `runtime.stopReflect`.

## 5. Barrel

- [x] 5.1 `src/reflect/index.ts` re-exports.

## 6. Tests

- [x] 6.1 `src/reflect/runner.test.ts`:
  - Seeded DB triggers each detector → `runReflectOnce` returns a result with `inserted.length > 0`. No notify supplied → `pushed = 0`. With notify → `pushed = inserted.length`.
- [x] 6.2 `src/reflect/cron.test.ts`:
  - Fake timer + injected `now` = Sunday 03:00 → fires once after first interval tick.
  - Mid-week tick → no fire.
  - Wrong hour → no fire.
  - Already-fired-this-week (pre-seeded reflect_agent proposal) → no fire even when in the window.
  - `stop()` clears the interval; subsequent ticks do nothing.
- [x] 6.3 `src/reflect/callback.test.ts`:
  - `parseReflectPayload` happy + malformed cases.
  - `handleReflectCallback` approve path: proposal status flips to `'approved'`, `editMessage` called with cleared buttons.
  - `handleReflectCallback` decline path: status flips to `'declined'`, `cooldown_until = now + 30d`.
  - Missing proposal → warn-log + cleared buttons, no throw.
  - Malformed payload → warn-log + no DB write.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-reflect-cron --strict`.
