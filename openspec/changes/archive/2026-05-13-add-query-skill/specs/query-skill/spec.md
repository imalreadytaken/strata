## ADDED Requirements

### Requirement: `strata_query_table` exposes structured read-only queries over a capability's business table

The system SHALL register `strata_query_table` with the Zod schema `{ capability_name: string, filter?: Record<string, primitive>, since?: string, until?: string, order_by?: string, order_direction?: 'asc' | 'desc', limit?: number, select?: string[], aggregate?: { fn: 'sum' | 'count' | 'avg' | 'min' | 'max', column: string } }`. On execute the tool MUST:

1. Resolve `capability_name` via `capabilityRegistryRepo.findById`. Missing → throw.
2. Read `PRAGMA table_info(primary_table)` to know which columns exist.
3. Validate every column reference (`filter` keys, `order_by`, every entry in `select`, `aggregate.column`) against the known set. Unknown → throw with a clear message.
4. Build a parametrised SELECT. Filter values are bound via `?` placeholders (no string concat).
5. `since` / `until` bind to `occurred_at` (the AGENTS.md-mandated time column).
6. Hard-cap `limit` at 100; default 50.
7. When `aggregate` is set: `SELECT <fn>(<column>) AS value FROM table WHERE ...` → return `{ aggregate: { fn, column, value } }`. `count` ignores the column.
8. Otherwise: return `{ rows: [...], count: rows.length }` (where rows respect `select` / `order_by`).

#### Scenario: filter + limit returns matching rows

- **WHEN** the expenses table has rows split across `category='dining'` and `category='transport'` and the tool is called with `filter={category:'dining'}, limit=3`
- **THEN** the result's `rows` are all `category='dining'` and `count <= 3`

#### Scenario: sum aggregate returns a number

- **WHEN** 5 rows have `amount_minor` totalling 12500 and the tool is called with `aggregate={fn:'sum',column:'amount_minor'}`
- **THEN** the result is `{ aggregate: { fn: 'sum', column: 'amount_minor', value: 12500 } }` and `rows` is undefined

#### Scenario: count ignores aggregate.column

- **WHEN** the table has 3 matching rows and the call is `aggregate={fn:'count',column:'category'}`
- **THEN** the result's `aggregate.value === 3`

#### Scenario: Unknown capability throws

- **WHEN** `capability_name='no-such-cap'`
- **THEN** the execute call throws with a clear error

#### Scenario: Unknown filter column throws

- **WHEN** `filter` references a column that does not exist on the primary table
- **THEN** the execute call throws naming the unknown column

#### Scenario: limit > 100 is capped

- **WHEN** `limit = 999`
- **THEN** the returned `rows.length <= 100`

#### Scenario: since/until filter on occurred_at

- **WHEN** rows have `occurred_at` `2026-04-30..2026-05-05` and the call is `since: '2026-05-01T00:00:00Z'`
- **THEN** the returned rows all have `occurred_at >= '2026-05-01T00:00:00Z'`

### Requirement: `src/skills/query/SKILL.md` ships with the query workflow

The system SHALL ship `src/skills/query/SKILL.md` with front-matter `name: query` and a body that:

- Names `strata_query_table` and `strata_search_events` (the agent must know when to use which).
- Contains at least three worked examples covering money aggregation, count-over-time, and top-N.
- Forbids the agent from calling `strata_create_pending_event` inside a query flow.

#### Scenario: Loader returns the typed skill

- **WHEN** `loadQuerySkill()` is called
- **THEN** `frontmatter.name === 'query'` and the body contains `'strata_query_table'` and `'strata_search_events'`
