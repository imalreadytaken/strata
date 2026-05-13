## MODIFIED Requirements

### Requirement: `renderRoutingContext` produces a system + per-turn block for each triage kind

The system SHALL export `renderRoutingContext(triage, input): { prependSystemContext: string; prependContext: string }`.

- `prependSystemContext` is the **static** Strata-routing block: lists active capabilities, names all 7 `strata_*` tools (the six event tools plus `strata_propose_capability`), and describes the `pending → committed | superseded | abandoned` state machine.
- `prependContext` is the **per-turn** block: one of five templates keyed by `triage.kind`. The `chitchat` kind returns an empty string.

Each non-chitchat template MUST mention the recommended tool names by their `strata_*` identifiers so the agent can call them without consulting the skill file. The `build_request` template MUST point at the build skill and instruct the agent to call `strata_propose_capability` — it MUST NOT tell the agent that Build Bridge is unavailable.

#### Scenario: Capture template names the right tools

- **WHEN** `triage = { kind: 'capture', confidence: 0.8, reasoning: 'x' }`
- **THEN** `prependContext` contains `'strata_create_pending_event'`, `'strata_commit_event'`, and `'strata_abandon_event'`

#### Scenario: Correction template references search + supersede

- **WHEN** `triage.kind = 'correction'`
- **THEN** `prependContext` contains `'strata_search_events'` and `'strata_supersede_event'`

#### Scenario: Query template references search

- **WHEN** `triage.kind = 'query'`
- **THEN** `prependContext` contains `'strata_search_events'`

#### Scenario: Build request template routes to `strata_propose_capability`

- **WHEN** `triage.kind = 'build_request'`
- **THEN** `prependContext` contains `'strata_propose_capability'` and references the build skill; it MUST NOT claim that Build Bridge is unavailable

#### Scenario: Chitchat returns empty prependContext

- **WHEN** `triage.kind = 'chitchat'`
- **THEN** `prependContext === ''` and `prependSystemContext` remains non-empty (the static Strata block)
