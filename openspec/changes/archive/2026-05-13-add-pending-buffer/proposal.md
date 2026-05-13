## Why

The Capture flow leans on a session-scoped "what's currently pending confirmation" set: when a user sends "今天买了 ¥45 咖啡", Strata creates a `pending` `raw_events` row and a follow-up message ("调整为 ¥48 不是 ¥45") needs to land on the right pending row, not create a new one. The agent needs this set:

- to find the pending event when the user follows up
- to time it out if the user wanders off without confirming
- to survive a plugin restart (otherwise pending rows orphan on disk with no in-memory state)

Without it, the `strata_update_pending_event` tool has nothing to look up and `pendingBuffer.add(...)` referenced throughout `STRATA_SPEC.md` §5.3 is unimplemented.

References: `STRATA_SPEC.md` §5.10 (`pendingBuffer` API + timeout loop), §4.1 (`~/.strata/.strata-state/pending_buffer.json`), §5.3.1 (`pendingBuffer.add(...)` call site), §5.3.3 (`pendingBuffer.remove(...)` call site).

## What Changes

- Add `pending-buffer` capability covering:
  - **`PendingBuffer`** class: in-memory `Map<session_id, Set<event_id>>` plus add/has/getAll/remove. The map is the source of truth at runtime.
  - **Disk persistence**: write the buffer JSON-serialized to `<config.paths.dataDir>/.strata-state/pending_buffer.json` after every mutation (cheap — file size is tiny). Load it on construction so a plugin restart picks up where it left off.
  - **`startPendingTimeoutLoop(deps): () => void`**: a `setInterval` (default 60 s) that scans `raw_events` for `status='pending'` rows older than `config.pending.timeoutMinutes`, then:
    - confidence ≥ 0.7 → auto-`commit` (transition status, stamp `committed_at`)
    - confidence  < 0.7 → mark `abandoned`, set `abandoned_reason = 'pending_timeout'`
    The loop removes timed-out events from the in-memory buffer so subsequent follow-ups don't try to reuse them. Returns a stop function (cleared timer + flushed disk state).
  - **Plugin entry wiring**: `register(api)` now also starts the timeout loop and stows the buffer on the runtime so future tools (`strata_create_pending_event` etc.) can call it.

## Capabilities

### New Capabilities
- `pending-buffer`: session-scoped pending event registry with disk persistence and a background timeout loop.

### Modified Capabilities
*(none — uses `message-hooks` runtime + `repositories`)*

## Impact

- **Files added**: `src/pending_buffer/index.ts`, `src/pending_buffer/persistence.ts`, `src/pending_buffer/timeout.ts`, `src/pending_buffer/index.test.ts`, `src/pending_buffer/timeout.test.ts`
- **Files modified**: `src/runtime.ts` (constructs `PendingBuffer`; exposes via `runtime.pendingBuffer`), `src/index.ts` (starts the timeout loop after hooks are installed)
- **Runtime side-effects**: a `setInterval` timer running every 60 s (configurable); writes to `~/.strata/.strata-state/pending_buffer.json` on every mutation
- **Non-goals**: no auto-create of pending events (that's `strata_create_pending_event` next change); no inline-keyboard interactions (`add-callbacks`); no confidence-based prompt re-asking (that's the capture skill, `add-triage-and-capture-skill`)
