# Strata

> Local-first personal data sedimentation and software forge — implemented as an OpenClaw plugin.

Strata captures the structured facts a person mentions in conversation (consumption, mood, workouts, reading, …), holds them as **raw events** that never get deleted, lets capabilities (= small TypeScript pipelines + business tables + agent skills) emerge from accumulated data, and co-builds new capabilities with the user via Claude Code.

- **Single source of truth**: SQLite at `~/.strata/main.db`
- **Two-layer model**: messages → raw_events → business tables, every business row traceable to the raw event that produced it
- **Owner-pipeline rule**: every business table is written by exactly one ingest pipeline; everything else is read-only
- **No cloud**: 100% local, no API keys stored (LLM access goes through OpenClaw's model provider abstraction)
- **Code generation**: capabilities are co-built by spawning Claude Code as a subprocess, governed by `openspec/AGENTS.md`
- **Spec workflow**: every change moves through OpenSpec (`propose → explore → apply → archive`)

## Status

🚧 Pre-implementation bootstrap (P0). The full spec lives in [`docs/STRATA_SPEC.md`](docs/STRATA_SPEC.md) (2780 lines, 14 sections). The 8-week roadmap is in §9 of that document. Implementation is decomposed into 28 OpenSpec changes across phases P0–P7.

## Documentation

| Document | Purpose |
|---|---|
| [`docs/STRATA_SPEC.md`](docs/STRATA_SPEC.md) | **How** — engineering contract (DDL, modules, prompts, roadmap) |
| [`docs/PROJECT_RESEARCH_BACKGROUND.md`](docs/PROJECT_RESEARCH_BACKGROUND.md) | **Why & What** — research, ecosystem survey, decision log |
| [`docs/STRATA_PROJECT_GENESIS.md`](docs/STRATA_PROJECT_GENESIS.md) | Origin narrative (v1 attempt + pivot) |
| [`docs/STRATA_FIVE_PROTOCOLS_DEEP_DIVE.md`](docs/STRATA_FIVE_PROTOCOLS_DEEP_DIVE.md) | Technical deep-dive of the five core protocols |
| [`docs/STRATA_RESUME_PROFILE.md`](docs/STRATA_RESUME_PROFILE.md) | Concise project description |

The **system constitution** Claude Code follows during co-build lives at [`openspec/AGENTS.md`](openspec/AGENTS.md).

## Tech stack

- **Language**: TypeScript (ESM, Node ≥ 22)
- **Runtime host**: OpenClaw (plugin SDK)
- **Data**: SQLite + `sqlite-vec` (vector search) + FTS5 (full-text)
- **Validation**: Zod
- **Spec workflow**: OpenSpec (`core` profile, schema `spec-driven`)
- **Code generation**: Claude Code CLI (subprocess, `--output-format stream-json`)
- **Tests**: Vitest

## Development

```bash
# Install (P1 onwards)
npm install

# Type-check
npm run typecheck

# Test
npm test

# OpenSpec
openspec list                       # list change proposals
openspec list --specs               # list specs
openspec show <change-id>           # show a specific change
```

## License

MIT
