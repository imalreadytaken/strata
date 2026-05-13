## Why

`runClaudeCode` knows how to launch Claude Code but doesn't know **why** — every build phase needs its own prompt template and its own "what counts as success" rule. Two phases sit between the proposal and the actual code generation:

1. **plan_phase** — turn a user's `proposals` row into an approved `PLAN.md`. Spawns Claude Code with `mode='explore'` and a template instructing it to write `<workdir>/PLAN.md`. We read that file back after the run.
2. **decompose_phase** — turn an approved PLAN.md into a list of OpenSpec changes. Spawns Claude Code with `mode='propose'` and a template instructing it to write changes under `<workdir>/openspec/changes/`. We list those after the run.

Both phases stay deliberately thin: prompt template + invoke runner + collect output. They take the workspace from `setupBuildWorkspace` and the runner from `claude-code-runner`; they don't know about validation or integration (later changes).

References: `STRATA_SPEC.md` §5.8.1 (plan_phase / `/opsx:explore`), §5.8.2 (decompose_phase / `/opsx:propose`), §7.4 (decompose prompt).

## What Changes

- Add `build-phases` capability covering:
  - **`PlanPhaseResult`** = `{ planMd: string; sessionId: string | null; exitCode: number; eventCount: number; stderr: string }`.
  - **`runPlanPhase(opts): Promise<PlanPhaseResult>`** — wraps `runClaudeCode({ mode: 'explore', prompt: <PLAN_PROMPT_TEMPLATE rendered with proposal>, workdir, maxTurns, onEvent, …})`. After the run, reads `<workdir>/PLAN.md` and returns the contents (empty string when missing — caller decides what to do).
  - **`DecomposePhaseResult`** = `{ changeIds: string[]; exitCode: number; eventCount: number; stderr: string }`.
  - **`runDecomposePhase(opts): Promise<DecomposePhaseResult>`** — wraps `runClaudeCode({ mode: 'propose', prompt: <DECOMPOSE_PROMPT_TEMPLATE>, …})`. After the run, lists `<workdir>/openspec/changes/*/` (excluding `archive/`) and returns the directory names.
  - **`PLAN_PROMPT_TEMPLATE`** and **`DECOMPOSE_PROMPT_TEMPLATE`** — exported constants. The decompose template carries the §7.4 text verbatim; the plan template is a clean rendering of the §5.8.1 sketch. Both are template-string-shaped (`{{title}}`, `{{summary}}`, etc.) and have a `renderPlanPrompt(...)` / `renderDecomposePrompt(...)` helper.

## Capabilities

### New Capabilities
- `build-phases`: plan + decompose phase wrappers around the Claude Code runner.

### Modified Capabilities
*(none — uses runner + workspace; consumed by orchestrator)*

## Impact

- **Files added**:
  - `src/build/phases.ts` — `runPlanPhase`, `runDecomposePhase`, prompt templates + renderers, types.
  - `src/build/phases.test.ts` — fake-spawner tests for both phases; prompt renderer pinning.
- **Files modified**:
  - `src/build/index.ts` — re-exports.
- **Non-goals**:
  - No interactive plan iteration. The plan phase is one-shot today; user iteration ("rewrite section 3") is a future change that loops with `resumeSessionId`.
  - No semantic check on the produced PLAN.md / changes. Validators + orchestrator handle "is this output any good".
  - No persistence of the plan to `~/.strata/plans/`. The orchestrator can mirror the workdir copy there if desired.
