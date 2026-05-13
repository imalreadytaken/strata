## 1. Triage schemas + prompt

- [x] 1.1 Create `src/triage/index.ts`:
  - Export `triageKindSchema = z.enum(['capture','query','build_request','correction','chitchat'])`.
  - Export `triageResultSchema = z.object({ kind: triageKindSchema, confidence: z.number().min(0).max(1), reasoning: z.string().min(1) })`.
  - Export `triageInputSchema = z.object({ user_message: z.string().min(1), recent_messages: z.array(z.string()).default([]), active_capabilities: z.array(z.string()).default([]), pending_event_summaries: z.array(z.string()).default([]) })`. (Use Zod 4 `.prefault({})` if you need nested object defaults; here string-array `.default([])` is fine.)
  - Export `TRIAGE_PROMPT` as the §7.1 system prompt verbatim.
- [x] 1.2 Export `LLMClient` interface with one method `infer({ system, user, responseSchema }): Promise<string>`.
- [x] 1.3 Export `classifyIntent(input, llm): Promise<TriageResult>`:
  - Parse `input` with `triageInputSchema`.
  - Build the user-content payload as `JSON.stringify({ user_message, recent_messages, active_capabilities, pending_event_summaries })`.
  - Call `llm.infer({ system: TRIAGE_PROMPT, user: payload, responseSchema: zodToJsonSchema(triageResultSchema) })`.
  - Parse the result with `triageResultSchema.parse(JSON.parse(raw))`; rethrow with a wrapped error if the model returned invalid JSON.

## 2. Heuristic backend

- [x] 2.1 Create `src/triage/heuristics.ts`:
  - Export `HEURISTIC_RULES` (ordered array of `{ kind, name, regex, confidence }`).
  - Export `HeuristicLLMClient` class with `infer(params): Promise<string>` returning a `triageResultSchema`-shaped JSON string. Implementation: re-parse `params.user`, find the first rule whose `regex` matches `user_message`, default to `{ kind: 'chitchat', confidence: 0.5, reasoning: 'no rule matched' }`.
- [x] 2.2 Rules (in priority order):
  - `build_request` — `/加.*功能|加个.*追踪|track.*for me|build.*for me|^\/build/i`
  - `correction` — `/其实是|不是.*而是|应该是|修正|^\/fix\b|correction/i`
  - `query` — `/多少|几次|统计|最近\s*\d+\s*笔|how\s+much|how\s+many|^\/query/i`
  - `capture` — `/¥\s*\d+|\$\s*\d+|\d+\s*(?:元|块)|\d+\s*km|\d+\s*kg|\d+\s*分钟|跑步|咖啡|吃了|读完|心情|喝了|买了/`
- [x] 2.3 Each rule's `reasoning` cites the rule name.

## 3. Triage tests

- [x] 3.1 `src/triage/index.test.ts`:
  - `triageResultSchema` accepts valid, rejects out-of-range confidence, rejects unknown kind.
  - `triageInputSchema` defaults arrays to `[]`.
  - `classifyIntent` returns the parsed result for a stub `LLMClient` returning a valid JSON string.
  - `classifyIntent` throws a `ValidationError` (or similar) when the stub returns malformed JSON.
  - `classifyIntent` throws when the JSON parses but fails `triageResultSchema`.
- [x] 3.2 `src/triage/heuristics.test.ts`:
  - Table-driven cases for every rule: at least 2 positive matches each.
  - Spec's worked examples (8+ cases) classify as expected.
  - "Unknown" inputs (`'hi'`, `'thanks'`, `''`) hit the chitchat default.
  - The `reasoning` string contains the matching rule name.

## 4. Capture skill markdown

- [x] 4.1 Create `src/skills/capture/SKILL.md` matching `STRATA_SPEC.md` §5.4.1 structure, with:
  - Front-matter: `name: capture`, `description:` (multi-line `|` block summarising trigger conditions + non-triggers).
  - "Workflow" section: 5 numbered steps (identify event type → check capability binding → extract structured data → confidence assessment → call `strata_create_pending_event`).
  - "Handling follow-up" section covering `strata_update_pending_event` / `strata_commit_event` / `strata_abandon_event`.
  - "Cross-session corrections" section covering `strata_search_events` → `strata_supersede_event`.
  - Explicit confidence thresholds: `>= 0.7` → create; `0.3–0.7` → ask one clarifying question first; `< 0.3` → don't create.
  - "Confirmation UX" note: inline keyboard MAY not be rendered yet; ask the user in text and let their `yes/no` reply hit `strata_commit_event` / `strata_abandon_event` (links to `add-callbacks` D1).

## 5. Capture skill loader

- [x] 5.1 Create `src/skills/index.ts`:
  - `CaptureSkillFrontmatter` type: `{ name: string; description: string; version?: string }`.
  - `loadCaptureSkill(): Promise<{ frontmatter: CaptureSkillFrontmatter; body: string }>` reads `./capture/SKILL.md` relative to `import.meta.url`, splits on the leading `---` fence, parses key/value pairs (multi-line `description: |` block supported), returns the body after the second `---`.
- [x] 5.2 `src/skills/index.test.ts`:
  - File exists and is non-empty.
  - Front-matter has `name === 'capture'` and a non-empty `description`.
  - Body contains every `strata_*` tool name (`create_pending_event`, `update_pending_event`, `commit_event`, `supersede_event`, `abandon_event`, `search_events`).
  - Body mentions the confidence thresholds (`0.7` and `0.3`).
  - Body mentions the "inline keyboard MAY not be rendered" gap.

## 6. Plugin entry doc-comment

- [x] 6.1 Add a one-line note in `src/index.ts` about triage being ready but not wired into a hook yet (so the next person reading the file knows where to look).

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` — all tests pass.
- [x] 7.3 `openspec validate add-triage-and-capture-skill --strict`.
