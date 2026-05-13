## MODIFIED Requirements

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
- `reextract.enabled: boolean` (default `true`)
- `reextract.poll_interval_seconds: number` (default `30`) — interval between worker ticks
- `reextract.checkpoint_every_rows: number` (default `20`)
- `reextract.max_concurrent_jobs: number` (default `1`)

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

#### Scenario: `reextract` field defaults are populated

- **WHEN** a config file omits the `reextract` field entirely
- **THEN** the loaded config has `reextract.enabled === true`, `reextract.poll_interval_seconds === 30`, `reextract.checkpoint_every_rows === 20`, `reextract.max_concurrent_jobs === 1`
