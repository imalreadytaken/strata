## Context

`STRATA_SPEC.md` §5.10 sketches a `pendingBuffer` object with `add`/`getAll`/`remove` methods plus a `startPendingBufferTimeoutLoop` runner. The spec is intentionally thin — it shows what the call sites need but leaves the persistence and timeout semantics to the implementation. This change locks both down.

The buffer is the runtime side of the same data that lives in `raw_events.status = 'pending'`: a small per-session set of event ids the agent might still extend or correct. Keeping it in memory makes the hot path (every inbound message) O(1) lookups; writing JSON to disk after every mutation keeps it small enough that a crash recovery rebuilds the agent's working set without scanning the whole table.

## Goals / Non-Goals

**Goals:**

- A class (not a module-singleton) so tests can instantiate independent buffers in parallel.
- Disk format `{ session_id: number[] }` — the simplest JSON that fits.
- Timeout loop is testable without real wall-clock waits (inject a `pollEveryMs` override; use `vi.useFakeTimers`).
- Persistence failure NEVER bubbles up: best-effort writes only.
- Buffer is `runtime.pendingBuffer` so future tools (`add-event-tools`) can reach it.

**Non-Goals:**

- No distributed coordination — Strata is single-process. If two OpenClaw gateways ever shared the same DB, both would race on the state file. Documented out-of-scope.
- No async-flush queue (we write synchronously after each mutation). Volumes are tiny: a typical session has 0–3 pending events, and humans confirm them in seconds.
- No automatic confidence calibration on auto-commit. The 0.7 threshold is the same one the spec uses everywhere; tuning is a P7 dogfood concern.
- No structured "pending row also lives in messages_fts" coupling — that's just data the existing FTS5 trigger already handles.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/pending_buffer/index.ts` | new | `PendingBuffer` class — in-memory `Map<string, Set<number>>` + persist-after-mutation, plus barrel re-export of `startPendingTimeoutLoop` |
| `src/pending_buffer/persistence.ts` | new | `readState(file)` / `writeState(file, state)` — JSON shape + atomic write via `fs.writeFileSync(tmp); fs.renameSync` |
| `src/pending_buffer/timeout.ts` | new | `startPendingTimeoutLoop(deps): () => void` — setInterval + per-tick scan + commit/abandon transitions |
| `src/pending_buffer/index.test.ts` | new | Buffer CRUD, persistence round-trip, missing-file boot, unwritable-path swallow |
| `src/pending_buffer/timeout.test.ts` | new | Fake-timer test of the loop — seeds two expired rows (one high-conf, one low-conf), advances time, asserts the transitions |
| `src/runtime.ts` | modified | Boot the buffer (path = `<dataDir>/.strata-state/pending_buffer.json`), expose as `runtime.pendingBuffer` |
| `src/index.ts` | modified | Start the timeout loop after `installMessageHooks`; store the `stop` handle on `runtime` for shutdown semantics |

## Decisions

### D1 — Atomic-write via `tmp + rename`

`fs.writeFileSync(stateFile)` is not atomic; a crash mid-write leaves a half-written JSON file. We instead `writeFileSync(stateFile + '.tmp', json)` then `renameSync(tmp, stateFile)`. POSIX rename is atomic within a filesystem, so a reader on the next boot either sees the old version or the new one — never a torn write.

### D2 — Sync writes are fine

The buffer mutates after every inline-keyboard callback and every pending-event creation — call frequency is human-paced. Sync writes keep the path simple and tests deterministic. If profiling later shows hot writes, P7 can swap in `fsPromises.writeFile`.

### D3 — `startPendingTimeoutLoop` takes a deps bundle, not the whole runtime

Deps are `{ pendingBuffer, rawEventsRepo, config, logger, pollEveryMs?, now? }`. Reason: tests inject a fake `now()` and a tiny `pollEveryMs` and don't need the rest of the runtime. The production wiring in `index.ts` passes the real things.

### D4 — Auto-commit threshold = 0.7 (same as the Capture skill)

Hard-coded in this file as `AUTO_COMMIT_CONFIDENCE_THRESHOLD`. The spec uses 0.7 in §5.10 and §5.4.1 — keeping it identical avoids skew between "would the agent have created this with auto-commit semantics?" and "does the buffer auto-commit it?". Threshold tuning is a P7 dogfood concern; when it changes, it changes in one file.

### D5 — Buffer + DB can drift; DB wins on conflict

If the in-memory buffer says event #5 is pending in session "s1" but `raw_events` has `status='committed'` for that row, the buffer is wrong (perhaps a manual SQL edit). The timeout loop only acts on rows that are STILL `status='pending'` in the DB, so it will not double-commit. The buffer's removal step also happens unconditionally — drift gets reconciled on the next tick.

### D6 — Skipped: replay raw_events on boot

We could also rebuild the buffer at boot by querying `SELECT id, session_id FROM raw_events WHERE status='pending'`. We don't, because:
1. Disk state covers the common case (clean shutdown or crash with persisted state).
2. The timeout loop will pick up any orphans within `pollEveryMs` of boot anyway.
3. Doing both is belt-and-suspenders; we accept a one-tick window for crash-recovery rather than complicating the boot path.

## Risks / Trade-offs

- **State file disk corruption** between mutations: handled by `tmp + rename` (D1). A `JSON.parse` failure on load is treated as "empty buffer" with a warn log — the timeout loop will still rescue any pending DB rows.
- **`setInterval` drift on a busy event loop**: SQLite scans are cheap, the buffer is tiny. Not relevant at our volume.
- **Auto-commit threshold is a magic number**: documented in D4 and pinned to a single constant.
- **Memory growth**: each session keeps a `Set<number>`. If a user has 100k sessions with no committed/abandoned cleanup, memory grows. The timeout loop drains, so steady state is small. We don't add a session-eviction policy.
