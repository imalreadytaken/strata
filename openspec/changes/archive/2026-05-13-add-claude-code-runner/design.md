## Context

The Claude Code CLI emits one JSON object per line on stdout when invoked with `--output-format stream-json`. Each object carries a `type` field; the canonical types we have to handle are:

- `system` — process metadata (model, session id, etc.)
- `assistant` — assistant message chunk (the text Claude produced)
- `user` — user turn (echoed by Claude when resuming)
- `tool_use` — a tool invocation Claude initiated
- `tool_result` — the result of a tool call
- `thinking` — extended-thinking content (when enabled)
- `result` — the final per-turn summary

Strata's runner doesn't need to *interpret* most of these — just route them. We declare a typed discriminated union for the kinds we know and route the rest as `{ type: 'unknown', raw }` so consumers can filter by kind without losing forward-compatibility.

The runner's contract is **transport** only — spawn the subprocess, parse the stream, propagate events, return the exit code. The semantics of "did the build succeed" live in the orchestrator (next change), not here.

## Goals / Non-Goals

**Goals:**
- The runner is **pure plumbing**: every test can inject a fake `spawn` and assert behaviour without launching a real subprocess.
- Stream-json parsing tolerates malformed lines without crashing the run. A malformed line is its own event (`parse_error`) so the consumer can decide whether to abort.
- The runner returns a `RunHandle` immediately (with `result` as a `Promise`) so the caller can both `await result` and call `abortRunClaudeCode(handle)` to terminate the subprocess.
- Sensible defaults: `--output-format stream-json`, `--dangerously-skip-permissions` per `STRATA_SPEC.md` §5.8.4 D-13 ("acceptable for MVP via workdir isolation + AGENTS.md").
- No assumptions about Claude Code being installed during testing. Tests use an injected fake spawner that writes deterministic stream-json to stdout.

**Non-Goals:**
- No queue of build runs. One runner per call.
- No "resume" UX. The `--resume <session_id>` flag is accepted (`opts.resumeSessionId`) but the orchestrator owns when to set it.
- No retry logic on crash. The spec leaves this to the orchestrator (which can re-call `runClaudeCode` after a `claude_code_crashed` event).
- No `stdin` piping. Claude Code reads its prompt from `-p <text>` per the SDK.
- No tool-allowlist override. The spec's flag set is hard-coded; a follow-up change can parameterise once we have a second use case beyond Build Bridge.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/claude_code_runner.ts` | new | `StreamJsonEvent`, `parseStreamJsonLines`, `RunClaudeCodeOptions`, `RunHandle`, `runClaudeCode`, `abortRunClaudeCode`. |
| `src/build/claude_code_runner.test.ts` | new | Unit tests for the parser (10+ cases) plus subprocess flow tests using a hand-rolled fake spawner. |

## Decisions

### D1 — Discriminated union with `unknown` fallback

The event union: `assistant | user | tool_use | tool_result | thinking | system | result | parse_error | unknown`. The `unknown` variant carries the raw line so consumers can forward-compat without us bumping the union every time Claude Code adds a new event kind.

### D2 — Parser is pure; `runClaudeCode` is the only thing that touches `child_process`

`parseStreamJsonLines(chunk, leftover)` returns `{ events, leftover }`. It does no IO, no logging, no event emitting. The test surface is tiny: feed bytes in, expect events out.

`runClaudeCode` is the only place we touch `child_process.spawn`. It accepts an injectable `spawn` for testing (default: the real one).

### D3 — `RunHandle` decoupling

```ts
export interface RunHandle {
  pid: number | undefined;
  result: Promise<RunClaudeCodeResult>;
}
```

The caller gets `pid` immediately (useful for logs) and the promise to await. `abortRunClaudeCode(handle)` is a separate function the caller can use any time before the promise resolves.

### D4 — SIGTERM then SIGKILL after grace period

`abortRunClaudeCode(handle)` sends `SIGTERM` immediately. After a configurable grace period (default 5 s), if the process hasn't exited, it sends `SIGKILL`. The grace period is exposed so tests can use `0` for determinism.

### D5 — `stderr` is captured into the result, not streamed live

`stderr` rarely has useful per-line info; it's where Claude Code writes startup warnings and exit messages. We accumulate into a single string and return it on the result. If a future need arises (live progress on stderr), we add an `onStderr` callback.

### D6 — Malformed JSON line becomes a `parse_error` event, not an exception

A malformed line means we either have a Claude Code bug or our stream-json contract is wrong. Either way, throwing would abort the build mid-stream; instead we surface as an event the orchestrator can log + decide on. Throw remains possible for IO errors on the subprocess (e.g., `spawn` itself fails).

### D7 — `cwd` defaults to the build's workdir, no fallback

`opts.workdir` is required. We do NOT default to the plugin's cwd because Claude Code modifying files in the wrong directory is exactly the failure mode AGENTS.md hard-constraint guards against. If `workdir` is missing or doesn't exist, the function throws synchronously before spawning.

## Risks / Trade-offs

- **`--dangerously-skip-permissions`** is on. The spec's D-13 covers this: workdir isolation + AGENTS.md + git rollback. The runner is not the place to second-guess that decision.
- **Long-running builds block the caller's promise.** Each `runClaudeCode` is per-build; the orchestrator manages concurrency. We don't add a queue here.
- **The fake-spawner test path is doing real work.** Test relies on `EventEmitter`-style streams piped from `Readable.from(...)`. Standard Node API; should be stable.
