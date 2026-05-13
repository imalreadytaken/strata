## Context

`STRATA_SPEC.md` §5.5 sketches `handleInlineKeyboard(api, callback)` that reads `callback.data` (raw `strata:commit:42`), parses it, calls `commitEventCore(eventId, api)`, then `api.callback.answer(...)` and `api.channel.editMessage(...)`. The shape doesn't match `openclaw@2026.3.23`:

- The OpenClaw surface is `api.registerInteractiveHandler({ channel, namespace, handler })`.
- The handler receives a typed `PluginInteractiveTelegramHandlerContext` whose `ctx.callback.payload` is the part **after** the registered namespace — so for `data='strata:commit:42'` we see `payload='commit:42'`, no manual `startsWith('strata:')` check needed.
- Editing the message goes through `ctx.respond.editMessage({ text, buttons })` (buttons cleared by passing `[]`) and `ctx.respond.clearButtons()`. There is no `api.callback.answer(...)` (Telegram's "answerCallbackQuery" toast is handled by the SDK).
- `commitEventCore` exported from `add-event-tools` takes `(deps, eventId)`, not `(eventId, api)`.

This change locks in the namespace-based design and documents the one architectural deferral: actually *sending* the inline keyboard to the user requires an outbound surface the SDK doesn't expose to plugins (D1).

## Goals / Non-Goals

**Goals:**
- One `handleStrataCallback(deps): (ctx) => Promise<void>` factory that closes over the same `EventToolDeps` bag the event tools use — same source of truth, no parallel wiring.
- Payload parser is its own exported function (`parseStrataPayload`) so test cases cover malformed inputs without spinning up a full mock `ctx`.
- The handler logs every action at `info` level with `action`, `event_id`, `chat_id`, `messageId` — Strata needs an audit trail for "what did the user click".
- `buildStrataKeyboard(eventId, options)` produces the canonical 3-button layout (`commit` / `edit` / `abandon`) so any future "send pending confirmation" code path uses the same `callback_data` strings the handler expects.

**Non-Goals:**
- No new SDK surface for "send a message with inline keyboard from a tool" — see D1.
- No reuse across Discord/Slack. Their `respond` shapes differ; a future change can add per-channel registrations sharing `parseStrataPayload` + `commitEventCore`.
- No "user clicked the wrong event id" recovery. A click on a stale callback (e.g., event already committed) surfaces the tool's existing "not in pending state" error to the SDK; we let the SDK render the default error toast.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/callbacks/inline_keyboard.ts` | new | Exports `parseStrataPayload(payload): { action, eventId } \| null`, `handleStrataCallback(deps): (ctx) => Promise<void>`, `buildStrataKeyboard(eventId, opts): PluginInteractiveButtons`. |
| `src/callbacks/index.ts` | new | `registerStrataCallbacks(api, runtime): void` — wraps `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata', handler })`. |
| `src/callbacks/inline_keyboard.test.ts` | new | Handler unit tests with a hand-rolled `ctx`. |
| `src/callbacks/index.test.ts` | new | Registration smoke test. |
| `src/index.ts` | modified | Call `registerStrataCallbacks(api, runtime)` after `registerEventTools`. |

## Decisions

### D1 — Skipped: sending the keyboard from a tool

`STRATA_SPEC.md` §5.3.1 has `strata_create_pending_event` calling `api.channel.send({ text, inlineKeyboard })`. The shipped `OpenClawPluginApi` has no `channel.send` surface, and `PluginInteractiveButtons` only appears inside `ctx.respond.*` — i.e., it's only sendable as a response to an existing interactive callback. There is no public path to send a fresh message + buttons from a tool's `execute(...)`.

We resolve this by:

1. Building the *handler* now (this change). It is callable the moment the SDK gains an outbound surface (or a Telegram-specific extension hooks into Strata).
2. Exporting `buildStrataKeyboard(eventId)` so the future sender, wherever it lives, uses the same `callback_data` strings the handler expects.
3. Leaving `strata_create_pending_event` unchanged. Its agent-text reply already asks "记一下吗?" — the user's natural-language "yes/no" hits `strata_commit_event` / `strata_abandon_event` through the regular tool path.

This is a real spec/SDK gap. Documented here, in proposal.md "Non-goals", and called out in the next change's design.md so the capture skill prompt acknowledges that buttons may not be present.

### D2 — `namespace: 'strata'` registration strips the prefix automatically

The SDK's `registerInteractiveHandler({ namespace: 'strata', handler })` only fires the handler when `callback.data.startsWith('strata:')`, AND `ctx.callback.payload` is the substring *after* `strata:` — i.e. `commit:42`. We therefore parse `<action>:<event_id>` from the payload and skip the spec's manual `startsWith` check.

Side-benefit: a future namespace bump (`strata-v2`) is a 1-line registration change with no impact on payload parsing.

### D3 — `parseStrataPayload` returns `null` on malformed input

Two failure modes are common:
1. **Wrong shape** — `commit_42` (underscore), `strata:commit:42` (caller forgot the namespace strip), `commit:abc` (non-numeric id).
2. **Unknown action** — `delete:42`, `cancel:42`.

Both return `null`. The handler logs at `warn` and exits without throwing. The SDK uses the absence of explicit handling as a signal to fall through to its default error toast (same UX the user gets for any malformed callback).

### D4 — `edit:N` clears buttons + prompts; does NOT pre-fill the pending event

The spec's `case 'edit'` calls `api.channel.send({ text: 'current: ... / 要改什么?' })` then expects the agent's next reply to do the update. Implementing this here would require an outbound surface (per D1), so we instead:

- Edit the original message via `ctx.respond.editMessage({ text: messageText + ' ✏️ 等你说要改什么', buttons: [] })`.
- Trust the existing `pending_buffer` + `strata_update_pending_event` flow to pick up the user's next message.

Net effect for the user is identical: keyboard collapses, agent waits for "改成 ¥48" or similar.

### D5 — `abandon` via inline keyboard reuses `abandonEventCore`-style logic, inlined here

The `add-event-tools` change exported `commitEventCore` but kept abandon as a private helper inside the tool file. We could either:

- (a) Export an `abandonEventCore` from `event-tools` and call it here.
- (b) Inline the 3-line transition + buffer-remove in this callback.

We pick (b) because the inline-keyboard abandon needs a *different* `abandoned_reason` (`'user_declined_via_inline'` vs the tool's `'user_declined'`) — the audit trail wants to distinguish a click from a textual "no". Carving out an `abandonEventCore` would add a parameter solely for this discrimination; inlining keeps both call sites self-documenting.

### D6 — Idempotency on accidental double-tap

Users on slow networks sometimes double-tap buttons. If both clicks land:

- First commit: pending → committed (success).
- Second commit: throws `'not in pending state'`.

The handler catches the second throw, logs at `info` (not `error` — it's not a failure), and re-issues the same `editMessage` so the UI converges to the post-commit state. Same logic for `abandon`. We test this case explicitly.

## Risks / Trade-offs

- **D1 means buttons-to-user is shimless today.** Risk: someone reads the handler code and assumes the flow is end-to-end. Mitigation: the proposal's "Non-goals" calls this out, and the next change's skill prompt explicitly says "ask the user yes/no in text — buttons may not be visible".
- **`commitEventCore` failures bubble up to the SDK.** Acceptable: the SDK renders a default error toast, which is the right UX when (e.g.) the row got abandoned by a timeout between the keyboard render and the click.
- **`messageText` from Telegram may be missing.** The spec assumes we can `replace('要记下吗?', '✅ 已记录')`. Telegram doesn't always send the original message text. We fall back to `${eventSummary} ✅ 已记录` — guarantees a valid edit and avoids template surprise.
