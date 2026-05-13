## Why

The Capture loop now has both a runtime side (`pending-buffer`) and a database side (`raw_events`), but no surface the agent can call. The skill (next change) will instruct the LLM "when the user shares a fact, call `strata_create_pending_event`," and right now that tool doesn't exist. Five sibling tools (`update`, `commit`, `supersede`, `abandon`, `search`) round out the state machine on the `raw_events` ledger that `STRATA_SPEC.md` §5.3 enumerates.

Without these tools, the system can persist messages and run a timeout loop on pending rows, but the agent has no way to *create* a pending row, *correct* it, *commit* it, or *find* a past one when the user revisits it across sessions.

References: `STRATA_SPEC.md` §5.3.1–§5.3.5 (per-tool specs), §3.1 `raw_events` DDL, §5.10 pending-buffer hand-off.

## What Changes

- Add `event-tools` capability covering six agent tools, all registered through `api.registerTool(...)` at `register()` time:
  - `strata_create_pending_event` — INSERT a `pending` `raw_events` row, add it to `pending_buffer`, return `{ event_id, status: 'awaiting_confirmation', summary }`.
  - `strata_update_pending_event` — merge a `patch` into `extracted_data`, append the follow-up message id to `related_message_ids`, optionally replace `source_summary`. Refuses if the row is not `status='pending'`.
  - `strata_commit_event` — transitions `pending → committed`, stamps `committed_at`, removes the event from the buffer. The implementation lives in `commitEventCore(...)` so the inline-keyboard callback (next change) can reuse it.
  - `strata_supersede_event` — for cross-session corrections. INSERTs a new `committed` row with `supersedes_event_id = old.id`, then transitions the old row to `status='superseded'`, `superseded_by_event_id = new.id`. The two writes happen inside a `repo.transaction(...)` so a crash never leaves a half-superseded chain.
  - `strata_abandon_event` — transitions `pending → abandoned`, stamps `abandoned_reason`, removes from the buffer. Symmetrical to `commit`.
  - `strata_search_events` — LIKE-based filter over `source_summary` plus optional `event_type` / `status` / time range. Returns the top N matches ordered newest-first.
- Wire the tool factory into `register(api)` in `src/index.ts` so OpenClaw discovers all six on plugin load.

## Capabilities

### New Capabilities
- `event-tools`: six `strata_*` agent tools that drive the `raw_events` state machine and the pending buffer.

### Modified Capabilities
*(none — reads `repositories` + mutates via `pending-buffer`)*

## Impact

- **Files added**: `src/tools/create_pending_event.ts`, `src/tools/update_pending_event.ts`, `src/tools/commit_event.ts`, `src/tools/supersede_event.ts`, `src/tools/abandon_event.ts`, `src/tools/search_events.ts`, `src/tools/index.ts` (barrel + `registerEventTools` factory), plus a matching `*.test.ts` per tool.
- **Files modified**: `src/index.ts` (registers the tool factory after the pending-buffer loop starts).
- **Non-goals**:
  - No inline-keyboard rendering — `strata_create_pending_event` does NOT call `api.channel.send`. The Telegram inline-keyboard side-channel is the next change (`add-callbacks`) and will hook the `message_sending` lifecycle.
  - No vector search — `strata_search_events` does FTS-style LIKE only; embedding-based retrieval lands once the embedding worker exists in P6.
  - No business-table writes — `commit` does not run a capability pipeline yet (pipeline runner is P3). It leaves `capability_name` / `business_row_id` intact on the row and a downstream pipeline will pick the row up.
