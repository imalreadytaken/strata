## Decisions

### D1: Dashboard query language is a strict subset of `strata_query_table`, not its own DSL

`add-query-skill` already invented a safe column-validating SELECT builder. Reinventing one for dashboards would double the surface to maintain (and audit for SQL injection). Instead `dashboard.json` widgets share the **parameter shape** of `strata_query_table` — same `filter`, `since`, `until`, `aggregate`, `order_by`, `order_direction`, `limit` — and the renderer routes through one helper, `executeWidgetQuery(deps, capability_name, query): WidgetResult`, that internally does the same `capabilityRegistryRepo.findById` → `PRAGMA table_info` → bound SELECT.

The agent-facing `strata_query_table` tool wraps the same helper but accepts a `select` array; the dashboard helper does not (KPIs are single values; lists either project the full row or a `select` subset configured in the widget). This keeps both paths column-safe.

### D2: Render to Telegram markdown text, no images

`STRATA_SPEC.md` Week 6 explicitly says "Dashboard 基础(在 Telegram 渲染 KPI 卡片)" and the plugin's `mcp__plugin_telegram_telegram__reply` sends text; image generation requires either canvas/svg → png (heavy build cost) or chart-image-service (network dependency). For V1 we use plain markdown:

```
*Expenses Dashboard*

• 本月支出: ¥352.00 (CNY)
• 本月笔数: 9
*Top 5 expenses*
1. Apple - ¥120.00 - 2026-05-09
2. Sweetgreen - ¥55.00 - 2026-05-05
…
```

The agent quotes this verbatim into its reply. The `*…*` markdown formats as bold in Telegram markdown.

### D3: `format` is a small enum, no full templating

We support four formatters: `money` (group `amount_minor` with `currency`, divide by 100, prefix), `count`, `date` (yyyy-mm-dd), `text`. Currency lookup is simplistic — if the widget's primary table has a `currency` column AND the formatter is `money`, the renderer reads the currency from the first matching row (or `CNY` if no rows / no column). A richer multi-currency story is a later concern; this is what V1 needs to read sensibly.

### D4: `dashboard.json` is loaded at boot, not on every request

Each renderer call hits an in-memory `DashboardRegistry`. The registry is built once during `loadCapabilities`. A capability without a dashboard.json simply registers nothing; the registry returns an empty list and the renderer outputs `(no widgets configured)`. Reload behaviour matches `meta.json`'s: changes apply at the next boot — there is no hot-reload yet.

### D5: `renderDashboard` runs each widget independently; widget failure is local

If one widget's query throws (e.g. table doesn't exist, column gone away after a schema rollback), the renderer catches the error, renders the widget as `• <title>: ⚠️ <error message>`, and keeps going with the rest. This is the same posture `runReextractJob` already takes for per-row failures and matches user expectation that dashboards are best-effort displays.

### D6: Tool returns a single string field, not structured payload

`strata_render_dashboard.execute → details = { markdown, capability_count, widget_count }`. The agent reads `details.markdown` and quotes. Counts let the agent say "rendered 3 widgets across 1 capability" if it wants. We deliberately don't shape the output into structured widget data — the moment the LLM tries to re-render, it loses Telegram's exact text rendering.

### D7: Widget JSON5, not strict JSON

`meta.json` is already JSON5 via the capability loader (`add-capability-loader` D2). `dashboard.json` follows suit: trailing commas, comments, single quotes. Capability authors write these by hand; JSON5 keeps the file readable.

### D8: No `strata_render_dashboard` access from inside a capture flow

The triage hook surfaces the tool only in the `query` template (and the static name list). The `capture` template doesn't even mention it. If the LLM still picks it inside a capture flow, the tool succeeds (it's read-only by construction), but the capture skill markdown explicitly forbids reading-tools during commit — matching the existing `query`-vs-`capture` separation.
