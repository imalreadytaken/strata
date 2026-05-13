## Why

`add-event-tools` shipped six tools that mutate `raw_events`, but the user-facing confirmation surface in `STRATA_SPEC.md` §5.5 is an inline keyboard:

```
Blue Bottle 拿铁 ¥45

要记下吗?
[✅ 记录] [✏️ 调整] [❌ 不记]
```

Without a callback handler, those buttons (when they eventually reach the user) would dead-end at the OpenClaw runtime. This change registers a `strata` namespace interactive handler so `commit:42`, `edit:42`, and `abandon:42` callbacks are routed to the right state transition, the user sees an acknowledgement, and the keyboard collapses to a final message.

The handler is the half we can build today; the question of how the inline keyboard reaches the user in the first place is parked (see design.md D1).

References: `STRATA_SPEC.md` §5.5 (callback handler), §5.3.3 (commit core), §5.3.5 (abandon).

## What Changes

- Add `callbacks` capability covering:
  - **`handleStrataCallback(ctx)`**: a `PluginInteractiveTelegramHandlerContext` handler that parses `ctx.callback.payload` (the SDK strips the `strata:` namespace) into `action:event_id`, dispatches one of three transitions, then acknowledges via `ctx.respond.editMessage` or `ctx.respond.clearButtons` so the user sees the result inline.
    - `commit:<id>` → `commitEventCore(deps, eventId)` then `respond.editMessage({ text: previousText + ' ✅ 已记录', buttons: [] })`.
    - `abandon:<id>` → `rawEventsRepo.update(id, { status: 'abandoned', abandoned_reason: 'user_declined_via_inline' })` + pending-buffer remove + `respond.editMessage({ ..., buttons: [] })`.
    - `edit:<id>` → `respond.reply({ text: '当前: …\n要改什么?' })` and clears the keyboard on the original message via `respond.clearButtons()`. The agent's next reply will call `strata_update_pending_event`.
  - **`buildStrataKeyboard(eventId, options)`** helper exporting the canonical 3-button layout. Co-located so the future "send pending confirmation" code path uses the same `callback_data` strings the handler expects.
- **Plugin entry wiring**: `register(api)` now calls `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata', handler })` after `registerEventTools`.

## Capabilities

### New Capabilities
- `callbacks`: Telegram inline-keyboard handler for the `strata` namespace.

### Modified Capabilities
*(none — reads `event-tools::commitEventCore` + writes via `repositories`)*

## Impact

- **Files added**:
  - `src/callbacks/inline_keyboard.ts` — handler + payload parser + `buildStrataKeyboard`.
  - `src/callbacks/index.ts` — `registerStrataCallbacks(api, runtime): void`.
  - `src/callbacks/inline_keyboard.test.ts` — handler unit tests (mocked `ctx.respond`).
  - `src/callbacks/index.test.ts` — registration smoke test (mocked `registerInteractiveHandler`).
- **Files modified**: `src/index.ts` (wires `registerStrataCallbacks(api, runtime)` after the tool registration).
- **Non-goals**:
  - No code path that *sends* the keyboard to the user — that requires a channel-specific outbound surface OpenClaw does not yet expose to plugins. Documented as a known gap; the handler is ready for the day either a runtime hook or a Telegram-specific extension wires it.
  - No Discord/Slack handlers. Their `respond` surfaces differ enough that mirroring is a future change; nothing in this change blocks adding them later.
  - No re-asking on edit. `edit:N` just clears the keyboard and prompts the user; the agent picks up the next inbound message and calls `strata_update_pending_event` normally.
