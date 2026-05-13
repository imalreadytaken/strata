# build-skill Specification

## Purpose

`build-skill` is the agent-facing seam for user-driven build requests. When the user says "我想加个体重追踪 / track sleep for me", the triage hook routes the agent to `src/skills/build/SKILL.md`; the skill instructs the agent to identify the requested domain, ask one clarifying question if it's vague, then call the new `strata_propose_capability` tool. The tool inserts one row in the existing `proposals` table (`source='user_request'`, `kind='new_capability'`, `status='pending'`). When Build Bridge ships, it scans pending proposals and picks up the queue. The user's intent is captured the moment they ask — not lost waiting for Build Bridge.

The skill is the smaller half of the build path: it records intent. The orchestrator that actually generates capability code from a pending proposal lives in later changes.

## Requirements
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

