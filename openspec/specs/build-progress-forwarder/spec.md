# build-progress-forwarder Specification

## Purpose

`build-progress-forwarder` converts Claude Code's stream-json events into IM-friendly progress updates. `formatStreamJsonEvent` is the pure per-event formatter; `BuildProgressForwarder` is the class that batches and flushes them on a timer. `onEvent` enqueues synchronously (cheap), the timer's flush drains up to `maxEventsPerBatch` lines and ships them as one joined message via the caller's `send`. `thinking` events drop. `send` rejections are warn-logged, not propagated. `stop()` flushes once before shutting down. The orchestrator (build coordinator) instantiates one forwarder per build, passes `onEvent` to `runClaudeCode`, and supplies the IM-side `send`.

## Requirements
### Requirement: `formatStreamJsonEvent` renders one event into a single line of text

The system SHALL export `formatStreamJsonEvent(event: StreamJsonEvent): string | null` with the following mapping:

- `system` → `🔧 system: <model or session id when present>`
- `assistant` → `💬 <content excerpt up to ~200 chars>`
- `thinking` → `null` (dropped — too noisy)
- `tool_use` → `🛠 <summarizeToolUse(raw)>`
- `tool_result` → `↳ <summarizeToolResult(raw)>`
- `result` → `✅ result: <summary>` or `❌ result: <error>` when `raw.is_error === true`
- `parse_error` → `⚠ parse_error: <raw excerpt>`
- `unknown` → `· <type>` when `raw.type` is a string, else `· unknown`

#### Scenario: assistant event renders with 💬 prefix

- **WHEN** `formatStreamJsonEvent({ type: 'assistant', raw: { content: 'hi' } })`
- **THEN** the result starts with `'💬 '` and contains `'hi'`

#### Scenario: thinking returns null

- **WHEN** `formatStreamJsonEvent({ type: 'thinking', raw: {} })`
- **THEN** the result is `null`

#### Scenario: tool_use renders name + args

- **WHEN** `formatStreamJsonEvent({ type: 'tool_use', raw: { name: 'Edit', input: { path: '/x', content: 'y' } } })`
- **THEN** the result starts with `'🛠 Edit('` and contains both `path` and `content`

### Requirement: `summarizeToolUse` and `summarizeToolResult` cap output length

`summarizeToolUse(raw)` SHALL produce `name(k=v, k=v, …)` where each value is at most 32 chars (with `…` continuation) and the total output is at most 120 chars (with `…` continuation on the args list).

`summarizeToolResult(raw)` SHALL produce at most ~200 chars of text content; when `raw.is_error === true`, output is prefixed with `error: `.

#### Scenario: Long arg value is truncated

- **WHEN** `summarizeToolUse({ name: 'Edit', input: { content: 'x'.repeat(200) } })`
- **THEN** the output contains `xxx…` (less than 32 chars of `x`) and not a full 200-char run

#### Scenario: Error tool result is prefixed

- **WHEN** `summarizeToolResult({ content: 'bad', is_error: true })`
- **THEN** the output starts with `'error: '`

### Requirement: `BuildProgressForwarder` batches and flushes events

The system SHALL export `BuildProgressForwarder` with:

- `onEvent(event)` — synchronous; formats via `formatStreamJsonEvent` and enqueues the resulting line (no enqueue when the line is `null`).
- `flush()` — drains up to `maxEventsPerBatch` lines, joins with `'\n'`, awaits `send(joinedText)`. Returns without calling `send` when the queue is empty. Catches + warn-logs `send` rejections.
- `start()` — installs a `setInterval(flush, flushIntervalMs)`. Idempotent.
- `stop()` — clears the interval and performs one final `flush()`.

#### Scenario: Three events flush as one batched message

- **WHEN** `onEvent` is called three times with non-thinking events, `start()` is active, and `flushIntervalMs` elapses
- **THEN** `send` is called exactly once with the three formatted lines joined by `'\n'`

#### Scenario: maxEventsPerBatch caps a single flush

- **WHEN** 30 events have been enqueued and `maxEventsPerBatch = 10`
- **THEN** the next flush sends exactly 10 lines and leaves 20 in the queue

#### Scenario: Empty queue does not call send

- **WHEN** `flush()` is called with nothing queued
- **THEN** `send` is NOT invoked

#### Scenario: stop() performs a final flush

- **WHEN** events have been enqueued and `stop()` is called before any timer tick
- **THEN** `send` is called once with the pending lines before `stop()` resolves

#### Scenario: send rejection does not propagate

- **WHEN** the `send` callback rejects
- **THEN** `flush()` resolves without throwing and the queue advances past the failed batch

