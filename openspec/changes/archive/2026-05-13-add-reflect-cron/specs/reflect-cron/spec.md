## ADDED Requirements

### Requirement: `runReflectOnce` composes detection → proposals → push

The system SHALL export `runReflectOnce(deps): Promise<ReflectRunResult>` that calls each detector (`detectNewCapabilityEmergence`, `detectSchemaEvolutionNeed`, `detectArchiveCandidates`), concatenates the signals, calls `generateProposals`, and (when `deps.notify` is supplied) calls `pushProposalsToUser`. Returns `{ signals, generated, pushed }`.

#### Scenario: Seeded DB yields a signal → proposal → optional push

- **WHEN** the DB carries enough events to trigger emergence + a skewed expenses column AND `deps.notify` is supplied
- **THEN** `runReflectOnce` returns `{ signals.length >= 2, generated.inserted.length >= 2, pushed === inserted.length }`

#### Scenario: No notify → pushed=0

- **WHEN** `deps.notify` is undefined
- **THEN** `pushed === 0` and no `pushed_to_user_at` stamp lands on the inserted rows

### Requirement: `startReflectAgent` fires once per week at the configured hour

The system SHALL export `startReflectAgent(deps, opts?): () => void`. The returned function clears the timer; calling it twice is safe. Default schedule: `dayOfWeek=0` (Sunday), `hour=3`, `intervalMs=3_600_000`. The check function:

1. Skips when `now.getDay()` ≠ schedule.dayOfWeek.
2. Skips when `now.getHours()` ≠ schedule.hour.
3. Skips when a `proposals` row with `source='reflect_agent'` exists with `created_at >= now - 6 days`.
4. Otherwise runs `runReflectOnce(deps)` (errors logged, not propagated).

#### Scenario: In-window tick fires once

- **WHEN** `now` is set to Sunday 03:00 and the proposals table has no recent reflect rows, and the timer tick fires
- **THEN** `runReflectOnce` is invoked exactly once

#### Scenario: Out-of-window tick does not fire

- **WHEN** `now` is set to Wednesday 12:00
- **THEN** `runReflectOnce` is not invoked

#### Scenario: Already-fired-this-week tick is skipped

- **WHEN** the proposals table has a `reflect_agent` row from 2 days ago and `now` is Sunday 03:00
- **THEN** `runReflectOnce` is not invoked

#### Scenario: stop() halts further ticks

- **WHEN** `stop()` is called and then the timer would otherwise fire
- **THEN** no further `runReflectOnce` invocations happen

### Requirement: `handleReflectCallback` updates `proposals` per user action

The system SHALL export `handleReflectCallback(deps)` returning a `PluginInteractiveTelegramHandlerContext → Promise<void>` handler that parses `ctx.callback.payload` as `<action>:<proposalId>` where `action ∈ { 'approve', 'decline' }`. On match:

- `approve` → `proposalsRepo.update(id, { status: 'approved', responded_at: now })`; edit the message text to acknowledge; clear buttons.
- `decline` → `proposalsRepo.update(id, { status: 'declined', responded_at: now, cooldown_until: now + 30 * 86400000 ms })`; edit + clear.

Malformed payloads, missing proposals, and `editMessage` rejections are warn-logged and never propagated.

#### Scenario: Approve flips status and clears buttons

- **WHEN** the handler runs with `ctx.callback.payload='approve:7'` against an existing pending proposal #7
- **THEN** the row's `status='approved'`, `responded_at` is set, and `respond.editMessage` was called with `buttons: []`

#### Scenario: Decline sets cooldown_until 30 days ahead

- **WHEN** the handler runs with `payload='decline:7'` and `now=2026-05-13T00:00:00Z`
- **THEN** the row's `status='declined'` and `cooldown_until ≈ 2026-06-12T00:00:00Z`

#### Scenario: Malformed payload logs warn and does NOT mutate

- **WHEN** `payload = 'foo'`
- **THEN** no DB write happens and `respond.editMessage` is not called

### Requirement: Plugin entry installs the cron + interactive handler

The plugin's `register(api)` SHALL call `startReflectAgent(deps)` and `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata-propose', handler })`. The cron's `stop` handle is stowed on `runtime.stopReflect`.

#### Scenario: Plugin register installs both surfaces

- **WHEN** `register(api)` runs with a recording stub `api`
- **THEN** `api.registerInteractiveHandler` was called for channel='telegram' / namespace='strata-propose', AND the runtime exposes a `stopReflect` callable function
