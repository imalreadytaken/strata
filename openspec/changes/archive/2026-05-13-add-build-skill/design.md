## Context

Triage already classifies build requests correctly (`HEURISTIC_RULES` catches "加.*功能", "加个.*追踪", "/build", "track.*for me"). The gap is **downstream of the classification**: there's no tool the agent can call, no skill it can follow, no row that gets written. This change wires those three pieces in one stroke.

The `proposals` table already exists and supports `source='user_request'`. The Reflect agent will eventually share this table from the other direction (`source='reflect_agent'`); the Build orchestrator (future) reads from both sources.

## Goals / Non-Goals

**Goals:**
- One **lightweight** tool — `strata_propose_capability` — writes directly to `proposals`. No `raw_events` indirection, no pending/committed dance: a build request is *about* the system, not a fact in the user's life ledger.
- The build SKILL.md mirrors capture's structure (`name` / `description` frontmatter, workflow steps, examples, "what NOT to do" boundary) so the agent's mental model stays consistent.
- The triage hook's template change is one-template-edit only. Tests that pinned the old "not shipped" string get updated to the new tool name.
- Tests cover the failure mode that matters: a build request that's still too vague to draft a proposal should NOT call the tool — the agent should ask one clarifying question first.

**Non-Goals:**
- No proposal status transitions inside this change. We INSERT `pending` and stop. `approved` / `applied` / `declined` are owned by the (future) orchestrator and Reflect agent.
- No reading from `proposals` from the agent side yet. A `strata_list_pending_proposals` tool is a small follow-up; until then, the agent simply trusts that the row was recorded.
- No coupling between proposal and the user's `messages`. A future change can add `primary_message_id INTEGER REFERENCES messages(id)` if we find we need that linkage; today the user's request lives in `messages` (because of `installMessageHooks`) and the proposal title summarises it.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/tools/propose_capability.ts` | new | `proposeCapabilityTool(deps)`, `proposeCapabilitySchema`, `ProposeCapabilityDetails`. |
| `src/tools/propose_capability.test.ts` | new | Happy path, defaults, target_capability optional, schema rejections. |
| `src/skills/build/SKILL.md` | new | Agent skill. |
| `src/skills/index.ts` | modified | Adds `loadBuildSkill()`. |
| `src/skills/index.test.ts` | modified | Build-skill assertions. |
| `src/tools/types.ts` | modified | `EventToolDeps.proposalsRepo`. |
| `src/tools/index.ts` | modified | Register the new tool. |
| `src/tools/test_helpers.ts` | modified | Harness builds `proposalsRepo`. |
| `src/triage/hook.ts` | modified | `build_request` template rewritten to route to the build skill. |
| `src/triage/hook.test.ts` | modified | Assertion expects `strata_propose_capability`. |
| `src/skills/capture/SKILL.md` | modified | One cross-reference line directing build-request intents elsewhere. |

## Decisions

### D1 — Tool writes directly to `proposals`, not via `raw_events`

A build request isn't a personal fact; it's a system-change request. Routing it through `raw_events` would conflate the two ledgers and force a "pipeline" that just translates one row into another. Direct INSERT is honest and one fewer indirection. `raw_events` stays the user-life ledger; `proposals` stays the system-changes ledger.

### D2 — `EventToolDeps` gains `proposalsRepo`

The dep bag grows by one field. We keep all `strata_*` tools registered through the same factory because consumers (callbacks, future skill router) reach for `deps.<repo>` uniformly. If the surface diverges later, splitting is mechanical.

### D3 — No pending → committed for proposals

The tool inserts with `status='pending'` and that's the entire mutation. Unlike `raw_events`, there's no "user confirms via button" step in this change — the user's act of *asking* IS the proposal. If we later want a confirmation UX ("I'd suggest tracking weight; should I queue it?"), we can add `strata_approve_proposal` / `strata_decline_proposal` tools; today, every proposal lands as pending and the user can decline it via a future cancel command.

### D4 — Skill explicitly bans "respond conversationally"

The old triage template told the agent to chat. The build SKILL.md explicitly inverts that:

> Do NOT just acknowledge the request conversationally. Always call `strata_propose_capability` so the request lands in the `proposals` ledger.

This is the closest we get to forcing tool use without OpenClaw exposing tool_choice. The agent prompt usually obeys; if it doesn't, we'll iterate on the skill text.

### D5 — Clarifying-question heuristic in the skill, not the tool

The tool schema rejects empty strings on `title`/`summary`/`rationale`. The skill is where we tell the agent "if the user's request is `'加个东西'` with no domain, ask one clarifying question first." That keeps the tool dumb and the prompt-engineering centralized.

### D6 — `target_capability` is the optional pointer at a pre-existing capability

When the user says "在 expenses 里加个标签字段", the skill identifies `target_capability='expenses'` and `kind='new_capability'` is wrong — that's `'schema_evolution'`. We start scoped: this change covers `kind='new_capability'` only. The schema-evolution kind ships when we have a real evolution flow to back it. If the user requests a modification to an existing capability today, the skill asks them to phrase it as "track X" (a new domain) for now; not great UX but honest.

## Risks / Trade-offs

- **No idempotency / dedup.** Two requests for "weight tracking" become two rows. The orchestrator (future) will dedupe; until then, the `proposals` table can get noisy. Acceptable: rows are cheap and rare.
- **No proposal expiry today.** The `expires_at` column stays NULL. A 30-day cleanup is a P5 chore.
- **`target_capability` is optional but not validated against the registry.** If the user names a non-existent capability, the row still lands. The orchestrator can reject it later. We don't validate at INSERT time because the future Reflect-agent path may propose a target capability that doesn't exist *yet*.
