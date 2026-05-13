## Why

`event-tools` + `callbacks` give Strata a write path; the agent now needs **direction** so it knows when to pull that path. Two pieces from `STRATA_SPEC.md` close the loop:

1. **§5.6 Triage** — A lightweight intent classifier (`capture` / `query` / `build_request` / `correction` / `chitchat`) that the agent consults on every inbound user message. Knowing the kind lets us avoid spending tokens running every message through the Capture skill prompt.
2. **§5.4.1 Capture skill** — A Markdown file the agent loads when triage says `capture`. It tells the agent how to extract structured data, pick a `confidence`, decide between `create` / `update` / `commit`, and handle follow-up.

This is the final P2 milestone. After this lands, Strata can take a Telegram message, classify it, route the agent to the capture skill, persist a `pending` row, and let the user confirm — all on top of code shipped in the previous four P2 changes.

References: `STRATA_SPEC.md` §5.6 (Triage code shape), §7.1 (Triage prompt text), §5.4.1 (capture skill markdown), `openspec/AGENTS.md` "LLM access" section.

## What Changes

- **Add `triage` capability**:
  - **`classifyIntent(input: TriageInput, llm: LLMClient): Promise<TriageResult>`** — pure function that builds the prompt (system + user JSON payload), calls `llm.infer(...)`, parses the JSON response into a Zod-validated `TriageResult`.
  - **`TriageInput`** + **`TriageResult`** Zod schemas. `TriageResult` is `{ kind: 'capture' | 'query' | 'build_request' | 'correction' | 'chitchat'; confidence: number; reasoning: string }`.
  - **`LLMClient`** interface: a thin one-method seam (`infer({ system, user, responseSchema }): Promise<string>`) so the triage code is testable without an LLM AND swappable when a real OpenClaw inference path lands.
  - **`HeuristicLLMClient`**: a working in-tree implementation that uses keyword + regex heuristics over the user message and the active-capability list. Returns the right `kind` for the spec's worked examples (`'今天买了咖啡 ¥45'` → capture; `'上周一咖啡其实是 ¥48'` → correction; `'最近三笔消费?'` → query; etc.) and `chitchat` as the safe default — the spec's exact instruction: *"when uncertain, prefer chitchat over capture (we'd rather miss a record than fabricate one)"*. This keeps Strata useful today and lets a future change wire an actual LLM-backed client.
  - **`TRIAGE_PROMPT`** constant carrying the §7.1 text verbatim, exported so a future LLM-backed client can reuse it.

- **Add `capture-skill` capability**:
  - **`src/skills/capture/SKILL.md`** — the agent-facing skill markdown, written to match the spec's §5.4.1 structure (front-matter, workflow steps, follow-up handling, cross-session correction). It explicitly names the six `strata_*` tools the agent will call, the confidence thresholds, and the "buttons may not arrive — fall back to text confirmation" gap from `add-callbacks` D1.
  - **`loadCaptureSkill(): Promise<{ frontmatter: CaptureSkillFrontmatter; body: string }>`** — a tiny loader so consumers (tests, future skill router) read the file once with a typed front-matter. Front-matter is parsed manually (it's only a few keys) so we don't pull in a YAML parser.

- **Plugin entry wiring**: `register(api)` does not yet *invoke* triage — the triage classifier needs to be called from a hook that reads the inbound message after `message_received` persistence and before the agent runs. That hook is a P5/P6 concern. We expose `classifyIntent` and the heuristic client so any caller (future hook, CLI test harness, the agent itself via a tool) can use them today.

## Capabilities

### New Capabilities
- `triage`: intent classifier seam + Zod-validated result + working heuristic implementation.
- `capture-skill`: agent skill markdown + typed loader.

### Modified Capabilities
*(none)*

## Impact

- **Files added**:
  - `src/triage/index.ts` — exports `classifyIntent`, schemas, `TRIAGE_PROMPT`.
  - `src/triage/heuristics.ts` — `HeuristicLLMClient` (and the rule set as data).
  - `src/triage/index.test.ts` — schema + classifier behaviour.
  - `src/triage/heuristics.test.ts` — the worked-examples table from the spec.
  - `src/skills/capture/SKILL.md` — the markdown.
  - `src/skills/index.ts` — `loadCaptureSkill()`.
  - `src/skills/index.test.ts` — file-exists, front-matter shape, mentions every `strata_*` tool name.
- **Files modified**:
  - `src/index.ts` — adds a doc-comment note that triage is wired-ready but not invoked.
- **Non-goals**:
  - No real LLM-backed `LLMClient`. The path through OpenClaw is not finalised: `runEmbeddedPiAgent` is heavyweight, and a thin `models.infer` does not exist on the plugin API. We ship the interface + heuristic so triage is useful today and the swap is a single class.
  - No on-message hook calling triage. That requires a `before_agent_start` or `llm_input` hook subscriber that mutates the prompt — out of scope here, will land alongside the agent-prompt builder in P5.
  - No `query` / `build` skills. The spec calls those out as P6 / P4 respectively.
