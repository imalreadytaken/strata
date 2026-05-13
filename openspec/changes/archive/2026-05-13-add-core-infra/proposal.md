## Why

The Strata plugin currently has no way to load user configuration, emit structured logs, or signal failure with typed error classes — every later phase (DB, hooks, tools, Reflect, Build Bridge) assumes these primitives exist. Landing them first keeps subsequent change proposals small and focused.

References: `docs/STRATA_SPEC.md` §4.2 (src/core/ layout), §10.1 (config schema for `~/.strata/config.json`), §1.3 P5 (privacy-first: no API keys in our code).

## What Changes

- Add `core-infrastructure` capability covering:
  - **Config**: read `~/.strata/config.json` (JSON5), validate via Zod, expose a typed `StrataConfig` object; never store provider API keys (the spec is explicit: keys live in OpenClaw).
  - **Logger**: leveled (`debug` / `info` / `warn` / `error`) structured logger writing to `~/.strata/logs/plugin.log` plus stderr in dev; child-logger pattern for module tagging.
  - **Errors**: typed error hierarchy (`StrataError` base, plus `ConfigError`, `DatabaseError`, `ValidationError`, `NotFoundError`, `StateMachineError`) with stable `code` strings for telemetry.
- Add unit tests covering happy-path + each error branch.

## Capabilities

### New Capabilities
- `core-infrastructure`: typed config loader, structured logger, and error class hierarchy used by every other Strata module.

### Modified Capabilities
*(none — first capability in the repo)*

## Impact

- **Files added**: `src/core/{config,logger,errors,index}.ts` + co-located `*.test.ts`
- **Dependencies**: `zod` and `json5` (already declared in `package.json`); no new deps
- **Runtime side-effects**: lazy-creates `~/.strata/` and `~/.strata/logs/` on first load
- **Non-goals**: no migration runner (next change), no OpenClaw-API integration (P2), no embeddings, no telemetry sink other than local log files
