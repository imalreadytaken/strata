## Context

`runClaudeCode` invokes `onEvent` for every parsed stream-json line. Some events are noisy (`thinking` chunks may emit dozens per second); others carry real signal (`tool_use`, `tool_result`, `result`). We want the user to see meaningful progress without being drowned, AND the orchestrator should be able to flush remaining events on shutdown.

A small class encapsulates: a queue, a flush timer, and a `send` sink. `formatStreamJsonEvent` is exported separately so per-event tests don't need to spin up the class.

## Goals / Non-Goals

**Goals:**
- `onEvent` is synchronous and cheap — it just pushes a formatted string to a queue. Never awaits anything.
- The forwarder owns the timer; `start()` / `stop()` make it explicit so tests use fake timers cleanly.
- `flush()` is idempotent and concurrency-safe (uses a simple "draining" flag).
- Empty batches don't call `send` — no spammy heartbeats.
- `send` rejection is logged at `warn` and never propagated.

**Non-Goals:**
- No Markdown rendering. Plain text only; Telegram-side helpers can wrap.
- No persistence across crashes — if Strata restarts mid-build, progress for that build is lost (the underlying claude session id lets the orchestrator resume; progress catch-up isn't worth the storage).
- No de-dup. Two identical lines emit twice.
- No filtering by severity. Caller can wrap `onEvent` if they want a richer policy.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/progress_forwarder.ts` | new | `BuildProgressForwarder`, `formatStreamJsonEvent`, `summarizeToolUse`, `summarizeToolResult`. |
| `src/build/progress_forwarder.test.ts` | new | Per-event formatting + batching + stop semantics. Uses `vi.useFakeTimers`. |
| `src/build/index.ts` | modified | Re-export. |

## Decisions

### D1 — Per-event formatting templates

- `system` → `🔧 system: <model or session id>`
- `assistant` → `💬 <text excerpt, truncated to ~200 chars>`
- `thinking` → dropped (null). Too noisy.
- `tool_use` → `🛠 <tool>(<args summary>)`
- `tool_result` → `↳ <success or first line of output>`
- `result` → `✅ result: <summary>` or `❌ result: <error>`
- `parse_error` → `⚠ parse_error: <raw line excerpt>`
- `unknown` → `· <type>` (low-signal but lets the user see something happened)

### D2 — Argument summarisation

`summarizeToolUse(raw)` reads `raw.name` and `raw.input` (Claude's tool-call shape). Renders `name(k=v, k=v, …)` with each value truncated to 32 chars. Total cap of 120 chars; overflow becomes `…`. Strings get quoted; numbers / booleans pass through.

### D3 — Tool-result summarisation

`summarizeToolResult(raw)` reads `raw.content`. If it's a string, render the first 200 chars. If it's an array with `text` entries, concat + truncate. If it's an error (`raw.is_error === true`), prefix with `error: `.

### D4 — Batching policy

`maxEventsPerBatch` (default `25`) — if the queue exceeds this between flushes, the timer-tick flush ships the cap and leaves the rest for the next tick. `flushIntervalMs` (default `1500`) — `setInterval` cadence. On `onEvent` we DO NOT pre-empt the timer; users see updates at the next tick.

A single `send` call carries the batch joined with `'\n'`. Long batches stay one message (Telegram's 4096-char limit is the caller's concern; the forwarder isn't channel-aware).

### D5 — `send` errors are caught + logged

Rejection of the IM send shouldn't tear down the runner. We catch + `logger.warn(...)`. The dropped messages are gone — V1 is fine with that.

## Risks / Trade-offs

- **Memory growth on a fast-emitting build with a slow `send`.** Theoretical: at ~200 events/second, the queue grows ~200 lines/s. Realistically a build is dozens of events per minute. No bound needed.
- **`thinking` drop loses signal**. If the orchestrator wants thinking traces, it can keep its own listener separately.
- **No structured per-stage view**. The orchestrator can layer one on top (e.g., "starting plan_phase…") via its own `send` calls between runner invocations.
