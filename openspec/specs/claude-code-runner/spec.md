# claude-code-runner Specification

## Purpose

`claude-code-runner` is Build Bridge's bottom layer: it spawns the `claude` CLI with the `--output-format stream-json` flag set, parses each newline-delimited JSON line into a typed `StreamJsonEvent`, and forwards events to a caller-supplied `onEvent` callback. The runner is pure transport — it does not know about plans, decompositions, or builds; the orchestrator (a future change) wires those semantics on top. `parseStreamJsonLines` is a pure function (no IO) so consumers can test it in isolation. `runClaudeCode` accepts an injectable `spawn` so every test path can simulate Claude Code without it being installed. `abortRunClaudeCode` provides a graceful-then-forceful shutdown (SIGTERM → SIGKILL after grace) for stop/resume flows. Malformed stream-json lines surface as `parse_error` events rather than throwing, so a single bad line never aborts an in-flight build.

## Requirements
### Requirement: `parseStreamJsonLines` produces typed events from raw chunks

The system SHALL export `parseStreamJsonLines(chunk: string, leftover: string): { events: StreamJsonEvent[]; leftover: string }` that:

- Concatenates `leftover + chunk`.
- Splits on `\n`; trims trailing `\r` per line.
- JSON-parses each non-empty line. On success, classifies by `type` into one of the known variants (`assistant | user | tool_use | tool_result | thinking | system | result`) or `{ type: 'unknown', raw }` for unrecognised types.
- On JSON-parse failure, emits `{ type: 'parse_error', raw, error }` and continues with the next line.
- Returns the trailing partial line (or `''`) as the next call's `leftover`.

#### Scenario: A single valid line yields one event

- **WHEN** `parseStreamJsonLines('{"type":"assistant","content":"hi"}\n', '')` is called
- **THEN** the result has one event of type `'assistant'` and `leftover === ''`

#### Scenario: Partial line is preserved in leftover

- **WHEN** `parseStreamJsonLines('{"type":"assist', '')` is called
- **THEN** the result has zero events and `leftover === '{"type":"assist'`

#### Scenario: Two chunks combine into one event

- **WHEN** `parseStreamJsonLines('ant","content":"hi"}\n', '{"type":"assist')` is called
- **THEN** the result has one event of type `'assistant'`

#### Scenario: Malformed line produces a parse_error event

- **WHEN** `parseStreamJsonLines('not json\n', '')` is called
- **THEN** the result has one event of `type: 'parse_error'` whose `raw === 'not json'`

#### Scenario: Unknown type falls through to 'unknown'

- **WHEN** the line is `{"type":"some_new_type","foo":1}`
- **THEN** the event is `{ type: 'unknown', raw: { type: 'some_new_type', foo: 1 } }`

#### Scenario: Trailing CR is stripped

- **WHEN** the chunk is `'{"type":"assistant"}\r\n'`
- **THEN** the event is parsed without error

#### Scenario: Empty lines are skipped

- **WHEN** the chunk is `'\n\n{"type":"assistant"}\n'`
- **THEN** the result has exactly one event and no `parse_error` entries

### Requirement: `runClaudeCode` spawns the CLI and routes stream-json events

The system SHALL export `runClaudeCode(opts: RunClaudeCodeOptions): RunHandle`. The `RunHandle` is `{ pid, result: Promise<RunClaudeCodeResult> }` where `RunClaudeCodeResult = { exitCode, eventCount, stderr }`.

`opts` MUST include at minimum `workdir`, `prompt`, `mode`, `maxTurns`, `onEvent`. The function MUST:

1. Synchronously validate that `workdir` exists; throw otherwise.
2. Spawn `claude` with `['-p', prompt, '--output-format', 'stream-json', '--max-turns', String(maxTurns), '--allowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,TodoWrite', '--deny-tools', 'WebFetch,WebSearch', '--dangerously-skip-permissions']` plus `['--resume', resumeSessionId]` when set.
3. Pipe stdout chunks through `parseStreamJsonLines`, invoking `opts.onEvent(event)` once per event.
4. Accumulate stderr into a string.
5. Resolve `result` with `{ exitCode, eventCount, stderr }` when the subprocess exits.
6. Accept `opts.signal: AbortSignal`; on abort, send `SIGTERM` and resolve with `exitCode: -1`.
7. Accept `opts.spawn` for tests (default: `child_process.spawn`).

#### Scenario: Spawning with valid options resolves with the exit code and event count

- **WHEN** a fake spawner emits 3 valid stream-json lines and exits with code 0
- **THEN** `result` resolves to `{ exitCode: 0, eventCount: 3, stderr: '' }` and `onEvent` was called 3 times

#### Scenario: Missing workdir throws synchronously

- **WHEN** `runClaudeCode({ workdir: '/does/not/exist', ... })` is called
- **THEN** the call throws an error before returning a handle

#### Scenario: Malformed stream-json lines surface as parse_error events

- **WHEN** the subprocess emits one malformed line in the middle of valid lines
- **THEN** `onEvent` is called once with `{ type: 'parse_error', ... }` and the run still completes successfully

#### Scenario: AbortSignal terminates the subprocess

- **WHEN** the caller aborts the supplied signal before exit
- **THEN** the subprocess receives `SIGTERM` and `result` resolves with `exitCode: -1`

### Requirement: `abortRunClaudeCode` sends SIGTERM, then SIGKILL after grace

The system SHALL export `abortRunClaudeCode(handle, opts?: { graceMs?: number }): Promise<void>` that:

- Sends `SIGTERM` immediately.
- If the subprocess has not exited after `graceMs` (default `5000`), sends `SIGKILL`.
- Resolves once the subprocess exits (any reason).

#### Scenario: SIGTERM is sufficient for a cooperative subprocess

- **WHEN** the subprocess exits within the grace period in response to SIGTERM
- **THEN** `abortRunClaudeCode` resolves without sending SIGKILL

#### Scenario: SIGKILL is sent after a stubborn subprocess ignores SIGTERM

- **WHEN** the subprocess ignores SIGTERM and the grace period elapses
- **THEN** `abortRunClaudeCode` sends SIGKILL and resolves once the subprocess exits

