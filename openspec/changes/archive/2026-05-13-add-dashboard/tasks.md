## 1. Schema + types

- [x] 1.1 Create `src/dashboard/types.ts`:
  - `WidgetQuerySchema` (Zod): `filter?` (Record<string, primitive>), `since?`/`until?` (ISO8601), `aggregate?: { fn, column }`, `order_by?`, `order_direction?`, `limit?` (max 100), `select?` (string[]).
  - `WidgetSchema`: `{ kind: 'kpi'|'list', title: string, query: WidgetQuerySchema, format?: 'money'|'count'|'date'|'text' }`. KPI widgets MUST have `aggregate` set unless `format='text'`.
  - `DashboardSchema`: `{ widgets: WidgetSchema[] }`.
  - Export `Widget`, `Dashboard`, `WidgetQuery` types.

## 2. Registry + loader

- [x] 2.1 Create `src/dashboard/registry.ts` with `DashboardRegistry`:
  - `register(name: string, dashboard: Dashboard): void`
  - `get(name: string): Dashboard | undefined`
  - `list(): Array<{ name: string; dashboard: Dashboard }>`
- [x] 2.2 Create `src/dashboard/loader.ts`:
  - `loadCapabilityDashboard({ dir, name, registry, logger }): Promise<boolean>` — checks `<dir>/dashboard.json`; if missing returns false; if present JSON5.parse + Zod-validate + register; throws `ValidationError` on parse/validate failure.

## 3. Widget query engine

- [x] 3.1 Create `src/dashboard/widget_query.ts`:
  - `executeWidgetQuery({ db, capabilityRegistryRepo, logger }, capability_name, query): Promise<{ rows?: any[]; aggregate?: { fn, column, value } }>`.
  - Same column-validation path as `strata_query_table` (PRAGMA + key checks).
  - `since`/`until` bind to `occurred_at`.
  - Limit defaults 5 for list widgets (renderer caller passes), hard cap 100.

## 4. Renderer

- [x] 4.1 Create `src/dashboard/renderer.ts`:
  - `renderDashboard({ db, capabilityRegistryRepo, dashboardRegistry, logger }, capability_name?): Promise<{ markdown: string; capability_count: number; widget_count: number }>`.
  - When `capability_name` set, render only that one; else iterate registry alphabetically and join with `\n\n---\n\n`.
  - For each capability: `*<Capability Title>*\n\n` followed by widget bullets.
  - KPI widget: `• <title>: <formatted value>`.
  - List widget: `*<title>*` followed by 1-indexed bullets; each row formatted as `<merchant or first text column> – <money column if any> – <date column if any>`.
  - Per-widget try/catch: failure renders `• <title>: ⚠️ <error>`.
  - When no widgets registered for a capability: `(no dashboard widgets configured)`.
- [x] 4.2 Create `src/dashboard/index.ts` barrel export.

## 5. Format helpers

- [x] 5.1 In `src/dashboard/renderer.ts`:
  - `formatMoney(value, currency)`: `(value/100).toFixed(2)` with `¥` for CNY, `$` for USD, currency code suffix.
  - `formatCount(value)`: integer with thousands separator.
  - `formatDate(iso)`: first 10 chars of ISO date.
  - `formatText(value)`: stringify.

## 6. Tool

- [x] 6.1 Create `src/tools/render_dashboard.ts`:
  - `renderDashboardSchema` Zod: `{ capability_name?: string }`.
  - `renderDashboardTool(deps: EventToolDeps): AnyAgentTool` reading `deps.dashboardDeps` (new optional field on EventToolDeps).
  - execute: rejects when `dashboardDeps` undefined; calls `renderDashboard`; returns `{ message: '<markdown preview>', details: { markdown, capability_count, widget_count } }`.
- [x] 6.2 Modify `src/tools/types.ts` to add `DashboardToolDeps { db, capabilityRegistryRepo, dashboardRegistry, logger }` and `dashboardDeps?: DashboardToolDeps` on `EventToolDeps`.

## 7. Wiring

- [x] 7.1 Modify `src/tools/index.ts`:
  - `buildEventTools` returns 10 tools (adds `renderDashboardTool`).
  - `registerEventTools` populates `dashboardDeps` when `runtime.dashboardRegistry` present.
- [x] 7.2 Modify `src/tools/index.test.ts`: tool count 9 → 10; expected sorted list adds `strata_render_dashboard`.

## 8. Runtime + plugin entry

- [x] 8.1 Modify `src/runtime.ts`: add `dashboardRegistry: DashboardRegistry`.
- [x] 8.2 Modify `src/index.ts`: construct `dashboardRegistry`, thread into `loadCapabilities` deps (so loader calls `loadCapabilityDashboard`), attach to runtime.
- [x] 8.3 Modify `src/capabilities/loader.ts` to call `loadCapabilityDashboard` per discovered capability (when registry is in deps); add `dashboardRegistry?` to `LoadCapabilitiesDeps`.

## 9. Triage hook

- [x] 9.1 Modify `src/triage/hook.ts`:
  - `STRATA_TOOLS` static list adds `strata_render_dashboard`.
  - `query` template gains a line: "If the user asks for an overview / dashboard / 'show me my X dashboard', call strata_render_dashboard({ capability_name: 'X' }) and quote the markdown back verbatim."
- [x] 9.2 Modify `src/triage/hook.test.ts`:
  - Add `strata_render_dashboard` to the name-list assertion.
  - Query template assertion now checks for `strata_render_dashboard`.

## 10. Example dashboard

- [x] 10.1 Create `src/capabilities/expenses/v1/dashboard.json` with 3 widgets:
  - `{ kind: 'kpi', title: '本月支出', format: 'money', query: { aggregate: { fn: 'sum', column: 'amount_minor' }, since: '<this-month-start>' } }` (since computed at render time via `{{this_month_start}}` token? — keep simple: a since string for tests; example uses absolute date with comment that capability authors typically wire this through a dynamic helper. For V1 prefer absolute date and let the agent re-render.)
  - `{ kind: 'kpi', title: '本月笔数', format: 'count', query: { aggregate: { fn: 'count', column: 'id' }, since: '<this-month-start>' } }`.
  - `{ kind: 'list', title: 'Top 5', format: 'text', query: { order_by: 'amount_minor', order_direction: 'desc', limit: 5 } }`.

## 11. Tests

- [x] 11.1 `src/dashboard/types.test.ts`: schema accepts well-formed widget; rejects unknown `kind`; rejects KPI without aggregate; rejects limit > 100.
- [x] 11.2 `src/dashboard/loader.test.ts`: missing dashboard.json returns false (no throw); valid dashboard.json registers widgets; invalid JSON throws ValidationError; schema-invalid throws.
- [x] 11.3 `src/dashboard/widget_query.test.ts`: aggregate sum over seeded rows returns expected number; rows query honours limit; unknown filter column throws.
- [x] 11.4 `src/dashboard/renderer.test.ts`: single-capability render produces title + bullets; missing capability returns `(no widgets configured)`; failing widget renders ⚠️ inline without taking down siblings; format=money produces `¥<n>.<dd>` with currency suffix from row data.
- [x] 11.5 `src/tools/render_dashboard.test.ts`: tool returns markdown via deps; rejects when dashboardDeps undefined; passes capability_name through.

## 12. Integration

- [x] 12.1 `npm run typecheck` clean.
- [x] 12.2 `npm test` all pass.
- [x] 12.3 `openspec validate add-dashboard --strict`.
