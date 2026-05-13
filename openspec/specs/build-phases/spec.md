# build-phases Specification

## Purpose

`build-phases` is the prompt-template + output-collection layer between the runner and the orchestrator. `runPlanPhase` renders the plan prompt with the user's proposal, invokes the runner in `mode='explore'`, and reads back `<workdir>/PLAN.md`. `runDecomposePhase` renders the §7.4 decompose prompt, invokes the runner in `mode='propose'`, and lists OpenSpec change directories produced under `<workdir>/openspec/changes/` (excluding `archive`). Both phases capture Claude Code's `session_id` from the first `system` event so the orchestrator can resume; both pass through the runner's `stderr` so the orchestrator can log on failure. The phases never throw on missing artefacts — they return empty strings / empty lists, and the orchestrator decides whether that's a phase failure.

## Requirements
### Requirement: `runPlanPhase` invokes the runner and reads the produced PLAN.md

The system SHALL export `runPlanPhase(opts: RunPlanPhaseOptions): Promise<PlanPhaseResult>` that:

1. Renders the plan prompt via `renderPlanPrompt({ title, summary, rationale, capabilitiesList })`.
2. Calls `runClaudeCode({ mode: 'explore', prompt, workdir, … })`.
3. After the runner resolves, reads `<workdir>/PLAN.md` (UTF-8). Missing → empty string.
4. Returns `{ planMd, sessionId, exitCode, eventCount, stderr }`.

The handler installed by `runPlanPhase` captures `session_id` from the first `system` event it sees so the orchestrator can resume the session in a future change.

#### Scenario: Empty workdir produces empty planMd

- **WHEN** a fake spawner emits one `system` event and exits with code 0 without writing PLAN.md
- **THEN** the result is `{ planMd: '', sessionId: <captured>, exitCode: 0, eventCount: 1, stderr: '' }`

#### Scenario: Pre-existing PLAN.md is returned verbatim

- **WHEN** `<workdir>/PLAN.md` already contains `# Plan\n…` and the fake spawner exits 0
- **THEN** `result.planMd === '# Plan\n…'`

### Requirement: `runDecomposePhase` lists OpenSpec changes produced in the workdir

The system SHALL export `runDecomposePhase(opts: RunDecomposePhaseOptions): Promise<DecomposePhaseResult>` that:

1. Renders the decompose prompt via `renderDecomposePrompt(opts)`.
2. Calls `runClaudeCode({ mode: 'propose', prompt, workdir, … })`.
3. After resolution, lists immediate subdirectories of `<workdir>/openspec/changes/` (returning `[]` when the directory doesn't exist), excluding any directory named `archive`.
4. Returns `{ changeIds, sessionId, exitCode, eventCount, stderr }`.

#### Scenario: Missing openspec/changes/ → empty change list

- **WHEN** the workdir does not contain `openspec/changes/`
- **THEN** the result's `changeIds === []`

#### Scenario: Existing changes (excluding archive) are returned

- **WHEN** the workdir contains `openspec/changes/{add-foo, add-bar, archive}/`
- **THEN** `result.changeIds` equals `['add-bar', 'add-foo']` (sorted) and does NOT contain `'archive'`

### Requirement: Prompt renderers produce substituted text

The system SHALL export `renderPlanPrompt(opts)` and `renderDecomposePrompt(opts)`.

- `renderPlanPrompt` substitutes `{{title}}`, `{{summary}}`, `{{rationale}}`, and `{{capabilitiesList}}`. An empty `capabilitiesList` yields the literal `(none yet)` in the prompt body.
- `renderDecomposePrompt` carries the `STRATA_SPEC.md` §7.4 text and substitutes `{{extraInstructions}}` (defaults to empty string).

#### Scenario: renderPlanPrompt fills the title and summary

- **WHEN** `renderPlanPrompt({ title: 'Track weight', summary: 'x', rationale: 'y', capabilitiesList: ['expenses'] })`
- **THEN** the result contains `'Track weight'`, `'x'`, `'y'`, and `'expenses'`

#### Scenario: renderPlanPrompt handles empty capabilities

- **WHEN** `capabilitiesList = []`
- **THEN** the result contains `'(none yet)'`

#### Scenario: renderDecomposePrompt carries the §7.4 text

- **WHEN** `renderDecomposePrompt({})` is called
- **THEN** the result contains `'PLAN.md'` and `'atomic OpenSpec changes'`

