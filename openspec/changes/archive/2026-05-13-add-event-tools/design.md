## Context

`STRATA_SPEC.md` §5.3 sketches six tools with a `Tool` interface borrowed from a different vintage of the OpenClaw SDK (`{ name, description, parameters: ZodSchema, execute(input, api) }`). The actual `openclaw@2026.3.23` `registerTool` surface is different — its parameters slot wants a `TSchema` (TypeBox) and `execute` is `(toolCallId, params, signal, onUpdate) => Promise<AgentToolResult>` with no per-call `api` argument. We reconcile this here and lock in a single convention for every Strata tool we ship.

The tools are the only LLM-facing write path against `raw_events`. Their correctness boundary is the state machine — `pending → committed | superseded | abandoned`, plus the supersede chain — so this change spends most of its design budget on those transitions, not on schema theatre.

## Goals / Non-Goals

**Goals:**
- One `registerEventTools(runtime)` factory the plugin entry calls once; the factory returns an `OpenClawPluginToolFactory` so per-session `ctx.sessionId` and `ctx.requesterSenderId` are captured at session start (not module load).
- Zod 4 schemas remain the source of truth for parameter shape and runtime parsing (matches the rest of the repo and the team's existing muscle memory).
- Every tool returns a structured result via `payloadTextResult(...)` from `@openclaw/plugin-sdk/agent-tools/common` so the LLM gets both human-readable text and machine-parseable details.
- `supersede` is transactional: the old row's `status='superseded'` flip and the new row's INSERT either both land or neither does.
- `commitEventCore(eventId, deps)` is exported separately so the next change's inline-keyboard callback can call the same code path without re-implementing it.

**Non-Goals:**
- No business-table writes inside `commit` — the pipeline runner is P3. We persist `capability_name` on the event row so a later pass can pick it up.
- No OpenClaw `memory.store` integration. The spec §5.3.3 adds an `api.memory.store(...)` call from inside `commit`; that surface does not exist on `OpenClawPluginApi` and the cross-session recall path is the agent reading messages + raw_events directly. Documented in D5.
- No vector search in `strata_search_events`. Embeddings are not yet generated; LIKE on `source_summary` is enough to satisfy the cross-session correction flow.
- No per-tool gating (`ownerOnly`). Strata is single-user; if/when multi-user lands we revisit.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/tools/create_pending_event.ts` | new | `createPendingEventTool(deps)` factory + Zod schema. Inserts `pending` row, calls `pendingBuffer.add(...)`, returns `{ event_id, status, summary }`. |
| `src/tools/update_pending_event.ts` | new | `updatePendingEventTool(deps)` factory. Merges `patch` into `extracted_data`, appends `related_message_id` to `related_message_ids`, optionally overrides `source_summary`. Refuses if row not pending. |
| `src/tools/commit_event.ts` | new | `commitEventTool(deps)` factory **plus** `commitEventCore(deps, eventId)` exported helper used by `add-callbacks`. Transitions to `committed`, removes from buffer. |
| `src/tools/supersede_event.ts` | new | `supersedeEventTool(deps)` factory. Wraps two writes (`UPDATE old`, `INSERT new`) inside `rawEventsRepo.transaction(...)`. |
| `src/tools/abandon_event.ts` | new | `abandonEventTool(deps)` factory. Transitions to `abandoned`, stamps `abandoned_reason`, removes from buffer. |
| `src/tools/search_events.ts` | new | `searchEventsTool(deps)` factory. LIKE on `source_summary`, optional `event_type`/`status`/`since`/`until` filters, ORDER BY `committed_at DESC` (NULLs last), LIMIT (default 10, max 50). |
| `src/tools/index.ts` | new | Barrel + `registerEventTools(api, runtime): void` — iterates `api.registerTool(factory)` for each tool. |
| `src/tools/*.test.ts` | new (6) | Vitest cases mirroring every Scenario in the spec. |
| `src/tools/zod_to_json_schema.ts` | new | Tiny helper that runs `z.toJSONSchema(schema, { target: 'draft-2020-12' })` and brands the result as `unknown` for the SDK's `parameters` field. Single home so all six tools convert the same way. |
| `src/index.ts` | modified | Call `registerEventTools(api, runtime)` after `startPendingTimeoutLoop`. |

## Decisions

### D1 — Zod stays the source of truth; `parameters` is JSON Schema produced by `z.toJSONSchema`

The OpenClaw `AgentTool.parameters` field is typed `TSchema` (TypeBox). `AnyAgentTool` is `AgentTool<any, unknown>` which collapses to `parameters: any`, so the field accepts anything at compile time. At runtime, `pi-agent-core` passes the schema straight through to the model provider as JSON Schema. Zod 4's `z.toJSONSchema(schema, { target: 'draft-2020-12' })` produces exactly the shape Claude / GPT-4o-class models expect.

Inside `execute`, we run `schema.parse(rawParams)` for typed extraction. Invalid input throws `ZodError`, which the SDK surfaces back to the LLM as a tool error — exactly the desired behaviour.

Trade-off: we technically generate the JSON Schema once per `definePluginEntry` registration. That's cheap (sub-ms) and runs at plugin boot, not per call.

### D2 — `OpenClawPluginToolFactory` instead of plain `AnyAgentTool`

`registerTool(factory)` invokes `factory(ctx)` once per session, giving us `ctx.sessionId`. The spec's `api.context.session_id` (read inside `execute`) doesn't exist in the SDK we use. Capturing `sessionId` in the factory closure is the closest faithful translation. A consequence: a tool created in session A cannot accidentally write into session B's pending buffer — the `session_id` is bound at construction.

Edge case: `ctx.sessionId` can be undefined (e.g., CLI ad-hoc tool calls). We fall back to `"default"` and log a warn. Tools still work; the buffer just keys everything under one session.

### D3 — Tool `execute` returns `payloadTextResult(...)`

`payloadTextResult<T>(payload: T)` produces an `AgentToolResult<T>` whose `output[0]` is `text: JSON.stringify(payload)` and whose `details: T` is the same object. LLMs get a readable string; downstream Strata code can read `result.details` typed. Avoids hand-rolling result shapes.

### D4 — Supersede is transactional via `repo.transaction(...)`

Two writes:
1. `INSERT INTO raw_events (..., status='committed', supersedes_event_id=old.id, ...)`
2. `UPDATE raw_events SET status='superseded', superseded_by_event_id=newId WHERE id=old.id`

If write 1 succeeds and write 2 fails, we'd have two `committed` rows for the same fact with no link between them — exactly the kind of silent ledger corruption the supersede chain exists to prevent. `rawEventsRepo.transaction(fn)` wraps both in `BEGIN`/`COMMIT`/`ROLLBACK`. The base repository's existing transaction helper (`base.ts`) is reused; we add no SQLite primitives.

### D5 — Skipped: `api.memory.store(...)` from `commit`

`STRATA_SPEC.md` §5.3.3 calls `api.memory.store({...})` after `commit` so the OpenClaw memory plugin can recall the event in future sessions. The current `OpenClawPluginApi` shape has no `memory` field. The Strata DB itself (`messages` + `raw_events` + future business tables) is the source of truth — the `query` skill (P6) reads it directly. We omit the spec call to avoid a dangling API reference, and a future "expose Strata as a memory provider" change can wire it back if needed.

### D6 — Search is LIKE-on-`source_summary`, not FTS5

`raw_events` has no FTS5 shadow table (only `messages` does, see `001_messages.sql`). Adding one is a migration with non-trivial trigger churn and is overkill for the cross-session-correction use case. The agent already does Strata-aware fuzzy matching in its head; a plain `source_summary LIKE '%query%'` with a few structured filters is enough. When P6 adds embeddings, we'll add a second search tool rather than touch this one.

### D7 — Result `details` types are exported

Each tool exports both its Zod schema and a `ToolResult` type derived from the return value. The skill author can reach for these types when writing helpers (`add-triage-and-capture-skill` uses them). Tests assert against the schema, not raw shapes — drift is detected at compile time.

### D8 — `pendingBuffer.add(...)` and `.remove(...)` failures are swallowed inside the tool

Buffer mutations are best-effort (the buffer's own contract). Inside `commit`, if the DB transition succeeds but the buffer write fails, the timeout loop will reconcile within `pollEveryMs`. The tool result reflects the DB truth, not the buffer state.

## Risks / Trade-offs

- **Zod ↔ JSON Schema drift**: `z.toJSONSchema` covers the Zod 4 surface we use (`z.object`, `z.string`, `z.number`, `z.enum`, `z.record`, `z.array`, `.optional()`, `.describe()`). Anything fancier (refinements, transforms) is forbidden in tool schemas — they have no JSON Schema equivalent. Enforced by review.
- **`status='pending'` race**: between the `findById` check and the `update(..., status='committed')`, a parallel call could change the row. The spec accepts this risk for V1: human-paced tool calls don't race meaningfully, and the worst case is a "row is not pending" error returned to the agent. A future change can switch to a single `UPDATE ... WHERE status='pending' RETURNING *` if needed.
- **`supersede` outside a transaction in tests**: better-sqlite3's `db.transaction(fn)` is sync; our wrapper is the async manual-BEGIN/COMMIT pattern from `base.ts::transaction`. Tests that fake the DB to throw from `update(...)` must verify the new row was rolled back (no orphan `committed` rows). Covered in `supersede_event.test.ts`.
- **`search` ordering on NULL `committed_at`**: pending rows have `committed_at = NULL`. We sort `committed_at DESC NULLS LAST, created_at DESC` so pending hits don't get buried but committed ones come first.
