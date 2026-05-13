## Why

The detector + proposal layers are pure functions. Reflect Agent isn't *running* until something fires them on a schedule and gives the user a way to respond. This change wires those three pieces:

1. **`runReflectOnce(deps)`** — one-shot orchestrator: scan → detect (emergence + evolution + decay) → generate proposals → push to user. Pure, testable, no timers.
2. **`startReflectAgent(deps)`** — sets up the weekly schedule (default Sunday 03:00 user time). Returns `stop()` for shutdown.
3. **`handleReflectCallback(deps)`** — Telegram interactive handler under namespace `strata-propose`. Parses `approve:<id>` / `decline:<id>` (and an optional `defer:<id>` for "ask me later"). Updates the `proposals` row + clears the inline keyboard.

The plugin entry installs all three when the runtime boots; the cron's `stop` handle is stowed on the runtime so a future shutdown path can clean up.

References: `STRATA_SPEC.md` §5.7 (`startReflectAgent` + `cron` schedule + push), §5.5 (callback handler pattern reused).

## What Changes

- Add `reflect-cron` capability covering:
  - **`runReflectOnce(deps): Promise<ReflectRunResult>`** — calls each detector, calls `generateProposals`, calls `pushProposalsToUser`. Returns `{ signals, inserted, skipped }` for telemetry.
  - **`startReflectAgent(deps, opts?): () => void`** — `setInterval` (default 1h tick) checking "now is within the Sunday 03:00-04:00 hour window AND we haven't fired yet this week." `opts.intervalMs` + `opts.now` injectable for tests; `opts.schedule.dayOfWeek` + `.hour` overrideable.
  - **`handleReflectCallback(deps)`** — interactive handler. `approve:<id>` → `status='approved'`, `responded_at=now`. `decline:<id>` → `status='declined'`, `responded_at=now`, `cooldown_until=now+30d`. Both edit the original message to acknowledge.
  - **Plugin entry wiring**: `register(api)` calls `startReflectAgent` AND `api.registerInteractiveHandler({ channel: 'telegram', namespace: 'strata-propose', handler })`. The runtime gains a `stopReflect: () => void` field.

## Capabilities

### New Capabilities
- `reflect-cron`: weekly timer + approve/decline callback for the Reflect Agent.

### Modified Capabilities
*(none — uses detectors + proposals layers without changes)*

## Impact

- **Files added**:
  - `src/reflect/runner.ts` — `runReflectOnce`, `ReflectRunResult`.
  - `src/reflect/cron.ts` — `startReflectAgent`.
  - `src/reflect/callback.ts` — `parseReflectPayload`, `handleReflectCallback`, `buildReflectKeyboard`.
  - `*.test.ts` matching files.
- **Files modified**:
  - `src/runtime.ts` — `StrataRuntime.stopReflect?: () => void`.
  - `src/index.ts` — installs the cron + callback handler after the existing wiring.
  - `src/reflect/index.ts` — re-exports.
- **Non-goals**:
  - No build trigger on `approved`. The next change (`add-build-trigger`) listens for newly-approved proposals (or accepts an explicit tool call) and dispatches `runBuild`.
  - No archive-execution on approved `capability_archive` proposals. Same reason — wire-up in a follow-up.
  - No Discord/Slack callback registration. `strata-propose` lives only on Telegram for V1.
  - No `defer:<id>` push-to-later UX (the row supports `cooldown_until` but we don't need a third button right now).
