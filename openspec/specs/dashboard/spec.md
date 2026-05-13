# dashboard Specification

## Purpose

`dashboard` is Strata's read-only rendering surface: capabilities ship a `dashboard.json` next to `meta.json` declaring an ordered list of widgets, and the renderer turns those into a Telegram-ready markdown block the agent quotes back to the user. KPI widgets resolve to a single number (`sum`, `count`, `avg`, `min`, `max`); list widgets project up to N rows. The widget query language is a strict subset of `strata_query_table`'s parameter shape and routes through one shared helper, `executeWidgetQuery`, so both paths inherit the same `capabilityRegistryRepo.findById` → `PRAGMA table_info` → `?`-bound SELECT posture (no string concat of values, no unknown columns). `dashboard.json` is JSON5 (comments allowed) and loaded once at boot via `loadCapabilityDashboard` into an in-memory `DashboardRegistry`; missing file is silently OK, malformed file aborts boot with `STRATA_E_CAPABILITY_INVALID`. The agent reaches the renderer through `strata_render_dashboard({ capability_name? })`, surfaced in the triage `query` template. Output is plain Telegram markdown — `*Title*` headers, `• …` KPI bullets, numbered list rows — with widget-level error isolation (one bad widget renders `⚠️ …` inline; siblings still resolve).

## Requirements
### Requirement: `dashboard.json` schema declares an ordered widget list

The system SHALL parse `<capability_dir>/dashboard.json` with JSON5 and validate against `DashboardSchema = { widgets: Widget[] }` where each Widget is `{ kind: 'kpi' | 'list', title: string, query: WidgetQuery, format?: 'money' | 'count' | 'date' | 'text' }` and `WidgetQuery = { filter?: Record<string, primitive>, since?: string, until?: string, aggregate?: { fn: 'sum' | 'count' | 'avg' | 'min' | 'max', column: string }, order_by?: string, order_direction?: 'asc' | 'desc', limit?: number (max 100), select?: string[] }`. KPI widgets with `format!='text'` MUST set `query.aggregate`. Validation failures SHALL surface as `ValidationError`.

#### Scenario: Valid KPI widget parses

- **WHEN** a `dashboard.json` contains `{ widgets: [{ kind: 'kpi', title: 'Total', format: 'money', query: { aggregate: { fn: 'sum', column: 'amount_minor' } } }] }`
- **THEN** the parser returns a typed `Dashboard` with one widget and no error

#### Scenario: KPI without aggregate is rejected

- **WHEN** a KPI widget omits `query.aggregate` and `format != 'text'`
- **THEN** the parser throws a `ValidationError` naming the offending widget title

#### Scenario: Unknown widget kind is rejected

- **WHEN** `kind = 'pie_chart'`
- **THEN** the parser throws a `ValidationError`

### Requirement: `DashboardRegistry` exposes registered widgets by capability

The system SHALL ship `DashboardRegistry` with the methods `register(name, dashboard)`, `get(name): Dashboard | undefined`, and `list(): Array<{ name, dashboard }>`. The registry is constructed empty at boot and populated by `loadCapabilityDashboard` for each capability that ships a `dashboard.json`. A capability without `dashboard.json` registers nothing.

#### Scenario: register + get round-trip

- **WHEN** `registry.register('expenses', dashboard)` is called and then `registry.get('expenses')` is read
- **THEN** the returned `Dashboard` is the same object passed in

#### Scenario: Missing dashboard.json registers nothing

- **WHEN** `loadCapabilityDashboard` is invoked for a capability directory without a `dashboard.json`
- **THEN** the helper returns `false`, the registry has no entry for that capability, and no error is thrown

### Requirement: `executeWidgetQuery` validates columns and binds parameters

The system SHALL ship `executeWidgetQuery(deps, capability_name, query): Promise<WidgetResult>` that resolves `capability_name` via `capabilityRegistryRepo.findById`, reads `PRAGMA table_info(primary_table)`, rejects unknown `filter` keys / `order_by` / `select` / `aggregate.column` references, binds `since` / `until` to `occurred_at`, hard-caps `limit` at 100, and returns `{ aggregate: { fn, column, value } }` when `query.aggregate` is set or `{ rows: Row[] }` otherwise.

#### Scenario: Aggregate over seeded rows returns the expected sum

- **WHEN** the expenses table holds rows totalling `12500` and the call is `query = { aggregate: { fn: 'sum', column: 'amount_minor' } }`
- **THEN** the result is `{ aggregate: { fn: 'sum', column: 'amount_minor', value: 12500 } }`

#### Scenario: Unknown filter column throws

- **WHEN** `query.filter` references a column missing from the primary table
- **THEN** the call throws with the unknown column name in the message

### Requirement: `renderDashboard` produces Telegram-ready markdown

The system SHALL ship `renderDashboard(deps, capability_name?): Promise<{ markdown, capability_count, widget_count }>` that:

1. When `capability_name` is set, renders that capability's widgets only; else iterates `dashboardRegistry.list()` alphabetically and joins per-capability blocks with `\n\n---\n\n`.
2. Each block opens with `*<capability_name>*` then renders each widget on its own line(s).
3. KPI widget output is `• <title>: <formatted value>` where the formatter is `format` (default `text`).
4. List widget output is `*<title>*` then 1-indexed bullets of formatted row summaries.
5. Per-widget failures are caught and rendered as `• <title>: ⚠️ <error message>` without aborting the rest.
6. When a capability has no registered widgets the block reads `(no dashboard widgets configured)`.

#### Scenario: KPI sum renders as money

- **WHEN** a KPI widget with `format='money'` resolves to value `35200` for capability `expenses` whose primary_table has `currency='CNY'`
- **THEN** the markdown contains `¥352.00 (CNY)` (or equivalent: the integer divided by 100, two-decimal fixed, currency-symbol-prefixed, currency-code-suffixed)

#### Scenario: Widget failure isolated

- **WHEN** a widget references a non-existent column and the renderer is run with another well-formed widget alongside it
- **THEN** the failing widget renders as `⚠️ ...` and the well-formed widget's value still appears

#### Scenario: Empty registry returns a friendly empty markdown

- **WHEN** `renderDashboard(deps)` is called with no registered capabilities
- **THEN** `widget_count === 0`, `capability_count === 0`, and the markdown is non-empty (e.g. `*No dashboards registered.*`)

