## Why

`triage` (and soon `reflect`) need a real LLM. Today `runtime.llmClient` is a `HeuristicLLMClient`: useful as a deterministic fallback, but it can't classify novel phrasings or judge "is this cluster a new capability?" The seam (`LLMClient.infer({ system, user, responseSchema }): Promise<string>`) has been waiting for a real backend since `add-triage-and-capture-skill` D2.

`PiAiLLMClient` wires that seam to `@mariozechner/pi-ai`'s `complete(model, context, options)`: pick a `provider/modelId` from `config.models.<purpose>`, resolve the API key from `getEnvApiKey(provider)` (or a supplied override), call `complete`, return the assistant text. On any failure (missing config, missing key, model rejected the request), the runtime keeps the heuristic — Strata stays usable when the LLM is unreachable.

References: `STRATA_SPEC.md` §10.1 (`config.models.fast / smart / coder`), `add-triage-and-capture-skill` D2 (LLMClient seam), `openspec/AGENTS.md` "LLM access" (no hardcoded keys/models).

## What Changes

- Add `llm-client` capability covering:
  - **`PiAiLLMClient`**: implements the existing `LLMClient` interface. Constructor `{ provider: KnownProvider; modelId: string; apiKey?: string; complete?: typeof complete; getModel?: typeof getModel; logger? }`. Defaults `complete` and `getModel` to `@mariozechner/pi-ai`'s exports; tests inject stubs.
  - **`resolveLLMClient(config, opts): LLMClient`** — runtime factory. Reads `config.models.fast` (V1: only `fast` is wired). When the value is `'auto'` (default), returns `new HeuristicLLMClient()`. When the value is `'<provider>/<modelId>'`, parses + resolves a key via `getEnvApiKey(provider)` (or `opts.apiKey`). When provider/key can't be resolved, logs `warn` and falls back to the heuristic. Future change can add `smart` and OpenClaw `modelAuth` resolution.
  - **Config schema extension**: `ConfigSchema.models = { fast: 'auto' | '<provider>/<modelId>'; smart: ...; coder: ... }`. Default values per spec §10.1 (`'auto'` for fast/smart; `'claude-code-cli'` for coder — coder isn't wired here, just reserved).
  - **Runtime wiring**: `bootRuntime` calls `resolveLLMClient(config, { logger })`; replaces the unconditional `new HeuristicLLMClient()`.

## Capabilities

### New Capabilities
- `llm-client`: pi-ai-backed `LLMClient` implementation + runtime resolver with heuristic fallback.

### Modified Capabilities
- `core-infrastructure`: `ConfigSchema` gains the `models` field.
- `triage-hook`: no code change, but the runtime's `llmClient` is now real when configured.

## Impact

- **Files added**:
  - `src/llm/pi_ai_client.ts` — `PiAiLLMClient`, `resolveLLMClient`, `LLMClientResolution`.
  - `src/llm/pi_ai_client.test.ts` — happy path with stubbed `complete`; resolver paths (`'auto'` → heuristic; `'anthropic/claude-haiku-4-5'` → pi-ai when key present; missing key → heuristic + warn).
- **Files modified**:
  - `src/core/config.ts` — schema gains `models`.
  - `src/core/config.test.ts` — new defaults + parsing tests.
  - `src/runtime.ts` — calls `resolveLLMClient`.
  - `src/runtime.test.ts` — assertion stays "llmClient defined" (the heuristic fallback still satisfies that).
- **Non-goals**:
  - No `smart` model wired (only `fast`). Reflect agent's smart calls land with the Reflect change.
  - No OpenClaw `modelAuth.getApiKeyForModel(...)` integration. The runtime helpers exist but pulling them in needs more SDK exploration; env-var keys are the V1 path. Documented as D3.
  - No JSON-schema-mode in the request. We pass the schema through to `infer({ responseSchema })` but pi-ai's `complete` doesn't currently enforce it provider-side; the response is JSON-parsed + validated by the caller (`classifyIntent`). Adequate for the worked examples.
  - No retry policy / rate-limit backoff. pi-ai handles transient HTTP retries; we don't add a per-Strata layer.
