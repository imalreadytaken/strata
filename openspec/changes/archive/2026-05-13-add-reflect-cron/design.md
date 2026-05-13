## Context

The two prior changes built the Reflect machinery as pure functions. This one is the **scheduler** + **user-response handler**. Both are operationally simple if we resist the urge to over-engineer.

The cron: we tick every hour, ask "is now within the user's Sunday 03:00 window?", and fire once per window. Tracking "did we already fire this week?" via the most-recent `created_at` on `proposals WHERE source='reflect_agent'` keeps state in the DB, not in process memory. (Lost on restart-but-still-within-the-window means a duplicate run; dedup at the proposals layer absorbs it.)

The callback: a sibling namespace `strata-propose` so it doesn't have to coexist with the `strata` event-tool callbacks' parser. Same SDK pattern.

## Goals / Non-Goals

**Goals:**
- `runReflectOnce` is the single composable entry point; tests run it with seeded data and no timers.
- `startReflectAgent` is testable with `vi.useFakeTimers` + an injected `now()`.
- The callback handler is symmetric in shape to `add-callbacks`'s commit/abandon handler — same `editMessage` cleanup, same error-swallowing semantics.
- Plugin wiring is two new calls in `register(api)`; the cron's stop handle goes on the runtime so a future shutdown path can call it.

**Non-Goals:**
- No catch-up runs after a long downtime. If Strata was offline for two Sundays in a row, we only fire once on the next tick (the dedup is the proposals table, not the cron).
- No timezone math beyond reading `Intl.DateTimeFormat().resolvedOptions().timeZone` as a sanity check. We compute "weekday + hour" from `new Date()` and trust the OS time zone.
- No persistence of `lastFireAt` in a dedicated row. We use the most-recent proposal row's timestamp as the de-facto signal.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/reflect/runner.ts` | new | `runReflectOnce`, `ReflectRunDeps`, `ReflectRunResult`. |
| `src/reflect/cron.ts` | new | `startReflectAgent`, schedule helpers. |
| `src/reflect/callback.ts` | new | `parseReflectPayload`, `handleReflectCallback`, `buildReflectKeyboard`. |
| `src/reflect/runner.test.ts`, `cron.test.ts`, `callback.test.ts` | new | Unit tests. |
| `src/runtime.ts` | modified | `StrataRuntime.stopReflect`. |
| `src/index.ts` | modified | Boot the cron + register the interactive handler. |
| `src/reflect/index.ts` | modified | Re-exports. |

## Decisions

### D1 — Hour-bucket fire window

The cron fires once per week within a one-hour window (default Sunday 03:00–04:00 local). The check inside the interval:

```ts
const d = now();
if (d.getDay() !== schedule.dayOfWeek) return;  // 0=Sun
if (d.getHours() !== schedule.hour) return;
if (await alreadyFiredThisWeek(now)) return;
await runReflectOnce(deps);
```

`alreadyFiredThisWeek` = "any `proposals` row with `source='reflect_agent'` AND `created_at` within the past 6 days." Conservative; keeps the cron from firing repeatedly when the user starts Strata mid-window.

### D2 — Default tick interval = 1 hour; tests use 1ms

`setInterval(check, 3_600_000)` for production. Tests pass `intervalMs: 1` + `now: () => fixedDate` and advance fake timers to assert fire timing.

### D3 — Approve flips the proposal status; nothing else

`approve:<id>` → `update(id, { status: 'approved', responded_at: now })`. No build dispatch — that's the next change. The user sees "✅ approved — Build Bridge will pick this up when shipped" until B lands.

### D4 — Decline sets a 30-day cooldown

`decline:<id>` → `update(id, { status: 'declined', responded_at: now, cooldown_until: now + 30 days })`. The `cooldown_until` blocks the proposal generator from re-emitting the same signal until the cooldown expires (per `add-reflect-proposals` D2).

### D5 — `strata-propose` namespace

Separate from `strata` so the existing event-tool callback parser doesn't have to learn proposal payloads. SDK handles the routing for free.

### D6 — `runReflectOnce` runs detectors sequentially, not in parallel

Each detector is small but reads the DB. Sequential reduces SQLite lock contention; parallel buys nothing.

## Risks / Trade-offs

- **Cron fire is approximate** — we check the hour, not the minute. Real fire happens within ~1h of the schedule. Fine for a weekly task.
- **"Already fired this week" is a heuristic.** If the user manually inserts a `reflect_agent` proposal mid-week, the cron skips that week. Acceptable; manual insertion is a power-user move.
- **No retry on transient failure** inside `runReflectOnce` — a failed run is logged and the next week's tick is the next chance. The proposals layer's dedup handles the resumed state.
