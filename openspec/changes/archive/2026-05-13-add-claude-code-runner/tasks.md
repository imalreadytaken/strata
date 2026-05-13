## 1. Stream-json types

- [x] 1.1 Create `src/build/claude_code_runner.ts` exporting `StreamJsonEvent` as a discriminated union: `assistant | user | tool_use | tool_result | thinking | system | result | parse_error | unknown`. Each variant carries its raw payload as `raw: unknown` so consumers never lose data.

## 2. Pure parser

- [x] 2.1 Export `parseStreamJsonLines(chunk: string, leftover: string): { events: StreamJsonEvent[]; leftover: string }`:
  - Concatenate `leftover + chunk`.
  - Split on `\n`; the last (possibly incomplete) piece becomes the next call's `leftover`.
  - For each non-empty line, `JSON.parse`; on success classify by `type`; on failure emit `{ type: 'parse_error', raw, error }`.
- [x] 2.2 Trim trailing `\r` before parsing (Windows-style line endings).

## 3. Runner

- [x] 3.1 Export `RunClaudeCodeOptions` with fields: `workdir` (required string), `prompt`, `mode: 'explore' | 'apply' | 'propose'`, `maxTurns`, `resumeSessionId?`, `onEvent: (event: StreamJsonEvent) => void`, `env?: Record<string, string>`, `spawn?: typeof import('node:child_process').spawn` (default to the real one), `signal?: AbortSignal`.
- [x] 3.2 Export `RunHandle = { pid: number | undefined; result: Promise<RunClaudeCodeResult> }` and `RunClaudeCodeResult = { exitCode: number; eventCount: number; stderr: string }`.
- [x] 3.3 Export `runClaudeCode(opts): RunHandle`:
  - Validates `workdir` exists; throws synchronously otherwise.
  - Builds the arg list per `STRATA_SPEC.md` §5.8.4.
  - Spawns; subscribes to stdout for parsing, stderr for accumulation.
  - On `exit`, resolves with `{ exitCode, eventCount, stderr }`.
  - If `opts.signal` aborts, sends `SIGTERM` to the subprocess and resolves with `{ exitCode: -1, eventCount, stderr }`.
- [x] 3.4 Export `abortRunClaudeCode(handle, opts?: { graceMs?: number }): Promise<void>` — sends `SIGTERM`, then `SIGKILL` after `graceMs` (default 5000); resolves once the subprocess exits.

## 4. Tests

- [x] 4.1 `parseStreamJsonLines` cases (≥ 10):
  - Empty chunk + empty leftover → `{ events: [], leftover: '' }`.
  - One full line → 1 event.
  - Two full lines in one chunk → 2 events.
  - Partial line at end → leftover preserved.
  - Multiple chunks completing one event → single event when newline arrives.
  - Malformed JSON → `parse_error` event with `raw` containing the offending line.
  - `\r\n` line endings → parsed correctly.
  - Empty lines between events → skipped (not emitted as parse_error).
  - Each known `type` value classifies to the right discriminant.
  - Unknown `type` falls through to `{ type: 'unknown', raw }`.
- [x] 4.2 `runClaudeCode` happy-path test with a fake spawner that:
  - Writes 3 lines of valid stream-json to stdout.
  - Writes "warn: …" to stderr.
  - Exits with code 0.
  Asserts: `onEvent` invoked 3 times with the right discriminants; `result` resolves with `exitCode=0`, `eventCount=3`, `stderr` containing 'warn'.
- [x] 4.3 `runClaudeCode` with a malformed line:
  - Stream emits two valid lines + one malformed + one valid.
  - Asserts: `onEvent` called 4 times; one of them is a `parse_error`.
- [x] 4.4 `runClaudeCode` validation: missing `workdir` throws synchronously; non-existent `workdir` also throws.
- [x] 4.5 `abortRunClaudeCode` test:
  - Fake spawner that ignores SIGTERM until `graceMs` elapses, then exits with 143.
  - Use `graceMs: 0` to force SIGKILL; asserts the kill signal was issued.
- [x] 4.6 `runClaudeCode` with `opts.signal`:
  - Caller aborts via `AbortSignal`; runner sends SIGTERM; result resolves with `exitCode: -1`.

## 5. Integration

- [x] 5.1 `npm run typecheck` clean.
- [x] 5.2 `npm test` all pass.
- [x] 5.3 `openspec validate add-claude-code-runner --strict`.
