## 1. Types

- [x] 1.1 Create `src/build/validator.ts` exporting:
  - `ValidationFinding = { severity: 'error' | 'warn'; check: string; message: string; file?: string; line?: number }`.
  - `ValidationReport = { ok: boolean; findings: ValidationFinding[]; perCheck: Record<string, ValidationFinding[]> }`.
  - `ValidationContext = { workdir: string; changeId: string; capabilityName?: string; gitInitialCommit: string }`.
  - `ValidationCheck = { name: string; description: string; run(ctx: ValidationContext): Promise<ValidationFinding[]> }`.

## 2. Helper utilities

- [x] 2.1 `getModifiedFiles(workdir, sinceCommit)` — runs `git diff --name-only <sha>`, returns string[].
- [x] 2.2 `readMigrationFiles(workdir, capabilityName)` — globs `capabilities/<name>/v<N>/migrations/*.sql`, returns `[{ filename, sql }]`.
- [x] 2.3 `parseCreateTables(sql)` — tokenizer producing `{ tableName, columns: [{ name, type, ...modifiers }] }[]`.

## 3. Standard checks

Implement 9 active checks + 2 placeholders. Each is its own exported `Check_<name>` object so tests can target individually.

- [x] 3.1 `change_scope` — modified files must live under `openspec/changes/<changeId>/` or `capabilities/<capabilityName>/v<N>/`. Out-of-scope file → finding.
- [x] 3.2 `required_fields_in_business_tables` — every new `CREATE TABLE` whose name matches the capability's `primary_table` (or any table that has `raw_event_id`) must have all 7 mandatory columns. Missing column → finding per column.
- [x] 3.3 `no_float_for_money` — for every column whose name ends in `_minor` OR contains `amount`/`price`/`balance`/`fee`/`cost`, type must be `INTEGER`. Wrong type → finding.
- [x] 3.4 `iso_8601_timestamps` — columns ending in `_at` must be `TEXT`. Wrong type → finding.
- [x] 3.5 `no_api_keys` — search modified files for the patterns in design D5. Match → finding (with file + line).
- [x] 3.6 `migration_applies_clean` — open `:memory:` SQLite, apply system migrations from this codebase, then capability migrations. SQL error → finding.
- [x] 3.7 `meta_json_valid` — `CapabilityMetaSchema.safeParse(JSON5.parse(meta.json))`. Failure → finding with the Zod error message.
- [x] 3.8 `extract_prompt_present` — file exists, ≥ 100 chars, contains no hardcoded model strings. Empty / missing / model-string match → finding.
- [x] 3.9 `pipeline_module_exports_ingest` — dynamic `import()` the pipeline file; assert `typeof ingest === 'function'`. Failure → finding.
- [x] 3.10 `pipeline_handles_sample` (placeholder) and `tests_pass` (placeholder) — return `[]`, description states placeholder.

## 4. Runner

- [x] 4.1 Export `STANDARD_VALIDATION_CHECKS: ValidationCheck[]`.
- [x] 4.2 Export `runValidationChecks(ctx, checks?: ValidationCheck[]): Promise<ValidationReport>`:
  - Defaults to `STANDARD_VALIDATION_CHECKS`.
  - Runs all checks via `Promise.all`, collects findings, computes `ok` = no `'error'` findings, builds `perCheck` map.

## 5. Tests

- [x] 5.1 `src/build/validator.test.ts` (≥ 11 cases):
  - One positive + one negative per active check (×9 = 18). Negative cases use synthetic broken fixtures (e.g., business table missing `raw_event_id`, money column as `REAL`, file outside scope).
  - `runValidationChecks` aggregator: report is `ok=false` when any check returns an error; `ok=true` when all checks pass.
  - Per-check `findings` map carries the right keys.

## 6. Barrel

- [x] 6.1 `src/build/index.ts`: re-export `runValidationChecks`, `STANDARD_VALIDATION_CHECKS`, types.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-build-validator --strict`.
