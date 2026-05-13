# Strata System Constitution

You are working inside a user's Strata personal data system. Read this carefully
before writing any code. Violations will fail validation and require rework.

## Architecture

Strata is a personal data sediment system. Key facts:

- Strata is implemented as an OpenClaw plugin (TypeScript).
- SQLite at `~/.strata/main.db` is the source of truth.
- All business data follows two-layer pattern: `messages → raw_events → business_table`
- Business tables are written by exactly ONE ingest pipeline (owner pipeline rule).
- All other components have READ-ONLY access to business tables.
- LLM access goes through OpenClaw's model provider abstraction — NEVER hardcode API keys.

## Hard constraints (MUST follow, validation will fail otherwise)

1. **Raw events are append-only.** Never DELETE or UPDATE rows in `raw_events`.
   For corrections, use the `supersedes_event_id` chain.

2. **Money uses INTEGER minor units.** Never use FLOAT for money.
   - Correct: `amount_minor INTEGER NOT NULL`, `currency TEXT NOT NULL DEFAULT 'CNY'`
   - Wrong: `amount REAL`

3. **All timestamps are ISO 8601 with timezone.**
   - Correct: `occurred_at TEXT NOT NULL` storing `"2026-05-11T15:30:00+08:00"`
   - Wrong: SQLite `DATETIME` or naive strings

4. **Every business table row MUST have these fields:**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `raw_event_id INTEGER NOT NULL REFERENCES raw_events(id)`
   - `extraction_version INTEGER NOT NULL DEFAULT 1`
   - `extraction_confidence REAL` (NULL if not extracted by LLM)
   - `occurred_at TEXT NOT NULL`
   - `created_at TEXT NOT NULL`
   - `updated_at TEXT NOT NULL`

5. **Migrations are immutable.** Once applied, never edit a migration file.
   For schema changes, add a new migration with the next sequence number.

6. **Schema evolution must update `schema_evolutions` registry.**
   Any `ALTER TABLE` in your migration must also `INSERT` into `schema_evolutions`.

## Naming conventions

- Capability directory: `~/.strata/capabilities/<snake_case_name>/v<N>/`
- Primary business table: `<capability>_<entity_plural>` (e.g., `expenses`, `mood_logs`)
- Migration file: `migrations/<NNN>_<description>.sql` (zero-padded 3-digit prefix)
- Pipeline file: `pipeline.ts`
- Extraction prompt: `extract_prompt.md`
- Skill: `skill/SKILL.md`
- Dashboard config: `dashboard.json`
- Cron config: `cron.json`
- Meta: `meta.json`
- Tests: `tests/*.test.ts`

### Field naming

- Money: `<purpose>_minor INTEGER` paired with `currency TEXT`
- Timestamps: `<event>_at TEXT` (ISO 8601)
- Booleans: `is_<noun> INTEGER` (0/1; SQLite has no BOOLEAN)
- Enums: `<name>_kind TEXT` with CHECK constraint
- Foreign keys: `<table>_id INTEGER REFERENCES <table>(id)`

## File structure for a capability

```
capabilities/<name>/v<N>/
├── meta.json              # Capability metadata
├── migrations/
│   └── 001_init.sql       # Or 002_add_subcategory.sql etc.
├── pipeline.ts            # Ingest logic
├── extract_prompt.md      # LLM extraction prompt
├── skill/
│   └── SKILL.md           # Agent skill for this domain
├── dashboard.json         # Widget definitions (optional)
├── cron.json              # Scheduled tasks (optional)
└── tests/
    └── *.test.ts
```

### `meta.json` schema

```json
{
  "name": "expenses",
  "version": 1,
  "description": "Track personal consumption with merchant/amount/category",
  "primary_table": "expenses",
  "depends_on_capabilities": [],
  "ingest_event_types": ["consumption"],
  "owner_pipeline": "pipeline.ts",
  "exposed_skills": ["skill/SKILL.md"]
}
```

## What you can do (within scope)

- Create new business tables (always with required fields above)
- Write ingest pipelines (match `raw_events`, parse, write business table)
- Write LLM extraction prompts
- Write agent skills for querying this domain
- Define dashboard widgets
- Register cron jobs
- Write tests

## What you MUST NOT do

- Modify any file outside the current change's scope
- Modify any file in `core/` or `shared/`
- Modify any file in another capability's directory
- Delete any data (including in your own capability — use soft delete via status field)
- Bypass the owner-pipeline rule (one pipeline per business table)
- Skip writing tests
- Hardcode API keys, model names, or provider URLs
- Use `Bash` to install packages globally
- Make network requests during build (no `WebFetch` / `WebSearch`)

## LLM access

- For extraction prompts and reasoning, the pipeline will call OpenClaw's
  `api.models.infer({ model: 'fast' | 'smart' })`. Never hardcode model names.
- The user's API keys are managed by OpenClaw configuration. You never touch them.

## Failure escape

If you encounter the same error 3+ times in a row, STOP and write a file
called `BUILD_STUCK.md` in the workdir with:

- What you were trying to do
- The error encountered
- What you've already tried
- Specific question for the user

Then exit gracefully. Do NOT keep retrying indefinitely.

## OpenSpec workflow

You are using OpenSpec workflows (core profile). Key slash commands:

- `/opsx:propose <description>` — Create a change with `proposal.md` / `design.md` / `tasks.md`
- `/opsx:explore <change-id>` — Refine the change interactively
- `/opsx:apply <change-id>` — Implement the tasks
- `/opsx:archive <change-id>` — Archive after successful integration

Always:

- Check off tasks in `tasks.md` as you complete them
- After implementation, address all CRITICAL findings before archiving (WARNINGs can be acknowledged)

## Testing requirements

Every capability MUST have tests for:

1. Migration applies cleanly to a fresh DB
2. Pipeline correctly extracts at least 3 sample inputs
3. Schema constraints are enforced (e.g., `NOT NULL`, `CHECK`)
4. Extracted row has correct `extraction_version` and `raw_event_id` FK

## Reference: existing capabilities

Before writing any new capability, ALWAYS read the files in
`existing_capabilities/` directory in your workdir. These are read-only
snapshots of capabilities already in the system. Follow their style for
naming, field conventions, and prompt patterns.

## Reference: source documents

The full engineering contract this constitution distils from lives at:

- [`docs/STRATA_SPEC.md`](../docs/STRATA_SPEC.md) — How (modules, DDL, prompts, roadmap)
- [`docs/PROJECT_RESEARCH_BACKGROUND.md`](../docs/PROJECT_RESEARCH_BACKGROUND.md) — Why & What

When this file and `STRATA_SPEC.md` disagree, **this file wins** (it is the
runtime contract validation enforces). Open a PR amending both if you discover
a real inconsistency.
