## Why

Strata's most basic guarantee is that **no IM message is ever lost** — every line a user types and every line the assistant emits goes into the `messages` table verbatim. The Capture flow, Reflect Agent, Build Bridge, and Query skill all read from this table. Until the hooks are wired, all those downstream phases have nothing to read.

The hooks are also the first place Strata touches the OpenClaw plugin SDK — they validate that our P1 plumbing actually loads inside the OpenClaw runtime, that the plugin entry stub from P0 picks up the right API, and that hook handlers compile against the real types.

References: `STRATA_SPEC.md` §5.2 (`onUserMessage`), §5.1 (plugin entry), §3.1 `messages` schema; OpenClaw plugin-sdk types for `message_received` / `message_sent`.

## What Changes

- Add `message-hooks` capability covering:
  - **`installMessageHooks(api, deps)`**: registers two OpenClaw lifecycle hooks (`message_received` → user role, `message_sent` → assistant role) that map the OpenClaw event shape into a `MessageRow` insert.
  - **`PluginRuntime`** wiring: extend `src/index.ts`'s `register(api)` to open the database (lazy, once), apply system migrations, instantiate the `MessagesRepository`, and call `installMessageHooks`. Other phases (P2 tools, P2 buffer, P3 capabilities) will hang their own registrations off the same `register(api)` chain.
  - Background `computeEmbedding` stub: the spec calls for async vector indexing on every message; until P5 brings a real embedding worker we land an explicit `null` write-back path and a TODO marker. The hook does NOT block on embedding.

## Capabilities

### New Capabilities
- `message-hooks`: OpenClaw `message_received` / `message_sent` registrations that persist every message to the `messages` table, set the right `role`, increment `turn_index`, and never block the agent on persistence failure.

### Modified Capabilities
*(none)*

## Impact

- **Files added**: `src/hooks/messages.ts`, `src/hooks/index.ts`, `src/runtime.ts` (boot helper), `src/hooks/messages.test.ts`
- **Files modified**: `src/index.ts` (register wires runtime + hooks)
- **Runtime side-effects**: when OpenClaw loads the plugin, it opens `~/.strata/main.db`, applies the eight system migrations idempotently, and registers two hooks
- **Non-goals**: no triage / capture skill (next change); no tool execution; no callback handling; no inbound-claim hook (Strata doesn't claim messages — they go to the agent normally); no embedding generation; no FTS5 query helpers
