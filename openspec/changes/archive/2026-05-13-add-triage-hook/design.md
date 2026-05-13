## Context

The `triage` capability is a pure function over an `LLMClient` seam. It does not subscribe to anything — it's a library, not a service. To make it actually drive the agent, we register a `before_prompt_build` hook that:

- Receives `{ prompt, messages }` + `ctx: { sessionId, channelId, ... }`.
- Returns `{ prependSystemContext?, prependContext? }`.

OpenClaw applies the returned context to the system prompt for the current run. `prependSystemContext` is cacheable across turns (so providers with prompt-cache support keep it warm); `prependContext` is per-turn. We use both — the **static** Strata-routing guidance (active capabilities, tool names) goes in `prependSystemContext`; the **dynamic** triage result goes in `prependContext`.

## Goals / Non-Goals

**Goals:**
- One hook handler covers all five triage kinds. Each kind gets a template `renderRoutingContext` returns; the active-capabilities list + pending events are interpolated inline.
- Triage failure never blocks the agent. A throw inside `classifyIntent` is logged at `warn` and the hook returns `{}` (no context injection).
- `buildTriageInput` is **pure async** and **testable** without the runtime — it accepts `{ messagesRepo, rawEventsRepo, pendingBuffer, runtime: { capabilities }, sessionId, userMessage }` and returns a fully-formed `TriageInput`.
- `renderRoutingContext` is **pure** and **synchronous** — no IO, just templates. Trivial to test exhaustively.
- The hook treats `chitchat` as "no injection" (empty `prependContext`) so cache hits on the cached prompt prefix stay clean.

**Non-Goals:**
- No prompt-engineering for the routing block beyond what's needed today. The five templates are short and concrete; the agent's own system prompt does the heavy lifting.
- No "soft" classification (probabilities across all 5 kinds). The classifier returns one kind + a confidence; we route on the kind.
- No prompt-cache-bust on capability changes. If the user installs a new capability mid-session, the cached prefix lags by one turn. Acceptable for V1.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/triage/hook.ts` | new | `buildTriageInput`, `renderRoutingContext`, `installTriageHook`, types. |
| `src/triage/hook.test.ts` | new | Hook handler tests: success path per kind, triage throw → empty result + warn, missing sessionId → 'default'. |
| `src/runtime.ts` | modified | `StrataRuntime.llmClient: LLMClient`; default to `new HeuristicLLMClient()`. |
| `src/runtime.test.ts` | modified | One new assertion: `runtime.llmClient` is defined. |
| `src/index.ts` | modified | Call `installTriageHook(api, ...)` after callbacks. |

## Decisions

### D1 — Static guidance in `prependSystemContext`; per-turn classification in `prependContext`

The Strata-aware "what tools exist and when to use them" block is **static per session**: capability names change rarely, and even when they do, a one-turn lag is acceptable. We render it once per turn but the content is stable enough that prompt-cache hits across turns work cleanly. Goes in `prependSystemContext`.

The triage **result** (e.g., "the user just said something that looks like a capture; here are the current pending events to consider") is **per-turn**, by definition. Goes in `prependContext`.

This split is what `PluginHookBeforePromptBuildResult` was built for — using it correctly keeps inference cost predictable.

### D2 — `buildTriageInput` reads message history from the DB, not from `event.messages`

`event.messages` is the SDK's prepared message list — its shape is `unknown[]` (provider-specific) and we'd have to type-narrow to extract user-message text. Easier and more reliable: query `messagesRepo.findMany({ session_id, role: 'user' }, { orderBy: 'received_at', direction: 'desc', limit: 4 })`. The first row is the current message (already persisted by `message-hooks`); the next 3 are the recent context.

Side benefit: if a future change bypasses the OpenClaw message pipeline, our triage stays grounded in the Strata DB.

### D3 — Pending-event summaries are looked up per-id, not pre-joined

`pendingBuffer.getAll(sessionId)` returns event ids. For each id we call `rawEventsRepo.findById(id)`. That's N+1 — fine: a session typically has 0–3 pending events. If it ever grows, we add a `rawEventsRepo.findByIds(ids)` batch.

### D4 — `chitchat` returns empty `prependContext`, keeps `prependSystemContext`

Chitchat doesn't need any per-turn routing. But the static "tools exist, here's what they're for" block still belongs in the system prompt so the user can shift into capture mid-conversation ("oh by the way, ¥35 today").

### D5 — `renderRoutingContext` templates

Five short templates. Each starts with `## Strata triage` so the agent's prompt parser doesn't conflate it with user content. Each names the recommended tools explicitly so the agent can call them without re-deriving from the skill file.

Example for `capture`:
```
## Strata triage
User intent: CAPTURE (confidence 0.7, rule: capture:fact).
Recommended skill: capture (src/skills/capture/SKILL.md).
Active capabilities: expenses.
Pending events in this session: none.

Tool sequence: extract structured data → strata_create_pending_event → wait for user confirmation → strata_commit_event (or strata_abandon_event).
```

### D6 — Triage failure logs at `warn`, NOT `error`

A `classifyIntent` throw means the heuristic backend (or future LLM client) returned malformed JSON or a schema-failing payload. That's a software bug, not an operational error — the agent run is fine; the user's UX is "no routing hint this turn". Logging at `error` would page someone for nothing. We log at `warn` with the raw exception message and move on.

### D7 — `llmClient` is on the runtime, not the hook deps

A real LLM-backed client may want to share state across hooks (caching, model selection, etc.). Putting it on `StrataRuntime` lets the future Reflect agent + capability prompt evaluation reach it too. The hook is just one caller.

## Risks / Trade-offs

- **Per-turn DB read.** `messagesRepo.findMany` + 0–3 `findById` calls per `before_prompt_build`. Negligible at SQLite speed.
- **Static block goes stale.** Capabilities loaded mid-session don't appear in `prependSystemContext` until the *next* turn. That's a one-turn lag; acceptable.
- **Heuristic backend isn't accurate.** Misclassifications happen. The fallback ("prefer chitchat over capture when uncertain") means the cost of a miss is "no routing hint" — the agent still works. A real LLM client lands later.
