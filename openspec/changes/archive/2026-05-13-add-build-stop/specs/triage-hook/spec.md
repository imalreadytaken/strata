## MODIFIED Requirements

### Requirement: `renderRoutingContext` produces a system + per-turn block for each triage kind

The system SHALL export `renderRoutingContext(triage, input): { prependSystemContext: string; prependContext: string }`.

- `prependSystemContext` is the **static** Strata-routing block: lists active capabilities, names all 11 `strata_*` tools (the six event tools plus `strata_propose_capability`, `strata_run_build`, `strata_query_table`, `strata_render_dashboard`, and `strata_stop_build`), and describes the `pending → committed | superseded | abandoned` state machine.
- `prependContext` is the **per-turn** block: one of five templates keyed by `triage.kind`. The `chitchat` kind returns an empty string.

Each non-chitchat template MUST mention the recommended tool names by their `strata_*` identifiers so the agent can call them without consulting the skill file. The `build_request` template MUST point at the build skill, instruct the agent to call `strata_propose_capability`, AND tell the agent that an in-flight build can be aborted via `strata_stop_build({ build_id })`. The `query` template MUST mention `strata_query_table` (business-table aggregates / filters / top-N), `strata_search_events` (raw-event ledger lookup), AND `strata_render_dashboard`.

#### Scenario: Capture template names the right tools

- **WHEN** `triage = { kind: 'capture', confidence: 0.8, reasoning: 'x' }`
- **THEN** `prependContext` contains `'strata_create_pending_event'`, `'strata_commit_event'`, and `'strata_abandon_event'`

#### Scenario: Correction template references search + supersede

- **WHEN** `triage.kind = 'correction'`
- **THEN** `prependContext` contains `'strata_search_events'` and `'strata_supersede_event'`

#### Scenario: Query template references query, search, and dashboard tools

- **WHEN** `triage.kind = 'query'`
- **THEN** `prependContext` contains `'strata_query_table'`, `'strata_search_events'`, AND `'strata_render_dashboard'`

#### Scenario: Build request template references propose + stop_build

- **WHEN** `triage.kind = 'build_request'`
- **THEN** `prependContext` contains `'strata_propose_capability'` AND `'strata_stop_build'`; it MUST NOT claim that Build Bridge is unavailable

#### Scenario: Chitchat returns empty prependContext

- **WHEN** `triage.kind = 'chitchat'`
- **THEN** `prependContext === ''` and `prependSystemContext` remains non-empty (the static Strata block)
