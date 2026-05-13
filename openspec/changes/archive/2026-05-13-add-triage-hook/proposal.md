## Why

Triage classifier + Capture SKILL.md + 6 strata_* tools + a working pipeline runner — none of it reaches the agent. Every inbound user message currently lands in `messages`, gets passed to the LLM with no routing hint, and the agent decides what to do based on its general system prompt (which doesn't yet know Strata exists). That's the missing wire.

`before_prompt_build` is the OpenClaw hook for injecting per-turn context into the agent's system prompt. With one handler that:

1. Resolves the session's recent messages + active capabilities + pending event summaries
2. Calls `classifyIntent(input, runtime.llmClient)` against the heuristic backend
3. Returns a `prependSystemContext` block describing the detected intent + the recommended skill / tools / state

…the agent goes from "blank" to "Strata-aware" without any change to the user's UX.

References: `STRATA_SPEC.md` §5.6 (triage), §5.1 (plugin entry routing), `add-triage-and-capture-skill` design D2 (LLMClient seam), OpenClaw `PluginHookBeforePromptBuildResult.prependSystemContext` (cached by providers, no per-turn token cost).

## What Changes

- Add `triage-hook` capability covering:
  - **`StrataRuntime.llmClient: LLMClient`** — a runtime field holding the in-tree `HeuristicLLMClient` instance. Future change swaps in a real backend by overriding this one field.
  - **`buildTriageInput(args): Promise<TriageInput>`** — pure async helper that pulls `recent_messages` from `messagesRepo` (last 3 turns of the session), `active_capabilities` from `runtime.capabilities.keys()`, and `pending_event_summaries` from `pendingBuffer.getAll(sessionId)` + per-id `rawEventsRepo.findById`. Exported so tests + future Reflect-side reuse it.
  - **`renderRoutingContext(triage, input): string`** — pure function that turns a `TriageResult` into the system-context block the agent reads. One template per kind (capture / correction / query / build_request / chitchat). Includes the active-capabilities list and any pending-event summaries inline.
  - **`installTriageHook(api, deps): void`** — registers a `before_prompt_build` handler. The handler:
    1. Pulls `sessionId` from `ctx.sessionId` (falls back to `'default'`).
    2. Builds `TriageInput` from the event prompt + session state.
    3. Calls `classifyIntent(input, deps.llmClient)`. On any throw, logs at `warn` and returns `{}` (don't block the agent on a triage failure).
    4. Calls `renderRoutingContext(...)` and returns `{ prependSystemContext }`.
  - **Plugin entry wiring**: `register(api)` calls `installTriageHook(api, deps)` after `registerStrataCallbacks`. Order is intentional — triage routing needs the tools + callbacks already registered so the routing context can reference their names accurately.

## Capabilities

### New Capabilities
- `triage-hook`: `before_prompt_build` handler that injects a Strata-routing system context on every inbound message.

### Modified Capabilities
*(none — uses the existing `triage` + `pending-buffer` + `repositories` capabilities)*

## Impact

- **Files added**:
  - `src/triage/hook.ts` — `buildTriageInput`, `renderRoutingContext`, `installTriageHook` + the `RoutingHookDeps` type.
  - `src/triage/hook.test.ts` — handler unit tests with a stubbed `api.on` + a hand-rolled `LLMClient` returning canned classifications.
- **Files modified**:
  - `src/runtime.ts` — `StrataRuntime.llmClient: LLMClient`; `bootRuntime` instantiates `new HeuristicLLMClient()` and stows it.
  - `src/index.ts` — `register(api)` calls `installTriageHook(api, { ... })` after the callback registration.
- **Non-goals**:
  - No actual LLM backend yet. `runtime.llmClient` defaults to `HeuristicLLMClient`; a real client lands in its own change with its own design.md.
  - No on-the-fly skill loading. The Capture SKILL.md still lives at `src/skills/capture/SKILL.md`; the routing context references its workflow inline rather than loading the whole file (token budget). When the agent prompt gets a proper skill-router (P5), this hook is what calls it.
  - No system-prompt mutation of cached blocks. We use `prependSystemContext` (cacheable) for static guidance about Strata being present, and reserve `prependContext` for the per-turn classification result. This keeps prompt-cache hit rates high.
