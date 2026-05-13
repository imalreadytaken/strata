## 1. Formatters

- [x] 1.1 Create `src/build/progress_forwarder.ts` exporting:
  - `formatStreamJsonEvent(event: StreamJsonEvent): string | null` — per-event template per design D1; `null` for `thinking` (drop) and otherwise.
  - `summarizeToolUse(raw): string` — `name(k=v, …)` capped at 120 chars, each value capped at 32.
  - `summarizeToolResult(raw): string` — first 200 chars; `error: <…>` prefix when `raw.is_error === true`.

## 2. Class

- [x] 2.1 Export `BuildProgressForwarder` class:
  - Constructor: `{ send, maxEventsPerBatch = 25, flushIntervalMs = 1500, logger? }`.
  - `onEvent(event)`: formats and enqueues; returns immediately.
  - `flush()`: drains up to `maxEventsPerBatch` lines, joins with `'\n'`, awaits `send`. Catches + warn-logs `send` rejections.
  - `start()`: installs `setInterval`. Idempotent.
  - `stop()`: clears interval; performs one final `flush()`.
  - `pending()`: returns the current queue length (test helper).

## 3. Tests

- [x] 3.1 `src/build/progress_forwarder.test.ts`:
  - Per-event format: assistant / tool_use / tool_result / result / parse_error / unknown each map to the documented prefix.
  - `thinking` returns `null`.
  - `summarizeToolUse` truncates long arg values to 32 chars and overall to 120.
  - `summarizeToolResult` handles string content, array-of-text content, error content.
  - Batching: with `vi.useFakeTimers`, emit 3 events, advance time → `send` is called once with all 3 joined by `'\n'`.
  - Cap: emit 50 events with `maxEventsPerBatch=10`, advance time → first flush ships 10 lines, second flush ships 10 more.
  - Empty batches don't call `send`.
  - `stop()` performs a final flush even when no timer has fired.
  - `send` rejection is swallowed (no `unhandledRejection`).

## 4. Barrel

- [x] 4.1 `src/build/index.ts`: re-export the forwarder.

## 5. Integration

- [x] 5.1 `npm run typecheck` clean.
- [x] 5.2 `npm test` all pass.
- [x] 5.3 `openspec validate add-build-progress-forwarder --strict`.
