## ADDED Requirements

### Requirement: `bootStrataForIntegration` boots the runtime against a tmp HOME and a recording `api`

The system SHALL ship `tests/integration/harness.ts` exporting `bootStrataForIntegration(opts?): Promise<IntegrationHarness>` that:

- Creates a tmp directory and points `process.env.HOME` at it for the harness's lifetime.
- Constructs a recording stub `api` capturing every `on / registerTool / registerInteractiveHandler` call.
- Imports Strata's plugin default export and invokes `register(api)`.
- Returns the `bootRuntime`-derived `runtime` plus typed lookup helpers.

`IntegrationHarness` MUST expose:

- `runtime: StrataRuntime`
- `getHook<K extends PluginHookName>(name: K)` — returns the registered handler (or throws if missing).
- `getTool(name: string): AnyAgentTool` — invokes the registered tool factory once with `sessionId='int-session'` and returns the matching tool.
- `getInteractiveHandler(channel: string, namespace: string)` — returns the registered handler.
- `teardown(): Promise<void>` — closes DB, restores HOME, removes the tmp dir.

#### Scenario: register populates the recording api

- **WHEN** `bootStrataForIntegration()` runs
- **THEN** `getHook('message_received')`, `getHook('message_sent')`, `getHook('before_prompt_build')`, `getTool('strata_create_pending_event')`, `getTool('strata_commit_event')`, and `getInteractiveHandler('telegram', 'strata')` all return defined values

### Requirement: Capture loop end-to-end test exercises every wired capability

The system SHALL ship `tests/integration/capture_loop.test.ts` containing at minimum one case that drives the full chain from inbound message to a row in the `expenses` business table, asserting every observable DB outcome along the way.

#### Scenario: A consumption message captures end-to-end via the tool path

- **WHEN** the test calls:
  1. The `message_received` hook with a Telegram-shaped event.
  2. The `before_prompt_build` hook with the same prompt.
  3. `strata_create_pending_event.execute(...)` with `capability_name='expenses'` and a coherent `extracted_data`.
  4. `strata_commit_event.execute(...)` against the returned `event_id`.
- **THEN** after step 4:
  - The `raw_events` row's `status='committed'`, `business_row_id` is non-null.
  - One row exists in `expenses` whose `amount_minor`, `merchant`, `category`, `currency`, and `occurred_at` match the input.
  - `capability_health.expenses.total_writes === 1`.
  - `pendingBuffer.has('int-session', eventId) === false`.

#### Scenario: The before_prompt_build hook returns a CAPTURE routing block

- **WHEN** the hook is invoked with the consumption message prompt
- **THEN** the result's `prependContext` contains the strings `'CAPTURE'` and `'strata_create_pending_event'`

### Requirement: Inline-keyboard callback path is integration-covered

The system SHALL ship a second integration case that invokes the Telegram interactive handler (namespace `'strata'`, payload `'commit:<eventId>'`) against a pending event and asserts the same business-table side-effects as the tool-call path, plus that `respond.editMessage` is called exactly once with `buttons: []`.

#### Scenario: Inline-keyboard commit drives the pipeline

- **WHEN** the integration test seeds a pending event, then invokes the strata-namespace Telegram handler with `payload='commit:<eventId>'`
- **THEN** the row transitions to `'committed'`, an `expenses` row exists, `capability_health` is bumped, and `respond.editMessage` was called once with `buttons: []`
