## 1. Harness

- [x] 1.1 Create `tests/integration/harness.ts` exporting `bootStrataForIntegration(opts?): Promise<IntegrationHarness>`:
  - Creates a tmp HOME, points `process.env.HOME` at it for the duration of the harness's life.
  - Builds a recording `api` that captures `on(name, fn)`, `registerTool(factory)`, `registerInteractiveHandler(reg)`, `logger.*`.
  - Imports + invokes Strata's default plugin export `register(api)`.
  - Resolves `runtime` via `bootRuntime(api)` (returns the memoised value).
  - Returns helpers:
    - `getHook(name): registered handler`
    - `getTool(name): AnyAgentTool` (factory called once with `sessionId='int-session'`).
    - `getInteractiveHandler(channel, namespace)`.
    - `teardown(): close DB, restore HOME, rm tmp`.

## 2. Test

- [x] 2.1 Create `tests/integration/capture_loop.test.ts`:
  - Single `it("captures a consumption message end-to-end")` exercising the chain:
    1. **Persist inbound**: call the `message_received` hook with `{ from: 'u1', content: '今天买了 Blue Bottle 拿铁 ¥45', timestamp: ... }` and ctx `{ channelId: 'telegram', conversationId: 'int-session' }`. Assert one row in `messages`.
    2. **Triage**: call the `before_prompt_build` hook with `{ prompt: '今天买了 Blue Bottle 拿铁 ¥45', messages: [] }` and ctx `{ sessionId: 'int-session' }`. Assert the result's `prependContext` contains `'CAPTURE'` and `'strata_create_pending_event'`.
    3. **Create pending**: get the `strata_create_pending_event` tool, call `execute('cid-1', { event_type: 'consumption', capability_name: 'expenses', extracted_data: { amount_minor: 4500, merchant: 'Blue Bottle', category: 'dining' }, source_summary: 'Blue Bottle 拿铁 ¥45', primary_message_id, confidence: 0.9 })`. Assert: `raw_events` has one `pending` row, `pendingBuffer.has('int-session', eventId) === true`.
    4. **Commit**: get `strata_commit_event`, call `execute('cid-2', { event_id: eventId })`. Assert: result details `{ status: 'committed', capability_written: true, business_row_id: > 0 }`; `raw_events.business_row_id` is set; one row in `expenses` with `amount_minor=4500`, `merchant='Blue Bottle'`, `category='dining'`, `currency='CNY'`; `capability_health.expenses.total_writes=1`; `pendingBuffer.has('int-session', eventId) === false`.
- [x] 2.2 Add a `it("commits via the Telegram inline-keyboard callback")` case:
  - Repeat steps 1+3 to set up a pending row.
  - Get the interactive handler for channel `'telegram'` / namespace `'strata'`.
  - Build a synthetic Telegram callback ctx with `payload='commit:<eventId>'`, `conversationId='int-session'`, a `respond.editMessage` spy.
  - Invoke the handler. Assert: same DB outcomes as the tool-call path (committed, business row, health bump), AND `respond.editMessage` was called once with `buttons: []`.

## 3. Integration

- [x] 3.1 `npm run typecheck` clean.
- [x] 3.2 `npm test` all pass.
- [x] 3.3 `openspec validate add-capture-integration-test --strict`.
