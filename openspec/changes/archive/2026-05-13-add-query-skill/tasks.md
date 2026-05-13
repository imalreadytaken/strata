## 1. Tool

- [x] 1.1 Create `src/tools/query_table.ts` exporting `queryTableTool(deps): AnyAgentTool` + `queryTableSchema` + `QueryTableDetails`. Zod schema accepts `{ capability_name, filter?, since?, until?, order_by?, order_direction?, limit?, select?, aggregate? }`.
- [x] 1.2 `execute`:
  - Look up `capability_name` in `capabilityRegistryRepo`. Missing → throw (the SDK surfaces to LLM).
  - `PRAGMA table_info(primary_table)` to get the column set.
  - Validate filter keys / order_by / select entries / aggregate.column against the column set. Unknown → throw.
  - Build `WHERE filter = ? AND since? AND until?` with parametrised bindings (against `occurred_at` for `since`/`until`).
  - On `aggregate`: `SELECT <fn>(col) AS value FROM table WHERE ...`. Return `{ aggregate: { fn, column, value } }`.
  - Otherwise: `SELECT <selectCols> FROM table WHERE ... ORDER BY ? <dir> LIMIT min(limit, 100)`. Return `{ rows, count: rows.length }`.

## 2. Wiring

- [x] 2.1 Modify `src/tools/index.ts`: import + register `queryTableTool` in `buildEventTools`. Update `registerEventTools` wiring.
- [x] 2.2 Modify `src/tools/index.test.ts`: tool count 8 → 9; expected sorted list includes `strata_query_table`.

## 3. Triage hook

- [x] 3.1 Modify `src/triage/hook.ts`: static tool list grows; `query` template now says "Tool sequence: strata_query_table (business-table aggregates / filters / top-N) AND strata_search_events (raw-event lookup)".
- [x] 3.2 Modify `src/triage/hook.test.ts`:
  - `static block names every strata_* tool` adds `strata_query_table` to the assertion list.
  - `query` template assertion now expects both `strata_query_table` and `strata_search_events`.

## 4. Skill

- [x] 4.1 Create `src/skills/query/SKILL.md`:
  - Front-matter `name: query`, multi-line description with triggers (history questions, aggregate questions, "show me" requests) and non-triggers (recording a fact → capture; build requests → build).
  - Workflow: identify capability → pick rows vs aggregate → build filter → call `strata_query_table` → format answer.
  - Worked examples (3): money aggregate (`sum(amount_minor)` last month), count-over-time, top-N.
  - "Do NOT" section: never use `strata_create_pending_event` in a query flow; never query `messages` / `raw_events` through this tool (use `strata_search_events`).
- [x] 4.2 Modify `src/skills/index.ts`: add `loadQuerySkill()`.
- [x] 4.3 Modify `src/skills/index.test.ts`: parallel assertions for query skill — file exists, mentions `strata_query_table`, lists worked examples.

## 5. Tests

- [x] 5.1 `src/tools/query_table.test.ts`:
  - Seeded expenses table with 5 rows across categories.
  - Filter by category=dining returns the matching rows.
  - `aggregate: sum(amount_minor)` returns the right number.
  - `aggregate: count` ignores `column` and counts post-filter.
  - `since`/`until` bind to occurred_at.
  - Unknown capability → throws.
  - Unknown filter column → throws.
  - `limit > 100` is capped.
  - `select` narrows the returned columns.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` all pass.
- [x] 6.3 `openspec validate add-query-skill --strict`.
