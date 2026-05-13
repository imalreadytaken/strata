## Decisions

### D1: In-memory registry, not DB-backed

The session registry tracks `AbortController` objects, which aren't serialisable. A DB-backed registry would mean separate "tracking row" vs "controller in memory" — extra complexity for no win, since stop is meaningful only for builds running **in this process**. If the process dies, the build is already dead. So the registry is a plain `Map`; the `builds` table already records the durable state.

### D2: `complete` runs in a `finally`, not at every return path

`strata_run_build` has four terminal return paths (`integrated`, `orchestrator_failed`, `integration_failed`, `cancelled`) plus throws. Wrapping the whole body in `try { … } finally { registry.complete(buildId) }` guarantees deregistration without per-branch bookkeeping. The registry tolerates `complete` on an unknown id (no-op) so the order doesn't matter.

### D3: `not_running` vs `not_found`

When the agent stops a build, three states are interesting:

- `stopped` — controller existed, abort fired.
- `not_running` — the build row exists but it's not in the registry (already completed, or running in a different process).
- `not_found` — no build row with that id.

We surface all three so the agent can compose a useful user-facing message ("build #7 already finished" vs "no such build"). The orchestrator's own `abortIfNeeded` cleans up the cancelled state on the next phase boundary — so the abort returns instantly even though the underlying cancellation is asynchronous.

### D4: No "stop active" or "stop everything" verbs

The agent always knows the `build_id` from `strata_run_build`'s return shape. Adding "stop the only running build" is convenience that hides the implicit-state question (whose build?). If we later add a `strata_list_active_builds` tool, the agent can compose `list → stop` itself.

### D5: AbortController bridged into runBuild AND runIntegration

`runBuild` ends at `ready_for_integration`; `runIntegration` is a separate call that mutates the user's capabilities dir + DB. Stopping should be effective for both. `runIntegration` doesn't currently accept a signal — it's mostly synchronous DB writes — so we let it run to completion when the integration path is reached. The realistic "I want to stop" case is during the long-running plan / decompose / apply phases inside `runBuild`. We document this in the tool description.

### D6: Resume deferred — but not foreclosed

The builds row already carries `claude_session_id` + `phase`, which is everything resume needs. A follow-up `add-build-resume` change will:

1. Add `resume_build_id?: number` to `strata_run_build`'s schema.
2. When set, read the row, skip phases earlier than `row.phase`, and pass `resumeSessionId: row.claude_session_id` through to the in-progress phase.
3. Build state model already has the right column names (`phases.ts:51` already accepts `resumeSessionId`).

This change does NOT change the schema or write a resume tool — that's strictly out of scope.
