## ADDED Requirements

### Requirement: `PiAiLLMClient` implements `LLMClient` against pi-ai's `complete()`

The system SHALL export `PiAiLLMClient` whose `infer({ system, user, responseSchema? }): Promise<string>` method:

1. Resolves `model = getModel(provider, modelId)` via the injected `getModel` (default: `@mariozechner/pi-ai`'s `getModel`).
2. Constructs `Context = { systemPrompt: system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] }`.
3. Calls `complete(model, context, { apiKey })` via the injected `complete` (default: `@mariozechner/pi-ai`'s `complete`).
4. Flattens every `text` entry in `assistant.content` (skipping `thinking`/`tool_call`).
5. Returns the concatenated text. Empty result throws `STRATA_E_LLM_EMPTY_RESPONSE`.

Errors thrown by `complete` are wrapped as `STRATA_E_LLM_FAILED` with `cause` preserved.

#### Scenario: Happy path concatenates text parts

- **WHEN** stubbed `complete` returns `{ content: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }] }`
- **THEN** `infer(...)` resolves with `'hi there'`

#### Scenario: Empty content throws STRATA_E_LLM_EMPTY_RESPONSE

- **WHEN** stubbed `complete` returns `{ content: [] }`
- **THEN** `infer(...)` rejects with an error whose `code === 'STRATA_E_LLM_EMPTY_RESPONSE'`

#### Scenario: Underlying error becomes STRATA_E_LLM_FAILED

- **WHEN** stubbed `complete` rejects with `new Error('boom')`
- **THEN** `infer(...)` rejects with `STRATA_E_LLM_FAILED` and the `cause` is the original error

### Requirement: `resolveLLMClient` picks a backend from config + env

The system SHALL export `resolveLLMClient(config, opts): LLMClientResolution` returning `{ client, backend: 'pi-ai' | 'heuristic', model? }`. The resolution rules:

- `config.models.fast === 'auto'` → `{ backend: 'heuristic', client: new HeuristicLLMClient() }`.
- `config.models.fast` matches `'<provider>/<modelId>'` AND `provider` is a `KnownProvider` AND an API key resolves (via `opts.apiKey` or `getEnvApiKey(provider)`) → `{ backend: 'pi-ai', model: 'provider/modelId', client: new PiAiLLMClient(...) }`.
- Any other shape (unknown provider, missing key) → heuristic fallback with a `warn` log naming the reason.

#### Scenario: 'auto' returns the heuristic

- **WHEN** `config.models.fast = 'auto'`
- **THEN** the resolution has `backend: 'heuristic'`

#### Scenario: Valid provider + present env key returns pi-ai

- **WHEN** `config.models.fast = 'anthropic/claude-haiku-4-5'` and `getEnvApiKey('anthropic')` returns a non-empty string
- **THEN** the resolution has `backend: 'pi-ai'` and `model = 'anthropic/claude-haiku-4-5'`

#### Scenario: Missing env key falls back to heuristic

- **WHEN** `config.models.fast = 'anthropic/claude-haiku-4-5'` but `getEnvApiKey('anthropic')` returns undefined
- **THEN** the resolution has `backend: 'heuristic'` and a `warn`-level log records the missing key

#### Scenario: Unknown provider falls back to heuristic

- **WHEN** `config.models.fast = 'magic/x'`
- **THEN** the resolution has `backend: 'heuristic'` and a `warn`-level log names the unknown provider
