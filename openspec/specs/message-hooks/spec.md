# message-hooks Specification

## Purpose

`message-hooks` is Strata's first contact with the OpenClaw plugin runtime. Every inbound user message and every successfully delivered assistant message lands in the `messages` table — the bedrock layer the rest of Strata (Capture, Reflect, Query) reads from. The hooks never block the agent: a persistence failure is logged and swallowed. This capability also owns the singleton `bootRuntime(api)` helper that opens the DB, applies migrations, and instantiates every system-table repository the first time the plugin is registered.

## Requirements
### Requirement: installMessageHooks persists every user message

The system SHALL expose `installMessageHooks(api: OpenClawPluginApi, deps: { messagesRepo: MessagesRepository; logger: Logger }): void` that, when invoked at plugin `register` time, subscribes to the OpenClaw `message_received` lifecycle hook and inserts a `messages` row for every inbound user message.

The inserted row MUST contain:

- `role = 'user'`
- `channel = ctx.channelId`
- `session_id = ctx.conversationId ?? \`${ctx.channelId}:${event.from}\``
- `content = event.content`
- `content_type = 'text'` (V1 default; the OpenClaw event has no `content_type` field — richer types will be inferred from `event.metadata` in a later change)
- `turn_index = messagesRepo.getNextTurnIndex(session_id)`
- `received_at = ISO-8601 from event.timestamp` (ms epoch) if present, else `new Date().toISOString()`

A persistence failure MUST NOT propagate to the agent — it is logged at `error` level and swallowed.

#### Scenario: Persists an inbound message

- **WHEN** the `message_received` hook fires with `event = { from: 'u1', content: 'hi', timestamp: 1700000000000 }` and `ctx = { channelId: 'telegram', conversationId: 'conv-1' }`
- **THEN** a row appears in `messages` with `role = 'user'`, `channel = 'telegram'`, `session_id = 'conv-1'`, `content = 'hi'`, `turn_index = 0`, and `received_at = '2023-11-14T22:13:20.000Z'`

#### Scenario: Falls back to `<channel>:<from>` when conversationId is missing

- **WHEN** the hook fires with `ctx = { channelId: 'telegram' }` (no `conversationId`) and `event.from = 'u9'`
- **THEN** the inserted row has `session_id = 'telegram:u9'`

#### Scenario: Persistence failure does not block the agent

- **WHEN** the underlying repository's `insert` rejects with a `DatabaseError`
- **THEN** `installMessageHooks`'s handler resolves without throwing, and the error is logged at level `error` with the failing `session_id` and `channelId`

### Requirement: installMessageHooks persists every assistant message

The same function SHALL subscribe to the `message_sent` hook and insert a `role = 'assistant'` row for every outbound message OpenClaw confirms was delivered.

- The `event.to` field is the user identifier — used to derive `session_id` the same way as for inbound (`ctx.conversationId ?? \`${ctx.channelId}:${event.to}\``).
- `event.success === false` rows MUST be skipped (the message wasn't actually sent; logging it pollutes the transcript). A debug-level log entry SHALL record the skip.

#### Scenario: Persists a delivered outbound message

- **WHEN** the `message_sent` hook fires with `event = { to: 'u1', content: 'ok', success: true }` and `ctx = { channelId: 'telegram', conversationId: 'conv-1' }`
- **THEN** a `messages` row is inserted with `role = 'assistant'`, `session_id = 'conv-1'`, `content = 'ok'`, `turn_index = 1` (if a `user` row already exists at `turn_index = 0`)

#### Scenario: Skips a failed outbound message

- **WHEN** the hook fires with `event.success === false`
- **THEN** no row is inserted, and a `debug`-level log entry is emitted containing `event.error`

### Requirement: Plugin runtime boots the database once and wires the hooks

The plugin entry's `register(api)` SHALL:

1. Resolve `StrataConfig` via `loadConfig()`.
2. Open the SQLite database at `config.database.path` (creating parent dirs as needed).
3. Apply the system migrations from `SYSTEM_MIGRATIONS_DIR` idempotently.
4. Instantiate every system-table repository with the open database handle.
5. Call `installMessageHooks(api, { messagesRepo, logger })`.

Steps 1–4 SHALL run at most once per process; subsequent `register(api)` calls (in tests, multiple plugin reloads) MUST be safe to call repeatedly.

#### Scenario: Boots the runtime exactly once

- **WHEN** `register(api)` is invoked twice on the same process
- **THEN** `loadConfig` and `applyMigrations` are each called exactly once, the second call reuses the existing database handle and repositories

