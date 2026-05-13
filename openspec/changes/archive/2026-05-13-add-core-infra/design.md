## Context

Strata persists every piece of state under `~/.strata/`. The plugin therefore needs three minimal primitives before any other phase can land:

- a typed view of user config that explicitly refuses to ever hold a provider API key (P5 from `STRATA_SPEC.md` §1.3)
- a structured log sink so later modules (Reflect, Build Bridge, Re-extract worker) can correlate failures across long-running background tasks
- a typed error hierarchy with stable codes so callers can match on `err.code` rather than message strings

These three live together in `src/core/` because they are tightly coupled (the config loader logs errors and the logger reads its level from config) and because every other module depends on them.

## Goals / Non-Goals

**Goals:**

- Zero-dep beyond `zod` and `json5` (both already declared).
- Compile cleanly under `tsconfig.json` strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- All public surface covered by Vitest unit tests.
- API stable enough that subsequent phases never have to edit these files again, only consume them.

**Non-Goals:**

- No async log shipping, no rotation. `plugin.log` grows; rotation is a later concern.
- No OpenClaw API integration (`api.logger`, `api.config`) — that wiring happens in P2 when `register(api)` actually does something.
- No metrics / telemetry beyond local files.
- No remote error reporting.
- No "log to multiple files" — single `plugin.log` is fine for MVP. Per-subsystem log files (`reextract.log`, `orchestrator.log` mentioned in `STRATA_SPEC.md` §4.1) become child loggers writing to the same file, distinguished by the `module` field.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/core/errors.ts` | new | `StrataError` base + 5 subclasses, stable `code` strings, `toJSON()` |
| `src/core/config.ts` | new | Zod schema + `loadConfig()` + path expansion + forbidden-key check |
| `src/core/logger.ts` | new | `createLogger()` factory, levels, child loggers, JSON record format |
| `src/core/index.ts` | new | Barrel re-export |
| `src/core/errors.test.ts` | new | Hierarchy / code / cause / toJSON tests |
| `src/core/config.test.ts` | new | Valid / missing / invalid / forbidden-key / `~` expansion tests |
| `src/core/logger.test.ts` | new | Records emitted / child inheritance / level gating / file path |
| `vitest.config.ts` | new | Test runner config (node env, src globs, coverage thresholds) |

No source file outside `src/core/` is modified. No existing tests are touched (none exist).

## Decisions

### D1 — Zod for config validation

The Strata spec calls for "JSON5 + Zod" implicitly (§1.2 tech stack lists both). Decision: parse with `json5`, validate the parsed object with Zod. Errors carry the path so users can fix the offending key.

### D2 — Forbidden-key check independent of schema

The spec is emphatic (P5, AGENTS.md): API keys never live in our config. We enforce this with a recursive walk that runs AFTER schema validation. Reason: a malicious or accidental key would be ignored by `Zod.strict()` if the schema doesn't mention it, but `.strict()` only catches keys at the top of an object — nested forbidden keys slip through. A separate walk is unambiguous.

### D3 — JSON-lines log format

Each record is a single `JSON.stringify(...)` line. Decision rationale: easy to grep, easy to parse with `jq`, no log-library dependency, and stays compatible if we later swap to pino/winston.

### D4 — Synchronous append using `fs.appendFileSync`

Every record is written with `fs.appendFileSync`. The first emit on a given logger lazily ensures the parent directory exists via `fs.mkdirSync({ recursive: true })`. Reason: at the volumes Strata will produce (one IM message per minute at peak, not gigabytes per second), sync writes are simpler than an async stream lifecycle; tests can read the file immediately without flush ceremonies; and there is no shutdown handler to worry about. If profiling under dogfood shows this is hot, P7 can swap in a buffered/async writer.

### D5 — Child loggers via prototype-style merging

`logger.child({ module: 'db' })` returns a new logger sharing the same write stream but with a frozen merged `bindings` object. No class hierarchy needed.

### D6 — Error subclasses, not codes-as-strings

We could ship a single `StrataError` with a `code` field. Decision: keep small subclass set. Reason: callers can write `catch (err: ConfigError)` cleanly, and `instanceof` works after we set `Object.setPrototypeOf` (`Error` subclassing on older Node loses prototype unless you do this).

## Risks / Trade-offs

- **Log volume**: a chatty `info` level can fill disk. Mitigation: ship sane default level `info` and document `logging.level = 'warn'` for users running headless. Rotation is a future change, not blocking.
- **Forbidden-key false positives**: a user may legitimately want a key named `secret_friend_quote`. The check uses word-boundary matching so `_secret_` substrings inside an otherwise-named key are not flagged; only keys whose own name is `secret`, `token`, `api_key`, `apikey`, `api-key`, etc. are. Documented in the proposal.
- **Stream lifetime**: a long-lived write stream is closed on process exit by Node's default behavior. We do not register a SIGTERM handler in this change; if subsequent phases need graceful shutdown, they add it themselves.
- **No log rotation**: explicitly listed as a non-goal. If `~/.strata/logs/plugin.log` exceeds a sensible size in dogfood, we add rotation in P7.
