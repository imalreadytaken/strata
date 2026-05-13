## ADDED Requirements

### Requirement: `runValidationChecks` aggregates per-check findings into a `ValidationReport`

The system SHALL export `runValidationChecks(ctx: ValidationContext, checks?: ValidationCheck[]): Promise<ValidationReport>` that runs every supplied check in parallel and produces `{ ok, findings, perCheck }`. `ok` MUST be `true` iff zero findings have `severity: 'error'`. `perCheck` maps each check's `name` to its findings (possibly `[]`).

#### Scenario: All checks pass

- **WHEN** every check returns `[]`
- **THEN** `report.ok === true`, `report.findings === []`, and every check appears in `report.perCheck` with value `[]`

#### Scenario: A single error finding flips `ok` to false

- **WHEN** one check returns `[{ severity: 'error', message: '...', check: 'x' }]` and all others return `[]`
- **THEN** `report.ok === false` and `report.findings.length === 1`

#### Scenario: Warn-only findings keep `ok` true

- **WHEN** every finding has `severity: 'warn'`
- **THEN** `report.ok === true`

### Requirement: `STANDARD_VALIDATION_CHECKS` enforces the AGENTS.md business-table contract

The system SHALL ship `STANDARD_VALIDATION_CHECKS` containing nine active checks plus two named placeholders:

1. `change_scope` — all files modified since `gitInitialCommit` lie inside `openspec/changes/<changeId>/` or `capabilities/<capabilityName>/v<N>/`.
2. `required_fields_in_business_tables` — every business table contains `id`, `raw_event_id`, `extraction_version`, `extraction_confidence`, `occurred_at`, `created_at`, `updated_at`.
3. `no_float_for_money` — columns whose names end in `_minor` or include `amount`/`price`/`balance`/`fee`/`cost` use `INTEGER`.
4. `iso_8601_timestamps` — columns whose names end in `_at` use `TEXT`.
5. `no_api_keys` — modified files contain no hardcoded API keys (`sk-…`, `ANTHROPIC_API_KEY=…`, `OPENAI_API_KEY=…`, `AIza…` Google keys).
6. `migration_applies_clean` — system + capability migrations apply to a fresh `:memory:` DB.
7. `meta_json_valid` — `CapabilityMetaSchema.parse(meta.json)` succeeds.
8. `extract_prompt_present` — `extract_prompt.md` exists, ≥ 100 chars, mentions no hardcoded model identifiers.
9. `pipeline_module_exports_ingest` — `pipeline.ts` dynamic-imports and exports an `ingest` function.
10. `pipeline_handles_sample` — placeholder (always `[]`), unblocked when LLM backend lands.
11. `tests_pass` — placeholder (always `[]`), unblocked when workdir test-runner lands.

#### Scenario: Business table missing `raw_event_id` produces a finding

- **WHEN** a `CREATE TABLE` in the workdir's migrations omits `raw_event_id`
- **THEN** `required_fields_in_business_tables` returns at least one error finding mentioning the missing column

#### Scenario: Money column as `REAL` produces a finding

- **WHEN** a migration has `amount_minor REAL`
- **THEN** `no_float_for_money` returns an error finding mentioning the column name

#### Scenario: Hardcoded `sk-…` API key in a modified file produces a finding

- **WHEN** a file modified since the initial commit contains `sk-abcdef0123456789abcdef0123456789`
- **THEN** `no_api_keys` returns an error finding with `file` set

#### Scenario: Invalid `meta.json` produces a finding

- **WHEN** `meta.json` is missing `primary_table`
- **THEN** `meta_json_valid` returns an error finding with the schema error message

#### Scenario: `extract_prompt.md` mentioning `claude-3-5-sonnet` produces a finding

- **WHEN** the prompt body contains `claude-3-5-sonnet-20241022`
- **THEN** `extract_prompt_present` returns an error finding

#### Scenario: Placeholder checks return empty findings without error

- **WHEN** `pipeline_handles_sample` or `tests_pass` runs against any workdir
- **THEN** the result is `[]` and the check's description identifies it as a placeholder
