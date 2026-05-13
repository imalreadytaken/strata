## Why

Builds run for minutes; the user shouldn't sit in silence. The runner emits stream-json events (assistant text, tool calls, results) at every step — turning those into useful, readable progress updates is its own concern.

`progress_forwarder` is a small layer between `StreamJsonEvent` and "a string the orchestrator can send to Telegram". It:

- Maps each event to a human-readable line.
- Batches consecutive events within a short window so we don't spam the user with one message per token.
- Throttles via a configurable burst budget (`maxEventsPerBatch`, `flushIntervalMs`).
- Surfaces tool-call summaries with their argument synopsis, not full payloads.

The orchestrator (next change) instantiates one forwarder per build run, passes `onEvent` to `runClaudeCode`, and supplies the IM-side `send` callback.

References: `STRATA_SPEC.md` §5.8 ("progress_forwarder.ts: 转发进度到 Telegram"), `add-claude-code-runner` (provides `StreamJsonEvent`).

## What Changes

- Add `build-progress-forwarder` capability covering:
  - **`BuildProgressForwarder`** class with:
    - constructor `(opts: { send: (text: string) => Promise<void>; maxEventsPerBatch?: number; flushIntervalMs?: number; logger?: Logger })`.
    - `onEvent(event: StreamJsonEvent): void` — synchronous; enqueues a line for the next flush.
    - `flush(): Promise<void>` — drains the current batch via `send`. Safe to call concurrently with `onEvent`.
    - `start(): void` / `stop(): Promise<void>` — installs / clears the `setInterval` that calls `flush` every `flushIntervalMs` (default `1500`). `stop` does one final `flush`.
  - **`formatStreamJsonEvent(event): string | null`** — pure helper that turns one event into a one-line string (or `null` to drop). Exported for testing.
  - **`summarizeToolUse(raw): string`** — pure helper for tool-call rendering: `<tool_name>(arg=value, arg=value, …)` capped at ~120 chars.
  - **`summarizeToolResult(raw): string`** — pure helper for tool results.

## Capabilities

### New Capabilities
- `build-progress-forwarder`: stream-json event → batched IM text forwarder for Build Bridge.

### Modified Capabilities
*(none — orchestrator change consumes it)*

## Impact

- **Files added**:
  - `src/build/progress_forwarder.ts` — `BuildProgressForwarder` class + `formatStreamJsonEvent` + summary helpers.
  - `src/build/progress_forwarder.test.ts` — formatting per event kind, batching, throttling, stop semantics.
- **Files modified**:
  - `src/build/index.ts` — re-export the forwarder surfaces.
- **Non-goals**:
  - No persistence of progress to disk — the orchestrator can opt to log via its own logger.
  - No Markdown formatting / Telegram-specific rendering. The forwarder produces plain text; the IM-side caller decides formatting.
  - No backpressure on `send`. If the IM channel is slow, batches accumulate in memory; the forwarder doesn't await `send` blocking the runner.
