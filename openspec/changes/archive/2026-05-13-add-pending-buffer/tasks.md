## 1. Persistence helpers

- [x] 1.1 Create `src/pending_buffer/persistence.ts` exporting:
  - `readState(file: string): Record<string, number[]>` — `JSON.parse(readFileSync(file))`, returns `{}` on ENOENT or parse error
  - `writeState(file: string, state: Record<string, number[]>): void` — atomic write via `writeFileSync(tmp); renameSync(tmp, file)` after `mkdirSync(dirname(file), { recursive: true })`
- [x] 1.2 Cover persistence in tests as part of the buffer test file (round-trip, missing-file, atomic rename).

## 2. PendingBuffer class

- [x] 2.1 Create `src/pending_buffer/index.ts` exporting `PendingBuffer` and `PendingBufferOptions = { stateFile: string; logger?: Logger }`.
- [x] 2.2 Constructor loads `stateFile` into an in-memory `Map<string, Set<number>>` preserving insertion order.
- [x] 2.3 Implement `add` / `has` / `getAll` / `remove` / `clearSession` / `snapshot`. Every mutation calls a private `persist()` that wraps `writeState(stateFile, this.toJSON())` in try/catch and logs at `warn` level on failure.
- [x] 2.4 Re-export `startPendingTimeoutLoop` from `./timeout.js`.

## 3. Timeout loop

- [x] 3.1 Create `src/pending_buffer/timeout.ts` exporting:
  - `startPendingTimeoutLoop(deps): () => void`
  - `deps`: `{ pendingBuffer, rawEventsRepo, timeoutMinutes, logger, pollEveryMs?: number; now?: () => string }`
- [x] 3.2 Implementation:
  - `const AUTO_COMMIT_CONFIDENCE_THRESHOLD = 0.7;`
  - One tick: `const rows = await rawEventsRepo.findExpiredPending(timeoutMinutes)`
  - For each `row`: update status to `'committed'` (with `committed_at`) when `extraction_confidence >= 0.7`, else `'abandoned'` (with `abandoned_reason = 'pending_timeout'`); then `pendingBuffer.remove(row.session_id, row.id)`; log at info level
  - Loop wraps the tick in try/catch — a per-tick exception is logged and does not stop the interval
- [x] 3.3 Return `() => { clearInterval(handle); }` with the standard idempotent-stop guard.

## 4. Runtime + plugin entry wiring

- [x] 4.1 In `src/runtime.ts`: construct `PendingBuffer({ stateFile: <dataDir>/.strata-state/pending_buffer.json, logger })`; add it to `StrataRuntime`.
- [x] 4.2 In `src/index.ts`: after `installMessageHooks`, call `startPendingTimeoutLoop` with `{ pendingBuffer, rawEventsRepo, timeoutMinutes: config.pending.timeoutMinutes, logger }`.

## 5. Tests

- [x] 5.1 `src/pending_buffer/index.test.ts` (10 tests): CRUD across two sessions, idempotent add/remove, clearSession, has, persistence round-trip (and second-instance pickup), missing state file → empty, unparseable state file → empty, unwritable state file → `add` still resolves with warn log captured.
- [x] 5.2 `src/pending_buffer/timeout.test.ts` (5 tests): fake-timers test of the loop — high-conf row commits, low-conf row abandons, NULL confidence row abandons, fresh row left alone, stop() halts and is idempotent.

## 6. Integration

- [x] 6.1 Run `npm run typecheck` → clean.
- [x] 6.2 Run `npm test` → all tests pass (122 total).
