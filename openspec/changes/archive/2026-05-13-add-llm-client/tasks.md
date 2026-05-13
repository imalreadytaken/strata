## 1. Config schema

- [x] 1.1 Modify `src/core/config.ts`: add `ConfigSchema.models = z.object({ fast: z.string().default('auto'), smart: z.string().default('auto'), coder: z.string().default('claude-code-cli') }).strict().prefault({})`.
- [x] 1.2 Modify `src/core/config.test.ts`: assert defaults; assert that a config with `models.fast='anthropic/claude-haiku-4-5'` parses cleanly.

## 2. `PiAiLLMClient`

- [x] 2.1 Create `src/llm/pi_ai_client.ts` exporting:
  - `PiAiLLMClient implements LLMClient`. Constructor `{ provider: KnownProvider; modelId: string; apiKey?: string; complete?: typeof complete; getModel?: typeof getModel; logger?: Logger }`.
  - `infer({ system, user })`:
    - Resolve `model = getModel(provider, modelId)`.
    - Build `Context = { systemPrompt: system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] }`.
    - Call `complete(model, context, { apiKey })`.
    - Flatten `assistant.content` text parts; throw `STRATA_E_LLM_EMPTY_RESPONSE` when no text.
    - Return the concatenated text.
- [x] 2.2 Add `STRATA_E_LLM_EMPTY_RESPONSE` + `STRATA_E_LLM_FAILED` to `src/core/errors.ts`.

## 3. `resolveLLMClient`

- [x] 3.1 Export `LLMClientResolution = { client: LLMClient; backend: 'pi-ai' | 'heuristic'; model?: string }`.
- [x] 3.2 Export `resolveLLMClient(config: StrataConfig, opts: { logger: Logger; apiKey?: string; complete?; getModel?; getEnvApiKey? }): LLMClientResolution`:
  - If `config.models.fast === 'auto'` → `{ client: new HeuristicLLMClient(), backend: 'heuristic' }`.
  - Else split on `/`. If no `/` or provider not in `KnownProvider` set → log warn, return heuristic.
  - Resolve `apiKey = opts.apiKey ?? getEnvApiKey(provider)`. Missing key → log warn, return heuristic.
  - Else return `{ client: new PiAiLLMClient({ provider, modelId, apiKey, complete: opts.complete, getModel: opts.getModel, logger: opts.logger }), backend: 'pi-ai', model: 'provider/modelId' }`.

## 4. Runtime wiring

- [x] 4.1 Modify `src/runtime.ts`: replace `new HeuristicLLMClient()` with `resolveLLMClient(config, { logger }).client`. Log at `info` which backend was chosen.

## 5. Tests

- [x] 5.1 `src/llm/pi_ai_client.test.ts`:
  - `PiAiLLMClient.infer` happy path: stub `complete` to return an assistant message with two text parts. Result is the concatenation.
  - `PiAiLLMClient.infer` empty response: stub `complete` to return `content: []`. Throws `STRATA_E_LLM_EMPTY_RESPONSE`.
  - `PiAiLLMClient.infer` propagates `complete` errors as `STRATA_E_LLM_FAILED` (cause preserved).
  - `resolveLLMClient`: `'auto'` → backend `heuristic`.
  - `resolveLLMClient`: `'anthropic/claude-haiku-4-5'` + present env key → backend `pi-ai`, model string set.
  - `resolveLLMClient`: known provider, missing env key → heuristic + warn.
  - `resolveLLMClient`: unknown provider (`'magic/x'`) → heuristic + warn.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` all pass.
- [x] 6.3 `openspec validate add-llm-client --strict`.
