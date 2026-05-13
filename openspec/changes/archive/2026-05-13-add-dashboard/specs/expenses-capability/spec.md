## ADDED Requirements

### Requirement: `expenses` ships an example `dashboard.json` exercising both KPI and list widgets

The system SHALL ship `src/capabilities/expenses/v1/dashboard.json` declaring at least three widgets:

1. A KPI widget titled with a Chinese label (e.g. `本月支出`) with `format='money'` and `query.aggregate.fn='sum'` over `amount_minor`.
2. A KPI widget titled `本月笔数` with `format='count'` and `query.aggregate.fn='count'`.
3. A list widget (`kind='list'`) capped at 5 rows ordered by `amount_minor desc`.

The file MUST validate against `DashboardSchema` and register under capability `'expenses'` after `bootRuntime`.

#### Scenario: Booting registers expenses widgets

- **WHEN** `bootRuntime(api)` runs against a fresh DB
- **THEN** `runtime.dashboardRegistry.get('expenses')` returns a `Dashboard` whose `widgets.length >= 3`

#### Scenario: Rendering the expenses dashboard produces non-empty markdown

- **WHEN** `renderDashboard(deps, 'expenses')` runs with the registry populated by `bootRuntime`
- **THEN** the returned `markdown` contains `*expenses*` (or an equivalent header) and at least one widget bullet
