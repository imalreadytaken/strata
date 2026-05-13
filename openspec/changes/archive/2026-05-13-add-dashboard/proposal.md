## Why

A capability can already record + query its data; the missing surface is **rendering** — turning the data into something a Telegram chat can show as a "KPI card" (text/markdown only; Telegram bots have no inline image surface for us yet). `STRATA_SPEC.md` §3 lists `dashboard.json` as the per-capability widget config, and the Week 6 deliverable list explicitly calls for "Dashboard 基础(在 Telegram 渲染 KPI 卡片)". This change adds that minimal subsystem.

Concretely: a `dashboard.json` next to `meta.json` declares an ordered list of **KPI widgets** (`kind: 'kpi'`) that resolve to a single number, and **list widgets** (`kind: 'list'`) that resolve to up to N rows. Each widget's data comes from the same parametrised path `add-query-skill` already validated — capability registry → `PRAGMA table_info` → `?`-bound SELECT — so the agent and the dashboard share one safe query engine.

The renderer produces plain Telegram markdown: a `*Title*` line, each KPI as a `• <label>: <value>` bullet, lists as ordered bullets. No HTML, no chart images, no JS.

Exposed to the agent as `strata_render_dashboard({ capability_name? })` so the `query` skill can say "show me my expenses dashboard" → call → quote the markdown back.

References: `STRATA_SPEC.md` §3 (`dashboard.json` location), §5 capability layout, `add-query-skill` (column-validation pattern), `AGENTS.md` (the column contract this depends on).

## What Changes

- New `dashboard` capability covering:
  - **`dashboard.json` schema** (Zod, JSON5 on disk): `{ widgets: Widget[] }` where each widget is `{ kind: 'kpi'|'list', title: string, query: WidgetQuery, format?: 'money'|'count'|'date'|'text' }`. `WidgetQuery` is a strict subset of the `strata_query_table` parameter set: `{ filter?, since?, until?, aggregate?: { fn, column }, order_by?, order_direction?, limit? }`. Loaded at boot per capability.
  - **In-memory `DashboardRegistry`** (Map<capability, Widget[]>) populated by `loadDashboards(registry, capabilities)`.
  - **`renderDashboard(deps, capability_name?)` renderer**: walks the registry (one capability or all), executes each widget's query via the shared `executeWidgetQuery` helper (the same column-validation + `?`-binding path used by `strata_query_table`), and formats the result as Telegram-friendly markdown.
  - **`strata_render_dashboard` agent tool**: `{ capability_name?: string }` → `{ markdown: string, capability_count: number, widget_count: number }`. When `capability_name` is omitted it renders every registered capability's dashboard, concatenated by `---`.
- Modify `capability-loader`: if `dashboard.json` exists next to `meta.json`, parse via JSON5, validate with Zod, register into `DashboardRegistry`. Missing file is fine. Validation failure throws (matches `meta.json` posture).
- Modify `event-tools`: 9 → 10 tools.
- Modify `triage-hook`: STRATA_TOOLS adds `strata_render_dashboard`; `query` template gains a line "If the user asks 'show me my X dashboard' use `strata_render_dashboard({ capability_name: 'X' })`".
- Modify `expenses-capability`: ship `dashboard.json` with three widgets — total spend this month (KPI/sum), count of expenses this month (KPI/count), top-5 most-expensive expenses (list).

## Capabilities

### New Capabilities
- `dashboard`: dashboard.json schema, in-memory registry, renderer, `strata_render_dashboard` tool.

### Modified Capabilities
- `capability-loader`: parses + registers `dashboard.json` if present.
- `event-tools`: 9 → 10 tools (adds `strata_render_dashboard`).
- `triage-hook`: surfaces the new tool to the agent.
- `expenses-capability`: ships an example `dashboard.json`.

## Impact

- **Files added**:
  - `src/dashboard/types.ts` — Zod schema + types for `dashboard.json`.
  - `src/dashboard/registry.ts` — `DashboardRegistry` class (Map wrapper with logging).
  - `src/dashboard/loader.ts` — `loadDashboards` + `loadCapabilityDashboard` reading dashboard.json.
  - `src/dashboard/widget_query.ts` — `executeWidgetQuery(deps, capability_name, query)` shared engine.
  - `src/dashboard/renderer.ts` — `renderDashboard` returning a string.
  - `src/dashboard/index.ts` — barrel.
  - `src/dashboard/*.test.ts` — types/loader/widget_query/renderer tests.
  - `src/tools/render_dashboard.ts` — `renderDashboardTool` wrapping the renderer.
  - `src/tools/render_dashboard.test.ts`.
  - `src/capabilities/expenses/v1/dashboard.json` — three example widgets.
- **Files modified**:
  - `src/capabilities/loader.ts` — calls `loadCapabilityDashboard` per discovered capability.
  - `src/capabilities/loader.test.ts` (if exists) — covers dashboard.json round-trip.
  - `src/runtime.ts` — adds `dashboardRegistry: DashboardRegistry` to `StrataRuntime`.
  - `src/index.ts` — constructs the registry, threads it into loader and tools wiring.
  - `src/tools/types.ts` — `RenderDashboardDeps` + threads into `EventToolDeps`.
  - `src/tools/index.ts` + `src/tools/index.test.ts` — register 10th tool, update assertion.
  - `src/triage/hook.ts` + `src/triage/hook.test.ts` — name the new tool + query template line.
- **Non-goals**:
  - No chart images / SVG. Plain markdown only.
  - No widget refresh / cache layer. Each render runs the queries fresh.
  - No cross-capability JOINs. Each widget is scoped to its declaring capability.
  - No dashboard schema migrations — `dashboard.json` is loaded fresh at every boot, capabilities ship their own version.
