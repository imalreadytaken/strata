## Context

The query tool sits next to `strata_search_events`. Split of concerns:

- `strata_search_events` — search the *raw event* ledger by summary / type / time. Useful for "find the event the user is talking about" (corrections, supersede).
- `strata_query_table` — read the *business* table the capability owns. Useful for aggregates ("total spend"), filtering ("show last 5 expenses over $20"), top-N kinds of queries.

We deliberately keep the tool's schema **structured** rather than accepting raw SQL: the agent's prompt template can describe what each parameter does, and we get safety + introspection for free.

## Goals / Non-Goals

**Goals:**
- One tool, structured params, no raw SQL.
- Validates every column reference against `PRAGMA table_info(primary_table)` before binding into SQL.
- Single aggregate per call (sum/count/avg/min/max). When `aggregate` is supplied, `rows` is omitted from the response.
- Hard limit cap (100) so even a runaway agent can't dump the table.
- Tests run against a real DB with a tiny `expenses` fixture.

**Non-Goals:**
- No GROUP BY support yet. The agent buckets client-side or does multiple calls.
- No JOIN. Each call is single-table.
- No DELETE / UPDATE — read-only by design.
- No access to `messages` / `raw_events` through this tool. Those have their own paths.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/tools/query_table.ts` | new | `queryTableTool` factory, Zod schema, `QueryTableDetails`. |
| `src/tools/query_table.test.ts` | new | Real-DB query tests against a seeded `expenses` table. |
| `src/skills/query/SKILL.md` | new | Agent skill markdown. |
| `src/skills/index.ts` | modified | `loadQuerySkill()`. |
| `src/skills/index.test.ts` | modified | Assertions for query skill. |
| `src/tools/index.ts` | modified | Register the tool. |
| `src/tools/index.test.ts` | modified | 9-tool count + name list. |
| `src/triage/hook.ts` | modified | `query` template names `strata_query_table`. |
| `src/triage/hook.test.ts` | modified | Updated assertion. |

## Decisions

### D1 — Column validation via `PRAGMA table_info`, cached per tool call

Per-call cache: the tool reads `PRAGMA table_info(<primary_table>)` once and reuses the column set for filter / order_by / select / aggregate validation. Rejections produce a clear error naming the unknown column.

### D2 — Aggregate is a single tagged operation

`aggregate: { fn: 'sum' | 'count' | 'avg' | 'min' | 'max', column: string }`. `count` ignores the column (counts rows post-filter). Single aggregate per call keeps the result shape simple.

### D3 — Filter is equality-only for V1

`filter: Record<string, primitive>` → `WHERE col1 = ? AND col2 = ? …`. Range filters on time use the dedicated `since` / `until` (which bind to `occurred_at` per AGENTS.md's business-row contract).

### D4 — Default `select` is all columns

When `select` is omitted, the tool returns every column. Limit at 50 rows by default. The agent can narrow `select` to keep token cost down on wide tables.

### D5 — Hard cap `limit <= 100`

Strata isn't a BI tool. If the agent wants more, it does multiple calls or asks the user. The Zod schema enforces.

### D6 — Query template + search template both surface in triage

The query routing now points at *both* `strata_query_table` (for business-table aggregates) and `strata_search_events` (for raw-event-ledger lookups). The skill teaches the difference.

## Risks / Trade-offs

- **No GROUP BY** is real. A user asking "spend per category" requires the agent to call `strata_query_table` once with `select=['category', 'amount_minor']` and bucket client-side. That's fine at typical user volumes (<1000 rows).
- **Equality-only filter** means range queries on non-time columns aren't possible. Acceptable; the agent can post-filter the returned rows.
- **The agent might still call for too many rows.** Limit cap + token-cost feedback ought to discourage; future change can add `count_only: true`.
