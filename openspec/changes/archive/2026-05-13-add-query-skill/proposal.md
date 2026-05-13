## Why

The user can capture facts (`strata_create_pending_event` → commit → business table) but can't *ask* about them. "上个月花了多少钱?" hits triage as `query`, and triage's routing already says "use strata_search_events for raw_events search"; but search returns raw_events rows, not business-table aggregates. Question-answering needs a read-only SQL surface against business tables.

`strata_query_table({ capability_name, filter?, since?, until?, limit?, order_by? })` is the controlled tool the agent reaches for. It validates `capability_name` against the registry, validates filter columns against the capability's actual schema (`PRAGMA table_info`), parameterises every value, and caps results. No raw SQL from the agent.

Paired with `src/skills/query/SKILL.md`, the agent has a complete playbook for history questions.

References: `STRATA_SPEC.md` §5.4.2 (query skill), `add-event-tools` (`strata_search_events` shape).

## What Changes

- Add `query-skill` capability covering:
  - **`strata_query_table` agent tool**:
    - Parameters: `{ capability_name: string, filter?: Record<string, primitive>, since?: ISO8601, until?: ISO8601, order_by?: string, order_direction?: 'asc'|'desc', limit?: number (max 100, default 50), select?: string[] (defaults to all columns), aggregate?: { fn: 'sum'|'count'|'avg'|'min'|'max', column: string } }`.
    - Resolves `capability_name` via `capabilityRegistryRepo.findById`; refuses on unknown.
    - Reads `PRAGMA table_info(primary_table)` to know which columns exist; rejects filters / order_by / select / aggregate that reference unknown columns.
    - Builds a parametrised SELECT (no string concat of values).
    - On `aggregate`, returns `{ aggregate: { fn, column, value } }` instead of rows.
    - Returns `{ rows?: Row[], count: number, aggregate?: {...} }`.
  - **`src/skills/query/SKILL.md`**: trigger conditions (queries about historical data, aggregations across business tables), workflow (identify capability → choose columns → build filter → choose between rows / aggregate → format answer), worked examples covering money-aggregation, count-over-time, latest-N. Cross-reference: query is read-only — never call `strata_create_pending_event` from inside a query.
  - **`loadQuerySkill()` loader** parallel to `loadCaptureSkill` / `loadBuildSkill`.
  - **Plugin entry / `registerEventTools`**: the new tool is the 9th `strata_*`.

## Capabilities

### New Capabilities
- `query-skill`: agent skill + `strata_query_table` tool for read-only business-table queries.

### Modified Capabilities
- `event-tools`: 8 → 9 tools.
- `triage-hook`: `query` template now references `strata_query_table` (in addition to `strata_search_events`).

## Impact

- **Files added**:
  - `src/tools/query_table.ts` — `queryTableTool` + Zod schema.
  - `src/tools/query_table.test.ts`.
  - `src/skills/query/SKILL.md`.
- **Files modified**:
  - `src/skills/index.ts` — `loadQuerySkill()`.
  - `src/skills/index.test.ts` — parallel assertions.
  - `src/tools/index.ts` — register the new tool.
  - `src/tools/index.test.ts` — count + name assertions.
  - `src/triage/hook.ts` — query template names `strata_query_table` alongside `strata_search_events`.
  - `src/triage/hook.test.ts` — assertion updated.
- **Non-goals**:
  - No GROUP BY support (could land later). For V1 the agent calls `strata_query_table` once with rows then aggregates client-side, or asks once with a sum/count aggregate.
  - No JOIN across tables. Each call hits one capability's primary table.
  - No `messages` / `raw_events` access via this tool — those are covered by `strata_search_events` (raw events) and (future) `strata_search_messages` for the messages table.
