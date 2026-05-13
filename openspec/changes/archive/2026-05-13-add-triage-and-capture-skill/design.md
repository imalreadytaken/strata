## Context

`STRATA_SPEC.md` shows triage as a one-shot call to `api.models.infer({ model: 'fast', response_format: { type: 'json_schema', schema: TriageResult } })`. That API does not exist on `OpenClawPluginApi` (`openclaw@2026.3.23` exposes `runEmbeddedPiAgent` for full agent runs and a `modelAuth` resolver, but no thin "one-shot complete with JSON schema" entry — see `plugins/runtime/types-core.d.ts`). Two viable paths:

1. Bring up `@mariozechner/pi-ai` directly in this change, wiring it to the user's resolved model + auth. Heavy: needs config plumbing for model alias resolution, provider auth, and error handling.
2. Ship the classifier as a pure function with a thin `LLMClient` seam plus a working heuristic backend. Defer the actual LLM wiring to a later change once we settle on `pi-ai` vs `runEmbeddedPiAgent`.

We pick option 2. It keeps this change small, lets triage be **used today** (the heuristic backend correctly handles the spec's worked examples), and makes the swap a one-class change later.

The Capture skill is a Markdown file. Where it lives, who reads it, and how it's bundled depends on OpenClaw's skill-loading convention — which is not yet fixed (the plugin manifest doesn't surface a `skills:` field). The pragmatic move is to drop the file at `src/skills/capture/SKILL.md`, ship a typed loader, and have the future "skill router" call the loader. Tests pin the file's existence + the tool names it mentions so a drift between SKILL.md and the actual tool registrations gets caught in CI.

## Goals / Non-Goals

**Goals:**
- `classifyIntent` is a pure function: same input + same `LLMClient` ⇒ same output. Testable without mocking time, network, or filesystem.
- The `LLMClient` interface is minimal: `infer({ system, user, responseSchema })` returns the model's raw string response. Schema parsing happens inside `classifyIntent` so the seam stays simple.
- The heuristic backend is auditable: every classification decision is one of a handful of named rules. Tests assert each rule fires.
- The Capture skill markdown is the spec's §5.4.1 text adapted for the **actual** tool names we shipped (which now exist; the spec was speculative when it was written) and the **actual** callback gap (buttons may not be rendered yet — D1 of `add-callbacks`).
- A test asserts the SKILL.md mentions every `strata_*` tool name. If we add a tool tomorrow and forget to update the skill, CI catches it.

**Non-Goals:**
- No real LLM. See `proposal.md` "Non-goals" and D2 below.
- No skill router (the thing that decides "use capture skill" given a `TriageResult`). That's a P5 concern when the agent prompt builder lands.
- No persistence of triage results. The classifier is stateless; if a caller wants to record a result, it can write to `messages_fts`-adjacent metadata in a later change.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/triage/index.ts` | new | Exports `TRIAGE_PROMPT`, `triageInputSchema`, `triageResultSchema`, `classifyIntent(input, llm): Promise<TriageResult>`, plus the `LLMClient` interface. |
| `src/triage/heuristics.ts` | new | `HeuristicLLMClient` (one method `infer(...)`) plus the rule table, all data-driven so additional rules are one-line additions. |
| `src/triage/index.test.ts` | new | Schema validation + `classifyIntent` happy/edge cases against an injected stub `LLMClient`. |
| `src/triage/heuristics.test.ts` | new | Table-driven tests for every rule + the spec's worked examples. |
| `src/skills/capture/SKILL.md` | new | The skill markdown. |
| `src/skills/index.ts` | new | `loadCaptureSkill()` reads the file relative to `import.meta.url` and returns `{ frontmatter, body }`. |
| `src/skills/index.test.ts` | new | File-exists, front-matter shape, mentions every `strata_*` tool name, mentions confidence thresholds. |
| `src/index.ts` | modified | Doc comment only — no behaviour change. |

## Decisions

### D1 — `LLMClient` is a one-method interface, not a class

```ts
export interface LLMClient {
  infer(params: {
    system: string;
    user: string;
    responseSchema?: unknown; // JSON schema; opaque to the seam
  }): Promise<string>;
}
```

Rationale: the interface only needs to cover the triage call shape. A richer interface (streaming, tool use, etc.) would be over-fit. When we wire a real LLM later, a single class `PiAiLLMClient implements LLMClient` is all the new code.

### D2 — Skipped: real LLM-backed classifier

We expose `HeuristicLLMClient` as the default in-tree backend so `classifyIntent` is **usable today**. The heuristics cover the worked examples in the spec (cf. §5.6's classification table). The LLM-backed implementation slots in via a future change once we pick:

- `pi-ai` directly + the user's resolved model from `OpenClawConfig`, OR
- `runEmbeddedPiAgent` with a one-shot system prompt and no tools.

Each option needs its own change with its own design.md; bundling either into this one would balloon scope.

### D3 — Heuristic rules table

The heuristic backend matches against an ordered list of rules:

1. **build_request** — message contains `加.*功能` / `加个.*追踪` / `track.*for me` / `build.*for me` / explicit `/build`.
2. **correction** — message contains `其实是` / `不是` / `应该是` / `修正` / `correction` / explicit `/fix`.
3. **query** — message contains `多少` / `几次` / `统计` / `最近.*笔` / `how.*much` / explicit `/query`.
4. **capture** — message contains a money pattern (`¥` / `$` / `元` / 任意 4–6 位数字 followed by 单位) OR a measurement pattern (`km` / `kg` / `分钟` / `小时`) OR known event_type keyword (`跑步` / `咖啡` / `吃` / `读完` / `心情`).
5. **chitchat** — default (the spec's "when uncertain, prefer chitchat" rule).

Each rule has a name; the heuristic backend returns a `reasoning` that includes the matching rule name. Tests assert every rule fires for at least one input and that no input falls through to chitchat by accident.

### D4 — `responseSchema` is forwarded but not enforced by the seam

The heuristic backend ignores `responseSchema` (it always returns a valid `TriageResult`-shaped JSON string). A real LLM backend would pass it through to the model provider's JSON-schema constraint. We don't require either backend to actually validate — `classifyIntent` runs `triageResultSchema.parse(JSON.parse(raw))` after `infer` returns, so schema validation is enforced exactly once.

### D5 — Capture skill mentions actual tool names

The spec's §5.4.1 uses tool names that don't exactly match what we shipped (`strata_create_pending_event` etc.; the spec sometimes uses `create_pending_event`). The SKILL.md uses the actual exported names. A test reads the file and asserts every name is present — drift between code and skill is a CI-caught failure.

### D6 — Front-matter parser is hand-rolled

The SKILL.md front-matter has 2–3 keys (`name`, `description`, optional `version`). Pulling in `yaml` is overkill. `loadCaptureSkill()` splits on the `---` fence and parses simple `key: value` pairs (description is a multi-line `|` block we read until the next non-indented line).

## Risks / Trade-offs

- **Heuristics will misclassify**. That is acceptable: the spec's instruction is "prefer chitchat over capture when uncertain"; the heuristic table is biased toward false negatives. When the LLM backend lands, it replaces the heuristic for real classifications; the heuristic stays as a deterministic test fixture.
- **SKILL.md gets out-of-date when tools change**. The test asserts every `strata_*` tool name appears in the markdown. If a future change renames a tool and forgets to update the skill, the test fails. The reverse direction (skill mentions a tool that no longer exists) is not auto-detected; we add a TODO comment in the skill to keep the list in sync.
- **`import.meta.url`-relative file read** means the test must run from a `vitest` config that supports ES modules (it does — confirmed by existing tests).
