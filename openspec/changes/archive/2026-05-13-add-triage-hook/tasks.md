## 1. Runtime field

- [x] 1.1 Modify `src/runtime.ts`:
  - Add `llmClient: LLMClient` to `StrataRuntime`.
  - Inside `bootRuntime`, default to `new HeuristicLLMClient()`.
- [x] 1.2 Modify `src/runtime.test.ts`: assert `runtime.llmClient` is defined.

## 2. `buildTriageInput`

- [x] 2.1 Create `src/triage/hook.ts` exporting `buildTriageInput(deps): Promise<TriageInput>` where deps is `{ messagesRepo, rawEventsRepo, pendingBuffer, capabilities, sessionId, userMessage }`.
- [x] 2.2 Implementation:
  - `recent_messages` = last 3 `role='user'` messages from `messagesRepo`, in reverse-chronological order (most recent first; the current message at index 0).
  - `active_capabilities` = `[...capabilities.keys()]`.
  - `pending_event_summaries` = for each id in `pendingBuffer.getAll(sessionId)`, look up `rawEventsRepo.findById(id)` and format as `'#${id}: ${source_summary}'`. Drop rows the lookup returns null for.

## 3. `renderRoutingContext`

- [x] 3.1 Export `renderRoutingContext(triage: TriageResult, input: TriageInput): { prependSystemContext: string; prependContext: string }`.
- [x] 3.2 `prependSystemContext` is one **static** template per session: lists active capabilities + names the 6 strata_* tools + explains the pending → committed state machine.
- [x] 3.3 `prependContext` is **per-turn**: includes the triage kind / confidence / rule, plus the relevant tool-sequence for that kind. `chitchat` returns an empty `prependContext`.

## 4. `installTriageHook`

- [x] 4.1 Export `installTriageHook(api: OpenClawPluginApi, deps: RoutingHookDeps): void`.
  - `RoutingHookDeps = { messagesRepo, rawEventsRepo, pendingBuffer, capabilities, llmClient, logger }`.
- [x] 4.2 Register a `before_prompt_build` handler that:
  - Pulls `sessionId` from `ctx.sessionId ?? 'default'`.
  - Builds the input via `buildTriageInput`.
  - Calls `classifyIntent(input, deps.llmClient)`. On any throw, log at `warn` and return `{}`.
  - Calls `renderRoutingContext(...)` and returns its output.

## 5. Plugin entry wiring

- [x] 5.1 Modify `src/index.ts`: call `installTriageHook(api, deps)` after `registerStrataCallbacks`. Update doc comment to reflect that triage is now wired.

## 6. Tests

- [x] 6.1 `src/triage/hook.test.ts`:
  - `buildTriageInput`: assembles a correct shape from a seeded DB + buffer + registry.
  - `renderRoutingContext`: 5 cases, one per kind, asserts the right tool names appear.
  - `renderRoutingContext('chitchat')`: returns an empty `prependContext`.
  - `installTriageHook`: subscribes exactly once to `before_prompt_build`; the registered handler returns the expected shape for a stubbed `LLMClient` returning a `capture` result.
  - `installTriageHook` failure swallowing: if `classifyIntent` throws, the handler returns `{}` and a `warn`-level log is emitted (no propagation).

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-triage-hook --strict`.
