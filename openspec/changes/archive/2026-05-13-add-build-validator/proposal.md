## Why

After Claude Code finishes an `/opsx:apply` inside the build workdir, somebody needs to check that the produced capability obeys the constitution: business-table required fields, INTEGER money, ISO 8601 timestamps, no hardcoded API keys, applicable migrations, valid `meta.json`, present `extract_prompt.md`, and so on. `STRATA_SPEC.md` §8 lists 10 checks. Without an automated validator, every build either ships broken code or relies on the orchestrator's narrative trust ("the LLM seemed to follow the rules").

`validator` runs against the workdir + the specific change being applied, returns a structured `ValidationReport` with per-check findings, and lets the orchestrator gate the apply phase on `ok: true`.

References: `STRATA_SPEC.md` §8 (the 10 checks), `openspec/AGENTS.md` (hard constraints #2 / #3 / #4 / migrations immutability), `add-build-workspace` (provides the workdir + `gitInitialCommit` to diff against).

## What Changes

- Add `build-validator` capability covering:
  - **`ValidationCheck`** type: `{ name, description, run(ctx): Promise<ValidationFinding[]> }`.
  - **`ValidationFinding`** type: `{ severity: 'error' | 'warn'; message: string; file?: string; line?: number }`.
  - **`ValidationReport`** = `{ ok: boolean; findings: ValidationFinding[]; perCheck: Record<string, ValidationFinding[]> }`. `ok` is `true` iff zero `'error'` findings across all checks.
  - **`runValidationChecks(ctx, checks?): Promise<ValidationReport>`** — runs every check in parallel; aggregates findings. Caller can override `checks` for testing.
  - **`STANDARD_VALIDATION_CHECKS`**: an array of the 10 default checks. Today we ship the **9 that are workdir-local**:
    - `change_scope` — files modified since the workspace's `gitInitialCommit` all live inside `<change>/specs/`, `<change>/proposal.md`, or `capabilities/<name>/v<N>/`.
    - `required_fields_in_business_tables` — parse every new `CREATE TABLE` in `migrations/*.sql`, ensure the 7 mandatory columns from AGENTS.md are present.
    - `no_float_for_money` — any column whose name matches `_minor` or includes `amount`/`price`/`balance` is `INTEGER`; refuse `REAL`/`FLOAT` for those.
    - `iso_8601_timestamps` — any column whose name ends `_at` is `TEXT`.
    - `no_api_keys` — grep modified files for `sk-…`, `API_KEY=...`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
    - `migration_applies_clean` — open a fresh tmp DB, apply the system migrations + the capability migrations, ensure no error.
    - `meta_json_valid` — `CapabilityMetaSchema.parse(meta.json)` from `capability-loader`.
    - `extract_prompt_present` — the file exists, ≥ 100 chars, contains no hardcoded model identifiers (`gpt-`, `claude-`, `gemini-`, `o1-`, `grok-`).
    - `pipeline_module_exports_ingest` — dynamically `import()` the pipeline; assert `typeof mod.ingest === 'function'`.
  - **Skipped for V1**: `pipeline_handles_sample` (needs a sample extraction harness — depends on the model abstraction) and `tests_pass` (runs `npm test` inside the workdir — that requires the workdir to have its own `package.json`/install, which is a Build Bridge config decision we punt). Both are wired as TODO checks that always return `[]`.

## Capabilities

### New Capabilities
- `build-validator`: 10-check validator (9 active + 2 placeholders) over a build workdir.

### Modified Capabilities
*(none — pure module; orchestrator change consumes it)*

## Impact

- **Files added**:
  - `src/build/validator.ts` — types + `STANDARD_VALIDATION_CHECKS` + `runValidationChecks`.
  - `src/build/validator.test.ts` — per-check positive + negative cases against tmp-dir fixtures.
- **Files modified**:
  - `src/build/index.ts` — re-export the validator surfaces.
- **Non-goals**:
  - No CLI / runner — the orchestrator wires it.
  - No `tests_pass` / `pipeline_handles_sample` checks — placeholders only; future change wires once the test-runner host story is settled.
  - No fix-it suggestions inside findings — the message is descriptive; resolution is the LLM's job on the next turn.
