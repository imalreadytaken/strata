## Context

The orchestrator owns the build state machine. Per `builds` table CHECK constraint, valid phases are `plan | decompose | build | integrate | post_deploy | done | failed | cancelled | paused`. This change drives `plan → decompose → build → integrate`; integration + post_deploy + done live in the next change.

Every Build Bridge phase + dependency is already shipped. The orchestrator is **pure coordination** — taking the building blocks and sequencing them with row updates between each step.

## Goals / Non-Goals

**Goals:**
- `runBuild` is the single public entrypoint. It updates the `builds` row between phases so a `phase='integrate'` row means "ready for the integration phase to run."
- Every phase runner is injectable via `PhaseRunner`. Default values use the real `runPlanPhase` / `runDecomposePhase` / `runValidationChecks` / `setupBuildWorkspace`. Tests pass mocks.
- The orchestrator never throws on phase failures — it transitions to `failed` and returns `{ status: 'failed', failureReason }`. The only thrown errors are programming bugs / DB failures.
- `AbortSignal` flips the build to `cancelled` and short-circuits subsequent phases.

**Non-Goals:**
- No multi-pass apply with validation feedback. The orchestrator records the first validation report and either proceeds (ok) or fails (not ok). A re-apply loop is a P5 improvement.
- No structured per-phase progress events. The orchestrator emits a small set of well-known events via the supplied `progressForwarder.onPhase(...)` (a new optional method on the forwarder we wire in this change).
- No reading or writing to the `proposals` table after the initial lookup. The integration phase (next change) is what marks proposals `applied`.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/orchestrator.ts` | new | `runBuild`, `runApplyPhase`, types. |
| `src/build/orchestrator.test.ts` | new | Happy + failure cases with mocked phase runners + a real DB. |
| `src/build/progress_forwarder.ts` | modified | Adds optional `onPhase(name: string): void` method — emits a synthetic prefix line on phase transitions. |
| `src/build/index.ts` | modified | Re-exports. |

## Decisions

### D1 — `runBuild` returns a `BuildRunResult`, never throws on phase failure

The caller is the IM-side handler. Throwing forces them to wrap; returning a tagged union is cleaner. The only throwable conditions are:

- DB write failures (treat as unhandled — caller's `try` catches).
- A programming bug (`RunBuildOptions` missing required dep).

### D2 — Phase boundaries write `builds` rows

After `setupBuildWorkspace`: `phase='plan'`, `workdir_path=workdir`.
After successful plan: `phase='decompose'`, `plan_path=workdir/PLAN.md`, `claude_session_id=<from plan>`.
After successful decompose: `phase='build'`, `changes_total=N`.
For each apply: `current_change_id=<id>`; after apply+validate ok: `changes_done++`.
Final success: `phase='integrate'`.
Failure: `phase='failed'`, `failure_reason=<one-line>`.
Cancel: `phase='cancelled'`, `failure_reason='aborted by caller'`.

Each write also stamps `last_heartbeat_at = now()`.

### D3 — `runApplyPhase` is a separate exported function

Even though it's a thin wrapper, exporting it lets tests stub the apply phase independently of plan/decompose. Mirrors the phase-functions convention.

### D4 — Validation runs in-process against the workdir

`runValidationChecks` is called once per change. We pre-compute `changeId` (from `decompose` output) and `capabilityName` (parsed from `meta.json` written into the workdir by the apply phase). If the workdir's `capabilities/<X>/v1/meta.json` doesn't exist after apply, the check returns a finding ("apply phase did not produce a capability dir") and the build fails.

### D5 — `failureReason` is a short tagged string

Codes:
- `plan_empty` — `runPlanPhase` returned `planMd === ''`.
- `decompose_empty` — `changeIds.length === 0`.
- `apply_failed_<changeId>` — runner exited non-zero.
- `validation_failed_<changeId>` — `runValidationChecks` returned `ok: false`.
- `aborted` — AbortSignal fired.

The full validation report is in `result.validationReports[changeId]`; the IM caller surfaces the codes + finding messages to the user.

### D6 — Default `progressForwarder.onPhase(name)` emits `📍 phase: <name>`

Optional method — `onPhase?` on `BuildProgressForwarder`. The orchestrator calls it before each phase; if the forwarder doesn't implement it, no-op. Lets the user see "📍 phase: plan" → "📍 phase: decompose" alongside the per-event noise.

### D7 — `applyPhasePromptTemplate` is `'/opsx:apply <changeId>'`

A literal `/opsx:apply <changeId>` command in Claude Code triggers the apply flow OpenSpec ships. We don't add prose around it because the change directory already contains its own `tasks.md` / `proposal.md` / `design.md` for Claude to read.

## Risks / Trade-offs

- **No retry on validation failure** means flaky apply runs cost a full re-orchestration. Acceptable for V1; retry loop lands when we have dogfood data.
- **A long-running plan phase can hide a hung subprocess.** We expose `signal` from the caller; the orchestrator hands it to every `runClaudeCode` call so a user-facing cancel propagates.
- **Validation report can grow large** for a multi-change build. We keep it in memory + return; persisting to disk is left to the caller.
