## Context

`STRATA_SPEC.md` §8 lists 10 validation checks. Two require a sample harness or a project-style `npm test` runner; the other 8 + an additional "pipeline.ts exports ingest" check are pure FS / SQL / JSON parsing. The validator is a sibling of the build orchestrator — it runs after `/opsx:apply` produces files but before integration writes anything into `~/.strata/capabilities/`.

The output shape is a flat `ValidationReport` so the orchestrator can:

- Decide whether to proceed (`if (!report.ok) abort`).
- Forward findings to Telegram via `progress_forwarder` (next change).
- Replay the LLM run with the findings as feedback ("you violated these rules; please fix").

Each check returns an array of `ValidationFinding`s (zero on success). Multiple findings per check are common — e.g., two business tables, each missing different columns.

## Goals / Non-Goals

**Goals:**
- Checks are **independent**, runnable in parallel via `Promise.all(checks.map(c => c.run(ctx)))`.
- Each check's `run` is **pure-ish** — it reads from FS + a tmp DB, never mutates the workdir.
- `STANDARD_VALIDATION_CHECKS` is exported, replaceable, and extensible — the orchestrator can pass `[...STANDARD_VALIDATION_CHECKS, customCheck]` for a one-off.
- SQL parsing for `CREATE TABLE` columns uses a tiny tokenizer; we don't reach for an actual SQL AST library (parser complexity / drift).
- Every check has at least one positive and one negative test against tmp-dir fixtures.

**Non-Goals:**
- No structured AST output of migrations — the tokenizer is for spot checks only.
- No `pipeline_handles_sample` — needs a model abstraction (deferred to LLM-backend change).
- No `tests_pass` — needs a workdir-bound test runner (deferred to a future Build Bridge config decision).
- No git-blame / commit-time validation — `change_scope` uses the workspace's initial commit; that's enough.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/validator.ts` | new | `ValidationCheck`, `ValidationFinding`, `ValidationReport`, `runValidationChecks`, `STANDARD_VALIDATION_CHECKS`. |
| `src/build/validator.test.ts` | new | One `describe` block per check: positive + negative case using tmp fixtures. |
| `src/build/index.ts` | modified | Re-exports validator surfaces. |

## Decisions

### D1 — Tokenizer, not SQL parser, for `CREATE TABLE` introspection

We need column names + types from `CREATE TABLE foo (…)`. A regex+tokenizer hits 99% of the patterns AGENTS.md generates; a real parser (`node-sql-parser`) is heavy + drift-prone. We document the supported subset in the validator and refuse migrations that don't parse cleanly.

### D2 — `change_scope` uses `git diff --name-only <workspace.gitInitialCommit>`

The workspace's initial commit is the deterministic baseline. Files modified since must live under either `openspec/changes/<change>/` (proposal/specs/design/tasks) or `capabilities/<name>/v<N>/` (the produced capability). Files outside both are findings.

### D3 — `migration_applies_clean` opens a tmp DB in-memory

`better-sqlite3` supports `:memory:`. We open a fresh in-mem connection, apply the system migrations from this codebase (the validator imports them — they're the prerequisite for *any* business table), then apply the workdir's capability migrations. Any error → finding.

### D4 — `extract_prompt_present` checks for hardcoded model strings

The set is `[/gpt-\d/i, /claude-\d/i, /gemini-\d/i, /o1-/i, /grok-/i]`. Matches found in the prompt body produce a finding. We don't try to fuzz harder — if the LLM is creative ("model: 'claude-3-5-sonnet-20241022'" matches `claude-` prefix and the test fails).

### D5 — `no_api_keys` matches sk- AND ANTHROPIC/OPENAI/GOOGLE patterns

```
/sk-[a-zA-Z0-9_-]{20,}/    // OpenAI-style
/anthropic_api_key\s*=/i   // env-style
/openai_api_key\s*=/i
/google_api_key\s*=/i
/AIza[0-9A-Za-z_-]{35}/    // Google API key shape
```

We do NOT block `process.env.X_API_KEY` references — that's the *correct* way to reference a key. Hard-coded literals are the failure mode.

### D6 — `pipeline_module_exports_ingest` uses dynamic `import()`

Pulls in the same machinery `pipeline_runner` uses to verify the export. Caught failures (`SyntaxError`, missing `ingest`) become findings. The check imports the file inside the workdir — Vitest's vite-node loader handles TS at runtime; in production, the orchestrator runs after the build, where dynamic import already works.

### D7 — Two placeholder checks return `[]`

`pipeline_handles_sample` and `tests_pass` ship as named checks that always succeed. Documented in the check description so the orchestrator's reports honestly say "skipped: pipeline_handles_sample (placeholder)". When the model-backend / test-runner stories land, we replace the body.

## Risks / Trade-offs

- **Tokenizer is brittle vs. weird SQL** (e.g., quoted identifiers, multi-line column defs). We document the supported subset; LLM output via AGENTS.md typically stays inside it. If we see drift in dogfood, we switch to a real parser.
- **`migration_applies_clean` runs system + capability migrations every check.** ~50 ms for the 8 system migrations. Acceptable.
- **Dynamic `import()` of pipeline.ts can fail in production environments** without a TS loader. Falls back to a clear finding rather than a crash; if the binary is preinstalled (e.g., `tsx`), it works.
