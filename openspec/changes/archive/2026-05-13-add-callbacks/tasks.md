## 1. Payload parser

- [x] 1.1 Create `src/callbacks/inline_keyboard.ts` exporting `parseStrataPayload(payload: string): { action: 'commit' | 'edit' | 'abandon'; eventId: number } | null`.
- [x] 1.2 Recognise exactly the three actions; reject unknown actions, non-numeric ids, missing `:`, empty payload — all return `null`.

## 2. Keyboard builder

- [x] 2.1 Export `buildStrataKeyboard(eventId: number, opts?: { showEdit?: boolean }): PluginInteractiveButtons` returning the 3-button layout `[[commit][edit][abandon]]` (or 2-button when `showEdit=false` — `strata_update_pending_event` already updated the row, so on re-prompts after an update we hide the edit button per `STRATA_SPEC.md` §5.3.2 example).
- [x] 2.2 Button text is the spec's exact Chinese strings (`'✅ 记录'`, `'✏️ 调整'`, `'❌ 不记'`). `callback_data` is `strata:<action>:<eventId>` so the registered handler's `namespace: 'strata'` strips the prefix correctly.

## 3. Handler

- [x] 3.1 Export `handleStrataCallback(deps: EventToolDeps): (ctx: PluginInteractiveTelegramHandlerContext) => Promise<void>` — closure over the shared deps bag.
- [x] 3.2 On entry, call `parseStrataPayload(ctx.callback.payload)`. On `null`, log at `warn` with the raw payload and return — the SDK falls through to its default error toast.
- [x] 3.3 `commit` branch:
  - Call `commitEventCore(deps, eventId)`.
  - Wrap in try/catch; if `commitEventCore` throws because the event is no longer pending, log at `info` (double-click) and proceed to the edit-message step anyway.
  - Build the post-commit text: `(ctx.callback.messageText ?? eventSummary).replace('要记下吗?', '✅ 已记录') || `${eventSummary} ✅ 已记录``.
  - Call `ctx.respond.editMessage({ text, buttons: [] })`.
- [x] 3.4 `abandon` branch:
  - Look up the row, refuse if not pending (idempotent double-tap path, log at `info`).
  - `rawEventsRepo.update(eventId, { status: 'abandoned', abandoned_reason: 'user_declined_via_inline', updated_at: now })`.
  - `pendingBuffer.remove(session_id, eventId)` — best-effort.
  - `ctx.respond.editMessage({ text: text.replace('要记下吗?', '❌ 不记'), buttons: [] })`.
- [x] 3.5 `edit` branch:
  - `ctx.respond.editMessage({ text: text.replace('要记下吗?', '✏️ 等你说要改什么'), buttons: [] })`.
  - No DB write — the next inbound message hits `strata_update_pending_event` via the agent.
- [x] 3.6 All branches: log at `info` with `{ action, event_id, session_id, chat_id, messageId }`.

## 4. Registration

- [x] 4.1 Create `src/callbacks/index.ts` exporting `registerStrataCallbacks(api, runtime): void` that calls `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata', handler: handleStrataCallback(buildDeps(runtime, ctx.conversationId)) })`. Use `ctx.conversationId` as the session_id for the deps closure.
- [x] 4.2 Modify `src/index.ts`: import and call `registerStrataCallbacks(api, runtime)` immediately after `registerEventTools(api, runtime)`. Update the doc comment about P2 milestones.

## 5. Tests

- [x] 5.1 `src/callbacks/inline_keyboard.test.ts`:
  - `parseStrataPayload` table-driven cases: 6+ valid / 5+ invalid.
  - `buildStrataKeyboard`: 3-button vs 2-button shapes; callback_data is `strata:<action>:<eventId>`.
  - Handler `commit` path: seeds a pending event via the create tool, simulates a callback ctx with hand-rolled `respond.editMessage = vi.fn()`, asserts DB transition + buffer drain + editMessage called with `buttons: []`.
  - Handler `abandon` path: same shape, asserts `abandoned_reason='user_declined_via_inline'`.
  - Handler `edit` path: clears keyboard, no DB change, no buffer change.
  - Handler unknown action: logs warn, no respond call.
  - Handler double-commit: second click logs info, still calls editMessage with `buttons: []`.
- [x] 5.2 `src/callbacks/index.test.ts`: stub `api.registerInteractiveHandler`, assert it was called exactly once with `{ channel: 'telegram', namespace: 'strata', handler: fn }`.

## 6. Integration

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm test` — all tests pass.
- [x] 6.3 `openspec validate add-callbacks --strict`.
