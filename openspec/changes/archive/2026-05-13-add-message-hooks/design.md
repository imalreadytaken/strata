## Context

This is the first change that touches the real OpenClaw plugin SDK. P0–P1 worked entirely below the SDK boundary (config, logging, DB, migrations, repositories). Now we need to:

- subscribe to the `message_received` and `message_sent` lifecycle events
- map OpenClaw's event shape to our `MessageRow` shape
- boot a singleton "runtime" (open DB, run migrations, instantiate repositories) the first time `register(api)` is called

The OpenClaw plugin SDK in `node_modules/openclaw/dist/plugin-sdk/`:

- `api.on(hookName, handler)` registers a lifecycle handler
- `hookName` includes `message_received` (handler signature: `(event: { from, content, timestamp?, metadata? }, ctx: { channelId, accountId?, conversationId? }) => Promise<void> | void`) and `message_sent` (`event: { to, content, success, error? }`)
- `api.logger` is a `PluginLogger` (info/warn/error). We keep using our own Strata logger for richer JSON structure — OpenClaw's logger is used only for setup failures before our logger exists.

## Goals / Non-Goals

**Goals:**

- A pure, testable `installMessageHooks(api, deps)` function so we can unit-test the handler logic against a mock `OpenClawPluginApi`.
- A `bootRuntime()` helper that is idempotent — calling it twice (during tests, hot reloads, or two-plugin instances) doesn't open the DB twice or re-run migrations.
- The hooks NEVER block the agent: a DB write failure is logged and swallowed.
- Test coverage: every requirement scenario from `specs/message-hooks/spec.md` has a corresponding Vitest case.

**Non-Goals:**

- No tools, callbacks, or skills — the agent still works without Strata, it just doesn't persist anything yet. Those land in the next four P2 changes.
- No embedding generation — the field stays `NULL` for now. P5 brings the worker.
- No FTS / search wrappers around `MessagesRepository`.
- No structured handling of non-text content types (audio, image, callback). They all get `content_type = 'text'` until a later change adds proper inference.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/runtime.ts` | new | `bootRuntime(api)` — open DB + apply migrations + build repositories; module-level memoisation makes it idempotent. Returns `StrataRuntime`. |
| `src/hooks/messages.ts` | new | `installMessageHooks(api, deps)` and the two handlers; pure functions of the deps. |
| `src/hooks/index.ts` | new | Barrel — exports `installMessageHooks`. |
| `src/hooks/messages.test.ts` | new | Vitest with a hand-rolled mock `OpenClawPluginApi`. Covers every spec scenario. |
| `src/index.ts` | modified | `register(api)` now calls `bootRuntime` and `installMessageHooks`. Plugin manifest unchanged. |

## Decisions

### D1 — `bootRuntime` is module-level memoised, not a singleton class

A `let cached: StrataRuntime | undefined` at module top — first call populates, subsequent calls return the same value. Simpler than a class with a `static getInstance()`; matches Node's natural ESM module-singleton-by-default semantics.

### D2 — One hook install function, not two

`installMessageHooks` wires both `message_received` and `message_sent` because they share dependencies (the same `MessagesRepository` and `Logger`). A `installInboundHook` + `installOutboundHook` split would force callers to inject the deps twice.

### D3 — Session-id resolution: `ctx.conversationId` first, then `<channel>:<from>`

OpenClaw conversations are grouped by `conversationId` (a stable string for a chat). When the SDK is configured to group differently (e.g. one conversation per user across channels), `conversationId` may be empty. We fall back to a synthetic `<channelId>:<from>` so every message still hashes to a deterministic session, and the user can never produce a `NULL session_id`.

### D4 — Persistence failure is swallowed, not propagated

The contract is "never block the agent." A failed `INSERT INTO messages` is logged at `error` level with the relevant context (`session_id`, `channelId`, `code`, `message`) and the hook returns normally. Reflect Agent's job is to notice persistent ingestion failures later (P5).

### D5 — `event.success === false` skips writing

When the SDK reports the outbound message failed (transport error, channel timeout, ...), no row is inserted because the user never actually saw that content. Logging a `debug`-level entry preserves auditability while keeping the transcript honest.

### D6 — Unit tests use a hand-rolled mock `OpenClawPluginApi`

We do NOT take a runtime dependency on the real OpenClaw gateway for tests. A tiny mock that records `on(hookName, handler)` calls and lets the test fire the handler directly is sufficient and 1000× faster than a real-runtime integration test. A future end-to-end test against a real gateway lives outside this change.

## Risks / Trade-offs

- **`bootRuntime` memoisation breaks if `loadConfig()` should re-read on file change**: it currently does not — config is read once at plugin load. Users who edit `~/.strata/config.json` need to restart the OpenClaw gateway. Documented; no SIGHUP handler yet.
- **`event.timestamp` parsing assumes ms epoch**: the OpenClaw type is `timestamp?: number`. If `number` ever means seconds in some other channel adapter, `new Date(timestamp)` would produce nonsense. Mitigation: default to `Date.now()` when the parsed date's `getFullYear()` is wildly outside the expected range. We do not implement this yet — flagged as future hardening.
- **No back-pressure**: if the DB stalls (file lock contention), inserts could queue. better-sqlite3 has a `busy_timeout` (5s) which gives us a coarse limit. After 5s the insert throws, we log, and we move on — message is lost to disk but the agent stays responsive.
