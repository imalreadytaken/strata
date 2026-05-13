# Strata

> Local-first personal data sedimentation and software forge — implemented as an OpenClaw plugin.

You chat with the bot like you would a friend ("just spent ¥45 on coffee at Blue Bottle", "本月在 Sweetgreen 花了多少？", "build me a workout tracker"). Strata reads each message, decides whether it's a fact worth recording / a question worth answering / a request to grow the system itself, and routes accordingly. Recorded facts pile up under append-only `raw_events`, get extracted into per-capability business tables by single-owner ingest pipelines, and become queryable, aggregatable, and visualisable — all in a single SQLite file at `~/.strata/main.db`.

- **Single source of truth**: SQLite at `~/.strata/main.db` — no cloud, no remote API, your data never leaves the machine.
- **Two-layer model**: `messages` (verbatim) → `raw_events` (append-only structured) → `business tables` (typed; owned by one pipeline; everything else is read-only).
- **Spec-driven self-build**: every change moves through OpenSpec (`propose → explore → apply → archive`), and new capabilities are co-built by spawning Claude Code as a subprocess governed by `openspec/AGENTS.md`.
- **LLM-agnostic by default**: heuristic fallback works out of the box; opt in to a real LLM by setting `models.fast = '<provider>/<model>'` and exporting the appropriate `*_API_KEY`. No API keys ever live in config files.

## Status — 0.1 (Week 7 dogfood phase)

Strata is **end-to-end runnable**. All five core protocols are in place:

| Protocol | What it does | Status |
|---|---|---|
| **Capture** | Triage → extract → pending → confirm → commit → pipeline writes business row | ✅ |
| **Query** | `strata_query_table` (aggregates / filters / top-N) + `strata_search_events` (ledger lookup) + `strata_render_dashboard` (KPI markdown) | ✅ |
| **Reflect** | Weekly cron scans `raw_events` for patterns / emergence / decay → proposes new capabilities | ✅ |
| **Build** | `strata_run_build` dispatches plan / decompose / apply / validate / integrate through a Claude Code subprocess; `strata_stop_build` aborts mid-flight | ✅ (stop done; resume deferred) |
| **Re-extract** | `reextract_jobs` worker drains schema-evolution backfills via three pluggable strategies (derive / raw_events LLM / messages LLM) | ✅ |

Eleven agent-callable `strata_*` tools, one example capability (`expenses`) shipping migrations + pipeline + extract prompt + dashboard, ~570 tests passing, and a TypeScript-strict (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`) codebase.

**Not in 0.1**: build resume (the row already preserves `claude_session_id`; the orchestrator's phase-skipping is the missing piece), multi-currency widgets, dashboard charts (text-only for now), cross-capability JOINs in queries.

## How it feels

A captured fact:

> **You**: 今天买了 Blue Bottle 拿铁 ¥45  
> **Strata**: I'll record this as an expense: Blue Bottle, ¥45, dining. Confirm? [✅ Yes] [❌ No]  
> *(tap ✅; row lands in `expenses` table)*

A query:

> **You**: 上周吃的总共花了多少？  
> **Strata**: ¥234 across 6 transactions. Top three: Sweetgreen ¥55, Blue Bottle ¥45, …

A dashboard:

> **You**: show me my expenses dashboard  
> **Strata** (markdown KPIs):  
> `*expenses*`  
> `• 本月支出: ¥352.00 (CNY)`  
> `• 本月笔数: 9`  
> `*Top 5 expenses*`  
> `1. Apple – ¥120.00 – 2026-05-09` …

A build:

> **You**: add a sleep tracker  
> **Strata**: Recorded as proposal #14. Run `strata_run_build({ proposal_id: 14 })` to spawn the build pipeline.  
> *(after the build finishes — typically 4–10 minutes — `~/.strata/capabilities/sleep_logs/v1/` exists and is registered)*

## Installation

See [`INSTALL.md`](INSTALL.md) for prerequisites, step-by-step setup, and a first-message walkthrough.

Short version:

```bash
git clone <this-repo> ~/.strata-plugin
cd ~/.strata-plugin
npm install
npm run typecheck && npm test   # confirm green

# Register the plugin with OpenClaw (see INSTALL.md for the platform-specific steps).
# On first message Strata creates ~/.strata/{main.db, config.json, capabilities/, logs/}.
```

## Authoring a new capability

The fastest path is to let Strata build it for you (the Build protocol). The on-disk shape, if you want to author by hand:

```
~/.strata/capabilities/<snake_case_name>/v1/
├── meta.json              # JSON5; CapabilityMetaSchema validates
├── migrations/
│   └── 001_init.sql       # CREATE TABLE; AGENTS.md mandates 7 columns
├── pipeline.ts            # owner-pipeline: ingest(rawEvent, deps) → business row
├── extract_prompt.md      # how the capture agent extracts structured JSON
└── dashboard.json         # optional; KPI / list widgets in Telegram markdown
```

Hard constraints (validation refuses violations):

- `raw_events` is **append-only**. Corrections use `strata_supersede_event` to insert a new committed row pointing at the old one.
- Money is `INTEGER` minor units (cents / fen / paise), paired with a `currency TEXT` column. Never `REAL`.
- Timestamps are ISO 8601 with timezone (`'2026-05-13T09:00:00+08:00'`), stored as `TEXT`.
- Every business row carries `id`, `raw_event_id`, `extraction_version`, `extraction_confidence`, `occurred_at`, `created_at`, `updated_at`.
- Migrations are immutable once applied; the per-capability `_strata_capability_migrations` ledger records checksum and refuses on tamper.

The full constitution Claude Code follows during co-build lives at [`openspec/AGENTS.md`](openspec/AGENTS.md) (it's the single most important file in the repo).

## The eleven `strata_*` tools

| Tool | Purpose |
|---|---|
| `strata_create_pending_event` | Drop a structured fact into `raw_events` with `status='pending'` awaiting user confirmation. |
| `strata_update_pending_event` | Patch a pending row when the user adds detail in a follow-up turn. |
| `strata_commit_event` | Confirm a pending row → `status='committed'` → ingest pipeline runs → business row written. |
| `strata_supersede_event` | Cross-session correction: new committed row with `supersedes_event_id` chain. |
| `strata_abandon_event` | User declined → `status='abandoned'`. |
| `strata_search_events` | LIKE search on `raw_events.source_summary` + filters on type / status / time. |
| `strata_propose_capability` | Record a user-driven build request in `proposals` (status=pending). |
| `strata_run_build` | Dispatch a proposal end-to-end through Build Bridge (plan / decompose / apply / validate / integrate). |
| `strata_stop_build` | Abort an in-flight build via the in-process `BuildSessionRegistry`. |
| `strata_query_table` | Read-only structured SELECT over a capability's primary table (filter / since / until / aggregate / select / limit ≤ 100). |
| `strata_render_dashboard` | Render a capability's `dashboard.json` widgets as Telegram markdown. |

All tools validate column references against `PRAGMA table_info` and bind values through `?` placeholders — there is no raw SQL surface exposed to the agent.

## Documentation

| Document | Purpose |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Prerequisites, setup, troubleshooting |
| [`docs/STRATA_SPEC.md`](docs/STRATA_SPEC.md) | Engineering contract (DDL, modules, prompts, full roadmap) |
| [`docs/PROJECT_RESEARCH_BACKGROUND.md`](docs/PROJECT_RESEARCH_BACKGROUND.md) | Research, ecosystem survey, decision log |
| [`docs/STRATA_PROJECT_GENESIS.md`](docs/STRATA_PROJECT_GENESIS.md) | Origin narrative (v1 attempt + pivot) |
| [`docs/STRATA_FIVE_PROTOCOLS_DEEP_DIVE.md`](docs/STRATA_FIVE_PROTOCOLS_DEEP_DIVE.md) | Deep-dive of the five core protocols |
| [`openspec/AGENTS.md`](openspec/AGENTS.md) | **The constitution.** Read this before authoring or modifying a capability. |
| `openspec/specs/<capability>/spec.md` | Per-capability requirements + scenarios (one folder per active capability). |
| `openspec/changes/archive/` | Every change ever applied (33 changes as of 0.1). |

## Tech stack

- **Language**: TypeScript (ESM, Node ≥ 22), `verbatimModuleSyntax`, `exactOptionalPropertyTypes`
- **Runtime host**: OpenClaw (plugin SDK)
- **Data**: SQLite (`better-sqlite3`) + `sqlite-vec` (vector search) + FTS5 (full-text)
- **Validation**: Zod 4 (`.prefault({})`, `z.toJSONSchema` at the SDK boundary)
- **LLM**: `@mariozechner/pi-ai` (multi-provider) for triage / extract / reflect; `claude-code` CLI for Build phase
- **Spec workflow**: OpenSpec (`core` profile, `spec-driven` schema)
- **Tests**: Vitest

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # vitest run (~570 tests, ~5s)
npm run test:watch
npm run lint
npm run format

# OpenSpec
openspec list                       # active changes
openspec list --specs               # active specs
openspec show <change-id>           # detail
openspec validate <change-id> --strict
```

When making a change, follow the OpenSpec flow exactly:

1. `openspec/changes/add-<name>/` with `proposal.md`, `design.md`, `tasks.md`, `specs/<capability>/spec.md`
2. Implement; keep `npm run typecheck` and `npm test` green
3. `openspec validate add-<name> --strict`
4. `openspec archive add-<name> --yes`
5. Fill the new spec's `## Purpose`
6. One git commit per change, ending with the standard `Co-Authored-By` trailer

## Roadmap

| Week | Theme | Status |
|---|---|---|
| 1 | Foundation (DB, repos, hooks) | ✅ |
| 2 | Capture (tools, pending buffer, capture skill) | ✅ |
| 3 | Capabilities (loader, pipeline runner, expenses) | ✅ |
| 4 | Build Bridge (plan / decompose / apply / validate / integrate) | ✅ |
| 5 | Reflect Agent + real LLM client + `strata_run_build` | ✅ |
| 6 | Re-extraction worker + query skill + dashboard | ✅ |
| 7 | Dogfood + stop/resume + bug-fixing | 🚧 (stop done; resume deferred) |
| 8 | Docs + release polish | 🚧 (README + INSTALL just landed) |

## License

MIT
