## 1. Errors

- [x] 1.1 Create `src/core/errors.ts` with `StrataError` base class extending `Error`, accepting `(code: string, message: string, options?: { cause?: unknown })`. Wire `Object.setPrototypeOf(this, new.target.prototype)` so `instanceof` works after subclassing.
- [x] 1.2 Add `code: string` and `cause?: unknown` instance fields, and a `toJSON()` method returning `{ name, code, message, cause? }` (cause stringified to its `.message` if it is an `Error`).
- [x] 1.3 Add subclasses `ConfigError`, `DatabaseError`, `ValidationError`, `NotFoundError`, `StateMachineError`. Each constructor `(code: string, message: string, options?)` calls `super(code, message, options)` and sets `this.name`.
- [x] 1.4 Export a `StrataErrorCode` union type (string-literal union of all known codes used in this change).
- [x] 1.5 Write `src/core/errors.test.ts` covering: subclass `instanceof` chain, code propagation, `toJSON()` shape with and without `cause`, stack-trace preservation.

## 2. Config

- [x] 2.1 Create `src/core/config.ts` with a Zod schema `ConfigSchema` matching the requirement in `specs/core-infrastructure/spec.md`. Use `.strict()` on every object.
- [x] 2.2 Implement `expandTilde(p: string): string` using `os.homedir()`.
- [x] 2.3 Implement `assertNoForbiddenKeys(obj: unknown): void` — recursive walk, throws `ConfigError('STRATA_E_CONFIG_FORBIDDEN_KEY', ...)` if any key (case-insensitive) matches the regex `/^(api[_-]?key|apikey|token|secret)$/i`.
- [x] 2.4 Implement `loadConfig(opts?: { path?: string }): Promise<StrataConfig>`:
  - Default path: `~/.strata/config.json` (after tilde expansion)
  - File missing → return `Object.freeze(defaults)`
  - File present → parse with `json5`, validate with Zod, run `assertNoForbiddenKeys`, expand all `paths.*` fields, freeze, return
  - Schema failure → `ConfigError('STRATA_E_CONFIG_INVALID', ...)` with the offending Zod issue path in the message
- [x] 2.5 Export type `StrataConfig = z.infer<typeof ConfigSchema>`.
- [x] 2.6 Write `src/core/config.test.ts` using a temp directory: missing file, valid file, invalid type, top-level forbidden key, nested forbidden key, tilde expansion.

## 3. Logger

- [x] 3.1 Create `src/core/logger.ts` with `type LogLevel = 'debug' | 'info' | 'warn' | 'error'` and a numeric ordering map.
- [x] 3.2 Implement `createLogger(opts: { level: LogLevel; logFilePath: string; toStderr?: boolean; bindings?: Record<string, unknown> }): Logger` where `Logger` has methods `debug`, `info`, `warn`, `error`, and `child(bindings) → Logger`.
- [x] 3.3 Lazily create the log directory on first emit (`fs.mkdirSync({ recursive: true })`). All emits use `fs.appendFileSync` for simplicity and testability.
- [x] 3.4 Each record is `JSON.stringify({ ts, level, msg, ...bindings, ...fields }) + '\n'`. `ts` is `new Date().toISOString()`.
- [x] 3.5 Below-threshold records are dropped (no stringify, no write).
- [x] 3.6 `child(bindings)` returns a new logger sharing the underlying write stream but with `Object.freeze({ ...parent.bindings, ...bindings })`.
- [x] 3.7 Write `src/core/logger.test.ts`: records are valid JSON; required fields present; child inheritance; level gating; stderr mirroring.

## 4. Barrel and integration

- [x] 4.1 Create `src/core/index.ts` re-exporting all public APIs from `errors.ts`, `config.ts`, and `logger.ts`.
- [x] 4.2 Add a `vitest.config.ts` configuring node environment, `src/**/*.test.ts` globs, and the v8 coverage provider.
- [x] 4.3 Run `npm run typecheck` → must pass cleanly.
- [x] 4.4 Run `npm test` → all unit tests pass.
