## Why

Build Bridge is Strata's "co-build" feature: when the user says "我想加个体重追踪", Strata spawns Claude Code as a subprocess, feeds it the PLAN.md + AGENTS.md, and ships back an OpenSpec change set that the integration layer can land. The very bottom of that stack is the **process runner**: spawn `claude`, route stream-json to a callback, return when the process exits.

The spec sketches a single 60-line `runClaudeCode` function (§5.8.4); shipping it cleanly requires three things the sketch glosses over:

- **Stream-json parsing**: each line is one JSON event; partial lines must buffer until a newline lands; malformed lines should be reported (the build harness wants to know if Claude produced unexpected output).
- **Lifecycle eventing**: callers (`plan_phase`, `decompose_phase`, `orchestrator`) all want to observe assistant text, tool calls, tool results, thinking events. A typed event shape beats `(msg: any) => void`.
- **Test path with no real `claude` binary**: the runner has to be testable today even though Claude Code isn't installed in CI. We solve this with an injectable `spawn` (default `child_process.spawn`) so a fake binary or a stub spawner covers the path.

References: `STRATA_SPEC.md` §5.8 (Build Bridge overview), §5.8.4 (runClaudeCode sketch), `AGENTS.md` hard constraint #5 (migrations immutable — relevant because the integration layer will land migrations from Build Bridge output).

## What Changes

- Add `claude-code-runner` capability covering:
  - **`StreamJsonEvent`** type — discriminated union over the message kinds Claude Code emits: `assistant`, `user`, `tool_use`, `tool_result`, `thinking`, `system`, plus a generic `unknown` for forward-compatibility. The union is non-exhaustive on purpose; consumers can pattern-match what they care about.
  - **`parseStreamJsonLines(chunk: string, leftover: string): { events: StreamJsonEvent[]; leftover: string }`** — pure function. Splits the chunk on `\n`, JSON-parses each non-empty line, and surfaces malformed lines as `{ type: 'parse_error', raw, error }` rather than throwing.
  - **`runClaudeCode(opts: RunClaudeCodeOptions): Promise<RunClaudeCodeResult>`** — spawns `claude` with the spec's flag set (`--output-format stream-json`, `--max-turns`, `--allowed-tools`, `--deny-tools`, `--dangerously-skip-permissions`), pipes stdout through `parseStreamJsonLines`, invokes `opts.onEvent(event)` per parsed event, waits for `exit`, and returns `{ exitCode, eventCount, stderr }`. Accepts an injectable `spawn` for testing.
  - **`abortRunClaudeCode(handle)`**: a separate API so a caller can SIGTERM the subprocess mid-run (Build Bridge stop/resume). The runner returns a handle on call, then the caller awaits the promise — abort sends SIGTERM, then SIGKILL after a grace period.

## Capabilities

### New Capabilities
- `claude-code-runner`: Build Bridge's process-level subprocess wrapper around the Claude Code CLI.

### Modified Capabilities
*(none — new module; no integration with the rest of the plugin until the orchestrator change lands)*

## Impact

- **Files added**:
  - `src/build/claude_code_runner.ts` — `runClaudeCode`, `parseStreamJsonLines`, `StreamJsonEvent` types, `abortRunClaudeCode`.
  - `src/build/claude_code_runner.test.ts` — unit tests for `parseStreamJsonLines` (10+ cases) plus subprocess tests using an injected fake spawn.
- **Files modified**: *(none — the runner is plumbing; the orchestrator change wires it)*
- **Non-goals**:
  - No orchestrator. The runner doesn't know about plan/decompose/apply/verify; that's the next change.
  - No tool-allowlist *negotiation*. The flag set is hard-coded per §5.8.4. A future change can make it configurable when Build Bridge needs custom tool sets.
  - No progress *forwarding* to Telegram / IM. Consumers wire that up via `onEvent`.
  - No `claudeSessionId` / `--resume` flag exposed yet. We document the placeholder; the orchestrator change will pass it when re-entering a paused build.
  - No process timeout. Caller's responsibility for now — `abortRunClaudeCode` is the abort surface.
