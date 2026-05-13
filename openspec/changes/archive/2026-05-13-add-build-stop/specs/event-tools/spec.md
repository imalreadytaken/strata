## MODIFIED Requirements

### Requirement: All six tools are registered through `api.registerTool` at plugin boot

The system SHALL expose `registerEventTools(api, runtime): void` that calls `api.registerTool(factory)` once. The factory closes over `ctx.sessionId` (defaulting to `'default'`) and the runtime's repos, pending buffer, logger, plus `pipelineDeps`, `buildDeps`, `queryDeps`, and `dashboardDeps` bundles. The factory returns ELEVEN tools:

- `strata_create_pending_event`
- `strata_update_pending_event`
- `strata_commit_event`
- `strata_supersede_event`
- `strata_abandon_event`
- `strata_search_events`
- `strata_propose_capability`
- `strata_run_build`
- `strata_query_table`
- `strata_render_dashboard`
- `strata_stop_build`

The plugin's `register(api)` invokes `registerEventTools` after `startPendingTimeoutLoop`.

#### Scenario: Plugin entry registers all eleven tools

- **WHEN** the plugin's `register(api)` runs with a stub `api` that records `registerTool` calls
- **THEN** `registerTool` is called exactly once with a factory whose returned tools have the eleven names above
