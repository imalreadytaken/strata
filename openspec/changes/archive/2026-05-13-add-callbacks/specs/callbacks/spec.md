## ADDED Requirements

### Requirement: `parseStrataPayload` extracts action + event id from a callback payload

The system SHALL export `parseStrataPayload(payload: string): { action: 'commit' | 'edit' | 'abandon'; eventId: number } | null` that parses the substring after the registered `strata` namespace.

Valid input is `<action>:<eventId>` where `action` is one of `commit` / `edit` / `abandon` and `eventId` parses as a positive integer. Any other shape returns `null`.

#### Scenario: Parses a valid commit payload

- **WHEN** `parseStrataPayload('commit:42')` is called
- **THEN** the result is `{ action: 'commit', eventId: 42 }`

#### Scenario: Returns null on an unknown action

- **WHEN** `parseStrataPayload('delete:42')` is called
- **THEN** the result is `null`

#### Scenario: Returns null on a non-numeric id

- **WHEN** `parseStrataPayload('commit:abc')` is called
- **THEN** the result is `null`

#### Scenario: Returns null on a missing separator

- **WHEN** `parseStrataPayload('commit_42')` is called
- **THEN** the result is `null`

### Requirement: `buildStrataKeyboard` produces the canonical inline-keyboard layout

The system SHALL export `buildStrataKeyboard(eventId: number, opts?: { showEdit?: boolean }): PluginInteractiveButtons` that returns a single-row keyboard with two or three buttons. `callback_data` for each button is `strata:<action>:<eventId>` so the registered handler's `namespace: 'strata'` strips the prefix automatically.

- 3 buttons (`showEdit !== false`): `[✅ 记录][✏️ 调整][❌ 不记]`.
- 2 buttons (`showEdit === false`): `[✅ 记录][❌ 不记]` — used after a `strata_update_pending_event` already absorbed the user's correction.

#### Scenario: Defaults to 3 buttons

- **WHEN** `buildStrataKeyboard(7)` is called
- **THEN** the result is a single row with 3 buttons whose `callback_data` values are `strata:commit:7`, `strata:edit:7`, `strata:abandon:7`

#### Scenario: Hides the edit button when `showEdit=false`

- **WHEN** `buildStrataKeyboard(7, { showEdit: false })` is called
- **THEN** the result is a single row with 2 buttons (`strata:commit:7`, `strata:abandon:7`)

### Requirement: `handleStrataCallback` routes commit/edit/abandon clicks to the right state transition

The system SHALL export `handleStrataCallback(deps: EventToolDeps): (ctx: PluginInteractiveTelegramHandlerContext) => Promise<void>` such that:

- **`commit:<id>`** calls `commitEventCore(deps, eventId)` and then `ctx.respond.editMessage({ text, buttons: [] })` where `text` is the original message text with `'要记下吗?'` replaced by `'✅ 已记录'` (fallback: `'${summary} ✅ 已记录'` when `messageText` is missing).
- **`abandon:<id>`** transitions the row to `status='abandoned'`, `abandoned_reason='user_declined_via_inline'`, removes it from the buffer (best-effort), then `editMessage` with the keyboard cleared and `'要记下吗?'` replaced by `'❌ 不记'`.
- **`edit:<id>`** clears the keyboard via `editMessage({ buttons: [] })` and replaces `'要记下吗?'` with `'✏️ 等你说要改什么'`. No DB write.
- **Malformed payload** logs at `warn` and returns; no `respond.*` call.
- All branches log at `info` with `{ action, event_id, session_id, chat_id, messageId }`.
- A second click on a row that is no longer `pending` logs at `info` (not `error`) and still calls `editMessage` so the UI converges.

#### Scenario: Commit transitions and edits the message

- **WHEN** a pending `raw_event` `#42` exists in session `s1`, and the handler is called with `ctx.callback.payload='commit:42'` and `ctx.callback.messageText='Blue Bottle 拿铁 ¥45\n\n要记下吗?'`
- **THEN** the row's `status='committed'`, `pendingBuffer.has('s1', 42) === false`, and `ctx.respond.editMessage` was called with `text` containing `'✅ 已记录'` and `buttons: []`

#### Scenario: Abandon stamps the inline reason

- **WHEN** a pending row `#42` is targeted with `ctx.callback.payload='abandon:42'`
- **THEN** the row's `status='abandoned'`, `abandoned_reason='user_declined_via_inline'`, and `ctx.respond.editMessage` was called with `buttons: []`

#### Scenario: Edit clears the keyboard without changing the DB

- **WHEN** a pending row `#42` is targeted with `ctx.callback.payload='edit:42'`
- **THEN** the row is unchanged, `pendingBuffer.has('s1', 42) === true`, and `ctx.respond.editMessage` was called with `buttons: []` and a text containing `'✏️'`

#### Scenario: Double-click commit converges idempotently

- **WHEN** the handler is invoked twice in sequence with `commit:42`
- **THEN** the first call succeeds; the second call does NOT throw to the SDK, `editMessage` is called both times, and the row's `status='committed'`

#### Scenario: Malformed payload is logged and skipped

- **WHEN** the handler is called with `ctx.callback.payload='commit_42'`
- **THEN** a `warn`-level log entry records the malformed payload, no DB write occurs, and `respond.editMessage` is never called

### Requirement: `registerStrataCallbacks` wires the Telegram handler at plugin boot

The system SHALL expose `registerStrataCallbacks(api: OpenClawPluginApi, runtime: StrataRuntime): void` that calls `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata', handler })` exactly once. The handler factory receives the per-callback `ctx`, builds an `EventToolDeps` bag using `ctx.conversationId` as `session_id`, and delegates to `handleStrataCallback(deps)(ctx)`.

The plugin entry's `register(api)` invokes `registerStrataCallbacks` after `registerEventTools`.

#### Scenario: Plugin entry registers the handler exactly once

- **WHEN** `registerStrataCallbacks(api, runtime)` runs against a stub `api`
- **THEN** `api.registerInteractiveHandler` has been called exactly once with `{ channel: 'telegram', namespace: 'strata' }` and a function handler

#### Scenario: The handler closure uses `ctx.conversationId` as session_id

- **WHEN** the registered handler runs with `ctx.conversationId='conv-7'` against a pending row whose `session_id='conv-7'`
- **THEN** `commitEventCore`'s buffer drain removes event `(conv-7, eventId)` from the pending buffer (i.e., the deps closure carries the right session id)
