## Context

Strata's `register(api)` is the one entry point that wires every capability — message hooks, pending-buffer timeout loop, six tools, callbacks, triage hook. Each of those registrations stashes a handler in OpenClaw via `api.on(...)` / `api.registerTool(...)` / `api.registerInteractiveHandler(...)`. The integration test recreates the runtime in a tmp HOME, swaps in a recording `api`, and then plays the lifecycle events itself.

Two practical questions:

1. **How do we look up tool handlers?** `registerTool(factory)` is a function; we have to invoke it with a fake `OpenClawPluginToolContext` to get back the array of `AnyAgentTool`s, then pick by `name`.
2. **How do we look up hook handlers?** `api.on(hookName, fn)` calls are recorded; we look up the last registration for a given `hookName`.

`tests/integration/harness.ts` exposes a small helper that does both, returning the runtime + a `getTool(name)` / `getHook(name)` / `getInteractiveHandler(channel, namespace)` indexer. Tests never poke runtime internals — they call the same surface the SDK calls in production.

## Goals / Non-Goals

**Goals:**
- One test file covers the happy path of capture end-to-end. Failure of *any* wiring point shows up as a clear assertion failure.
- The harness is reusable: future integration tests for correction / supersede / abandon use the same `bootStrataForIntegration` + handler indexer.
- The test uses **real** modules everywhere — same `applyMigrations`, same `runPipeline` (with dynamic `import()` of the expenses `pipeline.ts`).
- No assertions on log strings — those are flaky. We assert DB state and tool result objects.

**Non-Goals:**
- No mocking of `api.registerTool`'s factory contract beyond what's necessary. The harness builds a real `OpenClawPluginToolContext` with `sessionId='int-session'` so the closure captures the right session.
- No timer-based assertions (no `vi.useFakeTimers`). The pending-buffer timeout loop is registered but the test does not wait on it.
- No assertion about the `prependSystemContext` containing every word — only that the rendered result includes `strata_create_pending_event` (proves the static block is rendered) and `'CAPTURE'` in the per-turn block.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `tests/integration/harness.ts` | new | `bootStrataForIntegration(opts) → { runtime, api, getHook(name), getTool(name), getInteractiveHandler(ns) }`. The recording `api` collects every registration so the test can fire handlers by name. |
| `tests/integration/capture_loop.test.ts` | new | The end-to-end test. Single `it("...")` plus a few smaller setup assertions if useful. |

## Decisions

### D1 — Test lives in `tests/integration/`, not next to a module

Existing unit tests live next to their modules (`src/foo/bar.test.ts`). Integration tests span modules — there's no single "module" they belong to. We put them in `tests/integration/` so future tests (correction, supersede, multi-session) cluster naturally. Vitest's default `include` pattern picks them up; no config change.

### D2 — Recording `api` is hand-rolled, not generated from the SDK

We could spy on every method on `OpenClawPluginApi` with `vi.fn()` and reflect over the type, but the surface we use is small (~6 methods). A hand-rolled implementation is more readable and lets the harness expose typed lookup helpers.

### D3 — Tool factory invoked with a synthetic `OpenClawPluginToolContext`

`registerTool(factory)` is called once with the factory function. The harness invokes the factory with `{ sessionId: 'int-session' }` to get back the 6 `AnyAgentTool` objects. Each subsequent `getTool(name)` returns the right one. This matches the production path — OpenClaw also calls the factory once per session.

### D4 — Test does NOT assert on inline-keyboard rendering

We don't have a path to send a keyboard from a tool (`add-callbacks` D1). The test invokes the interactive handler directly with a fake `ctx` whose `callback.payload='commit:N'` and asserts that the same commit code path runs. This validates the callback wiring without pretending the SDK can deliver the buttons.

### D5 — Assert on the registered `commit_event` tool, NOT a fresh one

We test the tools the runtime actually wired. If `registerEventTools` ever stops passing `pipelineDeps`, this test fails because `capability_written` would be `false`.

## Risks / Trade-offs

- **Test depth scales O(N) with capability count.** As more capabilities ship, integration coverage of each costs another `it(...)`. Acceptable for now; we'll factor a parametrised harness when there's a second business capability.
- **No timing assertions** means the pending-buffer timeout loop is not exercised here. Its unit tests cover it separately.
- **Tool factory recall is sensitive to the factory closure capturing the right `sessionId`.** Captured in `D3` and tested directly: the buffer entry is keyed on `'int-session'`.
