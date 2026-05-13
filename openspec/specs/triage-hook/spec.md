# triage-hook Specification

## Purpose

`triage-hook` is the wire that turns the rest of Strata's machinery — tools, callbacks, capabilities, capture skill — into something the agent actually sees on every turn. It registers a `before_prompt_build` handler that pulls the user's recent history from `messages`, the live capability registry, and the session's pending events into a `TriageInput`, classifies via `runtime.llmClient` (default: `HeuristicLLMClient`), and returns a `prependSystemContext` (static Strata block, cacheable across turns) plus a `prependContext` (per-turn routing recommendation keyed to the detected intent). A triage failure logs at `warn` and returns `{}` so the agent run is never blocked by a classifier bug; `chitchat` returns an empty `prependContext` so prompt-cache hits stay clean. The hook is the operational bridge between the capture loop's code and the agent's runtime.

## Requirements
### Requirement: Runtime exposes an `LLMClient` instance

The system SHALL expose `StrataRuntime.llmClient: LLMClient`. `bootRuntime` SHALL instantiate `new HeuristicLLMClient()` as the default; a future change may override this field with an LLM-backed implementation.

#### Scenario: Fresh runtime has an LLMClient

- **WHEN** `bootRuntime(api)` runs against a fresh DB
- **THEN** `runtime.llmClient` is defined and has an `infer` method

### Requirement: `buildTriageInput` assembles classifier input from session state

The system SHALL export `buildTriageInput(deps): Promise<TriageInput>` where `deps = { messagesRepo, rawEventsRepo, pendingBuffer, capabilities, sessionId, userMessage }`. The result MUST contain:

- `user_message` = `userMessage` (the prompt the agent is about to handle).
- `recent_messages` = up to 3 most-recent `role='user'` content strings from `messagesRepo`, in reverse-chronological order.
- `active_capabilities` = the keys of `capabilities` (the CapabilityRegistry), in iteration order.
- `pending_event_summaries` = `'#${id}: ${source_summary}'` for each id in `pendingBuffer.getAll(sessionId)`; rows that look up null are silently dropped.

#### Scenario: Returns recent messages newest-first

- **WHEN** the session has 5 `user` messages timestamped 1..5
- **THEN** `buildTriageInput` returns `recent_messages` with exactly the most-recent 3 entries, newest first

#### Scenario: Lists active capabilities

- **WHEN** the registry has `expenses` and `moods`
- **THEN** `active_capabilities` is `['expenses', 'moods']` (in iteration order)

#### Scenario: Pending event summaries are populated

- **WHEN** the session's buffer contains event ids `[7, 9]` and the corresponding rows have `source_summary='coffee'` and `'lunch'`
- **THEN** `pending_event_summaries = ['#7: coffee', '#9: lunch']`

### Requirement: `renderRoutingContext` produces a system + per-turn block for each triage kind

The system SHALL export `renderRoutingContext(triage, input): { prependSystemContext: string; prependContext: string }`.

- `prependSystemContext` is the **static** Strata-routing block: lists active capabilities, names all 6 `strata_*` tools, and describes the `pending → committed | superseded | abandoned` state machine.
- `prependContext` is the **per-turn** block: one of five templates keyed by `triage.kind`. The `chitchat` kind returns an empty string.

Each non-chitchat template MUST mention the recommended tool names by their `strata_*` identifiers so the agent can call them without consulting the skill file.

#### Scenario: Capture template names the right tools

- **WHEN** `triage = { kind: 'capture', confidence: 0.8, reasoning: 'x' }`
- **THEN** `prependContext` contains `'strata_create_pending_event'`, `'strata_commit_event'`, and `'strata_abandon_event'`

#### Scenario: Correction template references search + supersede

- **WHEN** `triage.kind = 'correction'`
- **THEN** `prependContext` contains `'strata_search_events'` and `'strata_supersede_event'`

#### Scenario: Query template references search

- **WHEN** `triage.kind = 'query'`
- **THEN** `prependContext` contains `'strata_search_events'`

#### Scenario: Build request template explains the bridge is not yet shipped

- **WHEN** `triage.kind = 'build_request'`
- **THEN** `prependContext` mentions that Build Bridge is not yet available and the agent should respond conversationally

#### Scenario: Chitchat returns empty prependContext

- **WHEN** `triage.kind = 'chitchat'`
- **THEN** `prependContext === ''` and `prependSystemContext` remains non-empty (the static Strata block)

### Requirement: `installTriageHook` registers a `before_prompt_build` handler

The system SHALL export `installTriageHook(api, deps): void` that calls `api.on('before_prompt_build', handler)`. The handler SHALL:

1. Resolve `sessionId = ctx.sessionId ?? 'default'`.
2. Build `TriageInput` via `buildTriageInput`.
3. Call `classifyIntent(input, deps.llmClient)`.
4. On success, return `renderRoutingContext(...)`'s output.
5. On any throw inside steps 2–3, log at `warn` and return `{}` (no context injection); the agent run proceeds without a routing hint.

#### Scenario: Hook returns the rendered context for a successful classification

- **WHEN** the handler runs with `event.prompt='today bought ¥45 coffee'` against a stub `LLMClient` returning a `capture` result
- **THEN** the handler resolves with a `prependSystemContext` containing the static Strata block AND a `prependContext` containing `'strata_create_pending_event'`

#### Scenario: Hook swallows triage failures

- **WHEN** the stub `LLMClient.infer` rejects with an error
- **THEN** the handler resolves with `{}` and a `warn`-level log records the failure

#### Scenario: Plugin entry installs the hook exactly once

- **WHEN** `register(api)` runs against a stub `api` recording every `api.on` call
- **THEN** `api.on('before_prompt_build', ...)` has been called exactly once after `registerStrataCallbacks`

