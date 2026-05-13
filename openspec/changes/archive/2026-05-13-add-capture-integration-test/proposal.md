## Why

Every capability landed so far has unit tests against its own surface. None of them prove the wiring **between** capabilities works. If an event_id flows out of `strata_create_pending_event` but the inline-keyboard callback expects it as a string, or the pipeline runner uses the wrong column name on `raw_events.business_row_id`, the unit tests stay green while the end-to-end behaviour silently breaks.

This change adds **one integration test** that drives the entire capture loop through the public surfaces only — `bootRuntime` registers everything; the test simulates each lifecycle event by invoking the registered handler directly. It exercises:

1. `installMessageHooks` writing inbound messages to `messages`.
2. `installTriageHook` running on `before_prompt_build` and returning a `prependContext` containing `strata_create_pending_event`.
3. The agent (simulated) calling `strata_create_pending_event` → `pending` row + buffer entry.
4. The agent calling `strata_commit_event` → status flip + buffer drain + expenses pipeline run + business-table row + `capability_health.total_writes = 1` + `raw_events.business_row_id` linked.
5. (Bonus) The Telegram callback path: a fake inline-keyboard `commit:N` click drives the same code via `commitEventCore`.

The test does **not** call out to an LLM. It uses the same `HeuristicLLMClient` triage backend the runtime defaults to. Every assertion is on observable DB state or the result of a tool call.

References: §9 Week 2 ("end-to-end: 用户发消息 → pending event 创建 → 确认 → committed"), §9 Week 3 ("end-to-end: capture 流程触发 expenses pipeline").

## What Changes

- Add `capture-integration` capability covering one Vitest file (`tests/integration/capture_loop.test.ts`) that:
  - Boots a real runtime in a tmp HOME (uses the same `bootRuntime` everyone else uses; no monkey-patching of internals).
  - Captures every `api.on(...)` / `api.registerTool(...)` / `api.registerInteractiveHandler(...)` call via a recording stub `api`.
  - For each registered handler, looks it up by name and invokes it like the runtime would.
  - Asserts the DB state after each step matches the contract.

## Capabilities

### New Capabilities
- `capture-integration`: a single end-to-end Vitest case that drives Strata's full capture loop using the public registration surface.

### Modified Capabilities
*(none — adds a test file; uses existing modules unchanged)*

## Impact

- **Files added**:
  - `tests/integration/capture_loop.test.ts` — the integration test.
  - `tests/integration/harness.ts` — `bootStrataForIntegration(...)` helper: boots the runtime against a tmp HOME + a recording `api`, returns the runtime + a handler-lookup helper.
- **Files modified**: *(none)*
- **Non-goals**:
  - No demo CLI yet. The test is the closest thing to a demo today; turning it into a script the user can run is a follow-up.
  - No real LLM. The triage classifier uses the heuristic backend; the integration test pins the classification outputs that flow it expects.
  - No multi-turn dialogue testing. One inbound message + one tool call + one commit. Multi-event scenarios (correction across sessions, edit-then-commit) ride on later changes.
  - No assertion about inline-keyboard buttons reaching the user — `add-callbacks` already documented that gap (D1); the test invokes the registered callback handler directly to verify the commit path it owns.
