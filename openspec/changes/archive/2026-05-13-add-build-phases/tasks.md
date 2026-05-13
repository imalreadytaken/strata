## 1. Types

- [x] 1.1 Create `src/build/phases.ts` exporting:
  - `PlanPhaseResult = { planMd: string; sessionId: string | null; exitCode: number; eventCount: number; stderr: string }`.
  - `DecomposePhaseResult = { changeIds: string[]; sessionId: string | null; exitCode: number; eventCount: number; stderr: string }`.
  - `RunPlanPhaseOptions` extending the runner's options with `proposal: { title, summary, rationale? }` and `capabilitiesList: string[]`.
  - `RunDecomposePhaseOptions` extending with `extraInstructions?: string`.

## 2. Prompt templates + renderers

- [x] 2.1 Export `PLAN_PROMPT_TEMPLATE` and `renderPlanPrompt(opts)`. Template substitutions: `{{title}}`, `{{summary}}`, `{{rationale}}`, `{{capabilitiesList}}`. Instructions tell Claude to write `<workdir>/PLAN.md` and STOP once a coherent plan is on disk.
- [x] 2.2 Export `DECOMPOSE_PROMPT_TEMPLATE` (verbatim from `STRATA_SPEC.md` §7.4) and `renderDecomposePrompt(opts)`. Substitutions: `{{extraInstructions}}` (defaults empty).

## 3. `runPlanPhase`

- [x] 3.1 Build `prompt` via `renderPlanPrompt(opts)`.
- [x] 3.2 Call `runClaudeCode({ mode: 'explore', prompt, workdir: opts.workdir, maxTurns: opts.maxTurns, onEvent: <captures sessionId + forwards>, env: opts.env, signal: opts.signal, spawn: opts.spawn })`.
- [x] 3.3 After the runner resolves, read `<workdir>/PLAN.md`. Missing → empty string. Return `PlanPhaseResult`.

## 4. `runDecomposePhase`

- [x] 4.1 Build `prompt` via `renderDecomposePrompt(opts)`.
- [x] 4.2 Call `runClaudeCode({ mode: 'propose', prompt, ... })`.
- [x] 4.3 After resolution, list `<workdir>/openspec/changes/` children (immediate subdirs), excluding `archive`. Return `DecomposePhaseResult`.

## 5. Tests

- [x] 5.1 Renderer tests:
  - `renderPlanPrompt` substitutes title/summary/rationale/capabilitiesList correctly.
  - Empty `capabilitiesList` yields `(none yet)` in the output (or similar marker).
  - `renderDecomposePrompt` carries the §7.4 text verbatim.
- [x] 5.2 Phase tests via fake spawner:
  - `runPlanPhase` with a fake spawner that emits a `system` event + writes nothing → returns `planMd: ''` and `sessionId` from the system event.
  - `runPlanPhase` where the test pre-creates `<workdir>/PLAN.md` → returns its content.
  - `runDecomposePhase` returns directory names sorted; excludes `archive`; copes with missing `openspec/changes/` (returns `[]`).
  - `sessionId` capture from `system` event.

## 6. Barrel

- [x] 6.1 `src/build/index.ts` re-exports the phase functions + types.

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-build-phases --strict`.
