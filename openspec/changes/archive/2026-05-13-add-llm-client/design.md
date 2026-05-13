## Context

The `LLMClient` seam already exists from `add-triage-and-capture-skill`. Three concrete details needed: how do we pick the model, how do we get the key, and how do we degrade gracefully.

**Model**: from `~/.strata/config.json` `models.fast`, in `'<provider>/<modelId>'` format. The literal `'auto'` means "no real backend wired" and falls back to the heuristic. We restrict providers to pi-ai's `KnownProvider` enum (Anthropic, OpenAI, Google, etc.) — anything else fails resolution.

**Key**: `getEnvApiKey(provider)` from `@mariozechner/pi-ai`. The user already has env vars set for the provider they use day-to-day (OpenClaw config flows through these too). When the env var is missing, we fall back to the heuristic rather than throwing — Strata being usable matters more than being smart.

**Degrade**: `resolveLLMClient` returns a `LLMClientResolution = { client, backend: 'pi-ai' | 'heuristic', model?: string }`. Tests pin the backend name. Production callers see a uniform `LLMClient` interface.

## Goals / Non-Goals

**Goals:**
- The seam shape doesn't change. `classifyIntent` and the triage hook get a smarter `infer()` without code changes.
- `PiAiLLMClient` is testable without network: tests inject a `complete` stub and a `getModel` stub.
- Resolver is pure given config + env; tests mutate `process.env.ANTHROPIC_API_KEY` to exercise both branches.
- Config defaults stay `'auto'` so existing users / tests see no behaviour change.

**Non-Goals:**
- No OpenAI streaming / partial-token rendering. `complete` blocks until the full assistant message arrives.
- No prompt caching tuning. We pass the default `cacheRetention: 'short'`.
- No multi-message Context. Triage sends one user message + a system prompt; that's the whole `Context`.
- No `runEmbeddedPiAgent` path. That's for full agent runs with tool calls; one-shot infer doesn't need it.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/llm/pi_ai_client.ts` | new | `PiAiLLMClient`, `resolveLLMClient`, `LLMClientResolution`. |
| `src/llm/pi_ai_client.test.ts` | new | Stubbed `complete` + `getModel`; resolver fallback cases. |
| `src/core/config.ts` | modified | `ConfigSchema.models` field; default `{ fast: 'auto', smart: 'auto', coder: 'claude-code-cli' }`. |
| `src/core/config.test.ts` | modified | Defaults + parsing assertions. |
| `src/runtime.ts` | modified | Uses `resolveLLMClient(config, deps)` instead of unconditional `HeuristicLLMClient`. |

## Decisions

### D1 — `'<provider>/<modelId>'` parsing, strict KnownProvider list

`config.models.fast = 'anthropic/claude-haiku-4-5'` splits on `'/'` → `provider='anthropic'`, `modelId='claude-haiku-4-5'`. Provider must be one of pi-ai's `KnownProvider` strings or resolution fails (logged at warn → heuristic fallback). modelId is forwarded verbatim to `getModel(provider, modelId)`. Validation of model existence happens inside pi-ai — we just propagate the error and fall back.

### D2 — `'auto'` literal stays heuristic

`'auto'` means "I haven't configured a real model yet." Defaulting to a hardcoded model name would violate the spirit of AGENTS.md "no hardcoded model names." Defaulting to a runtime-chosen default could surprise the user with billed inference. Better: heuristic is the safe default; users opt into a real model explicitly.

### D3 — Skipped: OpenClaw `modelAuth.getApiKeyForModel(...)` integration

OpenClaw's `runtime.modelAuth` resolves auth profiles (the same mechanism the host uses for its own agent runs). We could plug into it instead of env vars. The reason we don't here: the `Model<TApi>` shape `modelAuth.getApiKeyForModel({ model, cfg })` wants is the fully-constructed pi-ai Model, not a `<provider>/<id>` string. The plumbing is at least one more day's work and a separate design decision. Env vars unblock the immediate goal. A follow-up change can wire the OpenClaw path when we sit down with that SDK surface.

### D4 — Failure modes all fall back to heuristic, never throw

Triage runs on every inbound message. A 500 from Anthropic, a missing env var, a malformed config — none of those should break the agent run. `resolveLLMClient` returns the heuristic when configuration fails; `PiAiLLMClient.infer` is the only place that can throw, and the upstream `installTriageHook` already swallows triage exceptions (warn + empty hook result). Together the two layers mean an LLM outage degrades to "no routing hint this turn," not "the agent dies."

### D5 — Response shape: `assistantMessage.content` flattened to text

`complete()` returns `AssistantMessage` with `content: (TextContent | ThinkingContent | ToolCall)[]`. We concatenate every `text` entry, skipping thinking + tool-call (the triage call has no tools). Empty content → throw `STRATA_E_LLM_EMPTY_RESPONSE`. The triage classifier's caller decides how to react.

### D6 — `apiKey` precedence: explicit > env var

Constructor `apiKey` (passed by tests or future config) wins. Otherwise `getEnvApiKey(provider)`. No `.strata/config.json` API key field — AGENTS.md forbids it and `loadConfig` already refuses keys named `api_key`/`token`/`secret`.

## Risks / Trade-offs

- **Env-var dependency** ties Strata's LLM access to the user's shell environment. OK for V1 because the user already manages OpenClaw the same way; a fully-wired OpenClaw auth path is D3's follow-up.
- **No streaming** means triage waits ~1–3s per inbound message before the routing hint is ready. The hook runs `before_prompt_build`, so this is the path adding latency. Acceptable; trim later via cache.
- **pi-ai retries**: built into the library. We don't see them; the only externally visible signal is total latency.
