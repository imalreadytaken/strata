## ADDED Requirements

### Requirement: `strata_propose_capability` tool records build requests as `proposals` rows

The system SHALL register `strata_propose_capability` alongside the six `strata_*` event tools. Parameters:

- `title: string` (non-empty) — short label, e.g. `'Track weight'`.
- `summary: string` (non-empty) — one-sentence description of what the user wants.
- `rationale: string` (non-empty) — why the user wants it (drawn from their message).
- `target_capability?: string` — optional pre-existing capability the user is asking about (e.g. extending `expenses`); for `kind='new_capability'` this stays null.
- `estimated_time_minutes?: number` (positive integer) — agent's guess at build cost.

On invocation the tool SHALL insert one row in `proposals` with `source='user_request'`, `kind='new_capability'`, `status='pending'`, `created_at=now()`, and the supplied fields. Returns `{ proposal_id, status: 'pending' }`.

#### Scenario: Minimal happy path

- **WHEN** the tool is called with `title='Track weight'`, `summary='...'`, `rationale='...'`
- **THEN** one row exists in `proposals` with the matching fields, `source='user_request'`, `kind='new_capability'`, `status='pending'`, and the returned `proposal_id` matches the row id

#### Scenario: `target_capability` and `estimated_time_minutes` land on the row when supplied

- **WHEN** the tool is called with both optional fields set
- **THEN** the row's `target_capability` and `estimated_time_minutes` match the inputs

#### Scenario: Empty `title` is rejected

- **WHEN** `title=''`
- **THEN** the call rejects with a ZodError and no row is inserted

#### Scenario: Empty `summary` is rejected

- **WHEN** `summary=''`
- **THEN** the call rejects with a ZodError and no row is inserted

#### Scenario: Empty `rationale` is rejected

- **WHEN** `rationale=''`
- **THEN** the call rejects with a ZodError and no row is inserted

### Requirement: `src/skills/build/SKILL.md` instructs the agent on the build-request flow

The system SHALL ship `src/skills/build/SKILL.md` containing YAML-ish frontmatter (`name: build`) and a body that:

- Names `strata_propose_capability` explicitly.
- References the `proposals` table by name.
- Tells the agent to ask one clarifying question if the requested domain is too vague.
- Forbids the agent from running a build or modifying `capabilities/`.

#### Scenario: Loader returns the build skill

- **WHEN** `loadBuildSkill()` is called
- **THEN** the returned `frontmatter.name === 'build'`, `body.length > 0`, and the body contains both `'strata_propose_capability'` and `'proposals'`
