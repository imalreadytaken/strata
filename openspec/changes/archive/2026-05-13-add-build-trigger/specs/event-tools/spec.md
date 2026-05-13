## MODIFIED Requirements

### Requirement: All six tools are registered through `api.registerTool` at plugin boot

The system SHALL expose `registerEventTools(api: OpenClawPluginApi, runtime: StrataRuntime): void` that calls `api.registerTool(factory)` once. The factory closes over `ctx.sessionId` (defaulting to `'default'` with a `warn` log when missing) and the runtime's `rawEventsRepo`, `proposalsRepo`, `capabilityHealthRepo`, `pendingBuffer`, `logger`, plus `pipelineDeps` and `buildDeps` bundles. The factory returns EIGHT tools:

- `strata_create_pending_event`
- `strata_update_pending_event`
- `strata_commit_event`
- `strata_supersede_event`
- `strata_abandon_event`
- `strata_search_events`
- `strata_propose_capability`
- `strata_run_build`

The plugin's `register(api)` invokes `registerEventTools` after `startPendingTimeoutLoop`.

#### Scenario: Plugin entry registers all eight tools

- **WHEN** the plugin's `register(api)` runs with a stub `api` that records `registerTool` calls
- **THEN** `registerTool` has been called exactly once with a factory whose returned tools have the eight names above
