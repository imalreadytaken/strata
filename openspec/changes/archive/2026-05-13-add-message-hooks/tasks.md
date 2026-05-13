## 1. Runtime bootstrap

- [x] 1.1 Create `src/runtime.ts` exporting a `StrataRuntime` interface (`db`, `logger`, `config`, and every system-table repository as named fields).
- [x] 1.2 Implement `bootRuntime(api: OpenClawPluginApi): Promise<StrataRuntime>` using module-level memoisation: first call opens the DB, applies migrations, instantiates all eight repositories, and constructs the Strata logger configured from `config.logging.*`. Subsequent calls return the cached value.
- [x] 1.3 Add a `resetRuntimeForTests()` helper (only intended for vitest) that clears the cache and closes the DB.

## 2. Message hooks

- [x] 2.1 Create `src/hooks/messages.ts` exporting:
  - `installMessageHooks(api: OpenClawPluginApi, deps: { messagesRepo, logger }): void`
  - `handleMessageReceived(deps, event, ctx): Promise<void>` (exported for unit tests)
  - `handleMessageSent(deps, event, ctx): Promise<void>` (exported for unit tests)
- [x] 2.2 Implement `handleMessageReceived`:
  - Resolve `session_id = ctx.conversationId ?? \`${ctx.channelId}:${event.from}\``
  - `turn_index = await messagesRepo.getNextTurnIndex(session_id)`
  - `received_at = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()`
  - Insert with `role = 'user'`, `content_type = 'text'`
  - try/catch around the insert; on error, log at `error` level and return normally
- [x] 2.3 Implement `handleMessageSent`:
  - Skip when `event.success === false`; log at `debug` level with `event.error`
  - Same session resolution but using `event.to`
  - Insert with `role = 'assistant'`, `content_type = 'text'`
- [x] 2.4 Create `src/hooks/index.ts` re-exporting `installMessageHooks`.

## 3. Plugin entry wiring

- [x] 3.1 Modify `src/index.ts` `register(api)`:
  - Make it `async`
  - `const runtime = await bootRuntime(api)`
  - `installMessageHooks(api, { messagesRepo: runtime.messagesRepo, logger: runtime.logger })`
  - Wrap in try/catch — on failure, log via `api.logger` (the OpenClaw fallback) so the plugin's load failure is visible in gateway logs.

## 4. Tests

- [x] 4.1 Create `src/hooks/messages.test.ts`:
  - Build a tiny `mockApi()` that records hook subscriptions
  - For every spec scenario: build deps from a real `openDatabase` + applied migrations + a `MessagesRepository`, fire the handler manually, assert the row state
  - Assert `event.success === false` doesn't insert
  - Assert insert failure is swallowed (mock the repo to throw)
- [x] 4.2 Cover `bootRuntime` idempotency in `src/runtime.test.ts`: two `bootRuntime(api)` calls in a single test, assert internal counters (`bootCount`, `migrateCount`) each ran once. Bonus: assert the cache is NOT poisoned by a first-call failure.

## 5. Integration

- [x] 5.1 Run `npm run typecheck` → clean.
- [x] 5.2 Run `npm test` → all tests pass (107 total).
