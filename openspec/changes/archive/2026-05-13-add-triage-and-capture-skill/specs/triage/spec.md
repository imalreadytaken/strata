## ADDED Requirements

### Requirement: Triage exposes `classifyIntent` against a thin `LLMClient` seam

The system SHALL export `classifyIntent(input: TriageInput, llm: LLMClient): Promise<TriageResult>` where:

- `LLMClient` is an interface with one method `infer(params: { system: string; user: string; responseSchema?: unknown }): Promise<string>`.
- `TriageInput` is `{ user_message: string; recent_messages: string[]; active_capabilities: string[]; pending_event_summaries: string[] }`, validated by Zod with array fields defaulting to `[]`.
- `TriageResult` is `{ kind: 'capture' | 'query' | 'build_request' | 'correction' | 'chitchat'; confidence: number; reasoning: string }`, validated by Zod.

`classifyIntent` builds the user payload as the JSON-stringified input, calls `llm.infer({ system: TRIAGE_PROMPT, user, responseSchema })`, then parses the response into `TriageResult` (rejecting on invalid JSON or schema mismatch).

#### Scenario: Returns a parsed TriageResult for a valid LLM response

- **WHEN** the stub `LLMClient` returns `'{"kind":"capture","confidence":0.9,"reasoning":"money pattern"}'`
- **THEN** `classifyIntent(input, llm)` resolves to `{ kind: 'capture', confidence: 0.9, reasoning: 'money pattern' }`

#### Scenario: Rejects malformed JSON

- **WHEN** the stub `LLMClient` returns `'not json'`
- **THEN** `classifyIntent` rejects with an error mentioning JSON parsing

#### Scenario: Rejects a JSON response that fails the schema

- **WHEN** the stub `LLMClient` returns `'{"kind":"capture","confidence":99,"reasoning":"x"}'`
- **THEN** `classifyIntent` rejects with a ZodError (confidence out of range)

#### Scenario: Input schema defaults array fields to `[]`

- **WHEN** `triageInputSchema.parse({ user_message: 'hi' })` is called
- **THEN** the result has `recent_messages: []`, `active_capabilities: []`, `pending_event_summaries: []`

### Requirement: `HeuristicLLMClient` is a deterministic in-tree backend

The system SHALL ship `HeuristicLLMClient` implementing `LLMClient` such that calling `infer({ user })` returns a JSON-string `TriageResult` produced by the first matching rule in an ordered table:

1. `build_request` — message matches `/加.*功能|加个.*追踪|track.*for me|build.*for me|^\/build/i`
2. `correction` — message matches `/其实是|不是.*而是|应该是|修正|^\/fix\b|correction/i`
3. `query` — message matches `/多少|几次|统计|最近\s*\d+\s*笔|how\s+much|how\s+many|^\/query/i`
4. `capture` — message matches `/¥\s*\d+|\$\s*\d+|\d+\s*(?:元|块)|\d+\s*km|\d+\s*kg|\d+\s*分钟|跑步|咖啡|吃了|读完|心情|喝了|买了/`
5. Default — `chitchat` with `confidence: 0.5`.

Each rule's `reasoning` MUST cite the rule's name.

#### Scenario: Money pattern classifies as capture

- **WHEN** the user_message is `'今天买了 Blue Bottle 拿铁 ¥45'`
- **THEN** `HeuristicLLMClient.infer(...)` returns a JSON string with `kind='capture'` and a `reasoning` containing the rule name

#### Scenario: "其实是" classifies as correction

- **WHEN** the user_message is `'上周一咖啡其实是 ¥48'`
- **THEN** the returned kind is `correction`

#### Scenario: Vague message defaults to chitchat

- **WHEN** the user_message is `'hi'`
- **THEN** the returned kind is `chitchat` and `confidence` is `0.5`

#### Scenario: Build request takes priority over capture keywords

- **WHEN** the user_message is `'我想加个咖啡追踪'` (matches both "咖啡" capture-keyword AND "加个.*追踪" build-pattern)
- **THEN** the returned kind is `build_request` (the higher-priority rule fires first)
