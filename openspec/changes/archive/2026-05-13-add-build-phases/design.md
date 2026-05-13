## Context

Each Build Bridge phase is "Claude Code with a specific prompt + a known place to look for output." The runner takes the prompt as `opts.prompt`; the phase wrapper writes the prompt and reads the side-effects.

The phase functions live next to the runner so future phases (apply, verify, archive) can follow the same shape: render template → invoke runner → collect output → return typed result.

## Goals / Non-Goals

**Goals:**
- The runner remains untouched; phases are pure wrappers.
- Prompt rendering is a small helper that uses string substitution (`{{title}}`, `{{summary}}`, `{{rationale}}`, `{{capabilitiesList}}`) so callers can inject context with no template library dependency.
- Each phase result captures both Claude Code's exit code AND the artefacts it produced — the orchestrator decides what counts as "phase succeeded".
- Tests drive both phases with the fake-spawner from `claude_code_runner.test.ts` so we exercise the real runner path without `claude`.

**Non-Goals:**
- No PLAN.md syntax / structure validation. Plans are free-form; the user iterates if Claude wrote junk.
- No change-id format validation. We list directory names; the orchestrator decides if they're valid OpenSpec change ids.
- No automatic plan-iteration. The plan phase is one-shot; the orchestrator can re-run with the previous `sessionId` for a refinement loop in a future change.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/phases.ts` | new | `PlanPhaseResult`, `DecomposePhaseResult`, `runPlanPhase`, `runDecomposePhase`, prompt templates + renderers. |
| `src/build/phases.test.ts` | new | Renderer tests + runner integration tests via the fake-spawner pattern. |
| `src/build/index.ts` | modified | Re-export. |

## Decisions

### D1 — Templates as plain template strings

We avoid `{{mustache}}`/handlebars by using `String.prototype.replace`. The substitutions are a fixed small set; brittleness is acceptable because the templates are pinned by tests.

### D2 — `runPlanPhase` reads `<workdir>/PLAN.md` after exit, with empty-string fallback

If Claude Code didn't write `PLAN.md` (it bailed early, or the prompt was misunderstood), we return `planMd: ''`. The orchestrator can decide to fail the phase, retry, or surface an error to the user. We don't throw — the exit code and event count already convey "the run didn't complete cleanly."

### D3 — `runDecomposePhase` lists `<workdir>/openspec/changes/` and excludes `archive/`

OpenSpec lays new changes alongside `archive/`. We list immediate child dirs and filter out `archive` by name. If a future OpenSpec version uses a different layout, we update the filter.

### D4 — `sessionId` captured from `system` event when present

Claude Code's first `system` stream-json line typically carries `session_id`. We capture it via the `onEvent` hook and return it on the result. Allows the orchestrator to `--resume` a paused build in a follow-up change.

### D5 — Phase results include `stderr` verbatim

Both phases pass through `stderr` from the runner — gives the orchestrator something to log when a phase fails.

### D6 — No dependency on `Workspace` types

The phases take `workdir: string` not `BuildWorkspaceHandle`. Two reasons:

1. Phases can be re-run independently (e.g. a future "apply" phase calls runClaudeCode in the same workdir without needing the original handle).
2. Tests don't need to spin up a real workspace just to test prompt rendering.

The orchestrator threads `handle.workdir` in.

## Risks / Trade-offs

- **Phases as thin shims means the orchestrator owns retry logic.** Acceptable: the orchestrator is the only caller of phases (and the user-facing error reporter).
- **Empty `planMd` on a partial run looks the same as "Claude wrote nothing intentionally."** The orchestrator can distinguish by checking `result.exitCode`; we don't try to be clever.
- **Prompt templates are versioned in source.** Editing a template mid-build affects subsequent runs. Fine: builds are independent.
