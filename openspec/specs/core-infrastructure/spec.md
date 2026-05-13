# core-infrastructure Specification

## Purpose

`core-infrastructure` is the foundation every other Strata module depends on: a typed view of user configuration (with a hard-coded refusal to ever store provider credentials — those live in OpenClaw), a structured JSON logger that writes to `~/.strata/logs/plugin.log`, and a typed error hierarchy with stable `code` strings callers can match on. The surface is intentionally tiny — no async log shipping, no rotation, no metrics — so that adding a dependency on it never costs anything elsewhere.
## Requirements
### Requirement: Config loader returns typed Strata configuration

The system SHALL expose a `loadConfig(): Promise<StrataConfig>` function that reads `~/.strata/config.json` (JSON5 syntax) and returns a Zod-validated, fully-typed configuration object.

The schema MUST include at minimum:

- `version: string` (top-level)
- `database.path: string` (default `~/.strata/main.db`)
- `paths.dataDir: string` (default `~/.strata`)
- `paths.capabilitiesDir: string` (default `~/.strata/capabilities`)
- `paths.openspecDir: string` (default `~/.strata/openspec`)
- `paths.plansDir: string` (default `~/.strata/plans`)
- `paths.buildsDir: string` (default `~/.strata/builds`)
- `paths.logsDir: string` (default `~/.strata/logs`)
- `logging.level: 'debug' | 'info' | 'warn' | 'error'` (default `info`)
- `logging.toStderr: boolean` (default `true` in dev, `false` otherwise)
- `pending.timeoutMinutes: number` (default `30`)
- `models.fast: string` (default `'auto'`) — `'auto'` keeps the heuristic LLM client; `'<provider>/<modelId>'` opts in to a real backend
- `models.smart: string` (default `'auto'`) — reserved for the Reflect agent's pattern-analysis prompt
- `models.coder: string` (default `'claude-code-cli'`) — reserved for Build Bridge's Claude Code subprocess

The schema MUST forbid any key whose name matches `/api[_-]?key/i`, `/token/i`, or `/secret/i` at any depth, and the loader MUST throw `ConfigError` with code `STRATA_E_CONFIG_FORBIDDEN_KEY` if such a key is present.

The loader MUST expand a leading `~/` in path values to the user's home directory.

#### Scenario: Loads a valid config file

- **WHEN** `~/.strata/config.json` exists and parses as JSON5 against the schema
- **THEN** `loadConfig()` resolves with a frozen object whose `~`-prefixed paths are expanded to absolute paths

#### Scenario: Falls back to defaults when the file is missing

- **WHEN** `~/.strata/config.json` does not exist
- **THEN** `loadConfig()` resolves with the default config (no error)

#### Scenario: Rejects an invalid schema

- **WHEN** the config file is present but a required field has the wrong type
- **THEN** `loadConfig()` rejects with `ConfigError` whose `code === 'STRATA_E_CONFIG_INVALID'` and whose message identifies the offending field path

#### Scenario: Refuses to store API keys

- **WHEN** the config file contains a property named `api_key`, `apiKey`, `token`, or `secret` (case-insensitive) anywhere in the tree
- **THEN** `loadConfig()` rejects with `ConfigError` whose `code === 'STRATA_E_CONFIG_FORBIDDEN_KEY'`

#### Scenario: `models` field defaults are populated

- **WHEN** a config file omits the `models` field entirely
- **THEN** the loaded config has `models.fast === 'auto'`, `models.smart === 'auto'`, `models.coder === 'claude-code-cli'`

### Requirement: Structured logger with levels and child loggers

The system SHALL expose a `createLogger(options): Logger` factory that returns a logger with methods `debug(msg, fields?)`, `info(msg, fields?)`, `warn(msg, fields?)`, `error(msg, fields?)`, plus `child(bindings): Logger` for sub-module tagging.

Each emitted record MUST be a single line of JSON containing at least `ts` (ISO 8601 with TZ), `level`, `msg`, `module` (from child bindings), and any structured `fields` merged in. Records MUST be appended to `<logsDir>/plugin.log` (created if needed) and additionally written to `stderr` when `toStderr === true`.

The logger MUST silently drop records below the configured minimum level.

#### Scenario: Emits structured JSON with required fields

- **WHEN** `logger.info('hello', { user: 'seven' })` is called on a logger whose configured level is `info`
- **THEN** a single line of valid JSON is appended to `plugin.log` containing `ts`, `level: 'info'`, `msg: 'hello'`, and `user: 'seven'`

#### Scenario: Child logger inherits and extends bindings

- **WHEN** `logger.child({ module: 'db' }).info('connected')` is called
- **THEN** the emitted record contains `module: 'db'` in addition to any bindings on the parent

#### Scenario: Drops records below configured level

- **WHEN** `logger.debug('noise')` is called on a logger whose level is `info`
- **THEN** nothing is written to `plugin.log` or `stderr`

### Requirement: Typed error hierarchy with stable error codes

The system SHALL expose a `StrataError` base class extending `Error`, plus the concrete subclasses `ConfigError`, `DatabaseError`, `ValidationError`, `NotFoundError`, and `StateMachineError`. Each subclass MUST set a stable `code` string (e.g., `STRATA_E_CONFIG_INVALID`) and MUST support an optional `cause` for chaining.

Stack traces MUST be preserved across `cause` chains. The base class MUST expose a `toJSON()` method returning `{ name, code, message, cause? }` suitable for logging.

#### Scenario: Subclass exposes its declared code

- **WHEN** `new ConfigError('STRATA_E_CONFIG_INVALID', 'bad value')` is constructed
- **THEN** the resulting instance satisfies `err instanceof StrataError`, `err instanceof ConfigError`, `err.code === 'STRATA_E_CONFIG_INVALID'`, and `err.name === 'ConfigError'`

#### Scenario: Cause chain is preserved on JSON serialization

- **WHEN** a `DatabaseError` is constructed with `{ cause: new Error('disk full') }` and `toJSON()` is called
- **THEN** the returned object includes a `cause` field with the original error's message

