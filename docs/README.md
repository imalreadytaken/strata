# Strata · Documentation Index

This directory contains the complete documentation set for **Strata** — a local-first personal data sedimentation and software forge platform.

## Document map

| File | Audience | Purpose | Lines |
|---|---|---|---|
| **`STRATA_SPEC.md`** | Implementer (yourself + Claude Code) | Complete engineering contract — DDL, module designs, prompts, implementation roadmap | ~2800 |
| **`PROJECT_RESEARCH_BACKGROUND.md`** | Collaborators / research archive | Why & What — research rationale, ecosystem survey, design decisions, decision log | ~1250 |
| **`STRATA_PROJECT_GENESIS.md`** | Interviewer (5-7 min storytelling) | Project origin narrative — including v1 attempt, pivot, and self-corrections | ~420 |
| **`STRATA_FIVE_PROTOCOLS_DEEP_DIVE.md`** | Interviewer (20-25 min technical deep-dive) | Detailed walkthrough of each protocol — problem, mechanism, key insights | ~700 |

## Deprecated documents

| File | Status |
|---|---|
| `personal-assistant-spec.md` | **v1 spec — superseded by Strata**. Kept for historical reference only. Strata was born after running this v1 and identifying capability gaps + cost issues. See `STRATA_PROJECT_GENESIS.md` for the full pivot story. |

## How the documents relate

```
                  ┌─────────────────────────────────────┐
                  │  PROJECT_RESEARCH_BACKGROUND.md     │
                  │  (Why & What — research depth)      │
                  └─────────────────┬───────────────────┘
                                    │ informs
                                    ▼
                  ┌─────────────────────────────────────┐
                  │  STRATA_SPEC.md                     │
                  │  (How — engineering contract)       │
                  └─────────────────────────────────────┘

                  Reads above and produces interview material:
                                    │
                                    ▼
                        ┌────────────┴────────────┐
                        │                         │
                        ▼                         ▼
              ┌──────────────────┐      ┌──────────────────┐
              │ PROJECT_GENESIS  │      │ PROTOCOLS_DEEP   │
              │ (5-7 min story)  │      │ (20-25 min       │
              │                  │      │  technical talk) │
              └──────────────────┘      └──────────────────┘
```

## Reading order

### For implementation
1. Read `STRATA_SPEC.md` end-to-end (especially §2 architecture, §3 data model, §5 modules, §9 roadmap)
2. Reference `PROJECT_RESEARCH_BACKGROUND.md` when you need to understand *why* a decision was made

### For interview prep
1. Start with `STRATA_PROJECT_GENESIS.md` to internalize the project narrative
2. Memorize the 5 protocols from `STRATA_FIVE_PROTOCOLS_DEEP_DIVE.md` — each has 3-5 minutes of material

## Tech stack

- **Runtime**: OpenClaw (agent runtime + IM + model provider abstraction)
- **Code generation**: Claude Code CLI (subprocess)
- **Spec workflow**: OpenSpec (workflows profile)
- **Data**: SQLite + sqlite-vec + FTS5
- **Language**: TypeScript
- **Deployment**: 100% local, no cloud

## Status

- v1 (`personal-assistant-spec.md`): completed and ran, found gaps and implementation cost issues
- v2 (Strata): design complete (5500+ lines of documentation), implementation pending

## Last updated

2026-05-12
