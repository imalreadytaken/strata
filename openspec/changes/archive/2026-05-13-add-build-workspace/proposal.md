## Why

The Claude Code runner expects a `workdir` to be handed to it — a directory containing the prompt artefacts Claude Code reads on startup. `STRATA_SPEC.md` §4.1 specifies that directory's shape:

```
~/.strata/builds/<session_id>-<timestamp>/
├── AGENTS.md                  # constitution
├── PLAN.md                    # the user's approved plan
├── USER_CONTEXT.md            # dynamic context
├── existing_capabilities/     # read-only snapshot of current capabilities
└── .git/                      # rollback target if integration fails
```

Today, every `runClaudeCode(...)` call would have to assemble this by hand. This change ships the helper that does it once: pick a session-scoped path, materialise the artefacts, run `git init` + initial commit, return the workdir handle.

The function is **prerequisite** for the orchestrator (next change) — it can't even start a plan-phase run without a valid workdir.

References: `STRATA_SPEC.md` §4.1 (workdir layout), §5.8 (Build Bridge overview), `openspec/AGENTS.md` (constitution copied into the workdir verbatim).

## What Changes

- Add `build-workspace` capability covering:
  - **`setupBuildWorkspace(opts): Promise<BuildWorkspaceHandle>`** — creates the workdir at `<config.paths.buildsDir>/<session_id>-<timestamp>/`, copies the constitution + plan, generates USER_CONTEXT.md from the runtime state, snapshots active capabilities, runs `git init` + an initial commit so any future change inside the workdir can be diffed against `HEAD~`.
  - **`BuildWorkspaceHandle`** = `{ workdir, agentsMdPath, planMdPath, userContextMdPath, existingCapabilitiesDir, gitInitialCommit }`.
  - **`cleanupBuildWorkspace(handle)`** — `rm -rf <workdir>`. Idempotent. Called by the orchestrator after a successful integration phase, or by stop/resume on abort.
  - **`renderUserContext(runtime, opts)`** — pure async helper that generates USER_CONTEXT.md from the live `capability_registry` + recent active sessions. Exported separately so tests can pin its output.
- The helper uses Node's built-in `git` via `child_process.spawn` (no `simple-git` dependency) — Strata already requires Node ≥22 + a git binary (for the user's plugin install path); we don't add another dep.

## Capabilities

### New Capabilities
- `build-workspace`: per-build workdir scaffolding + git init + cleanup.

### Modified Capabilities
*(none — `claude-code-runner` calls `setupBuildWorkspace` from the orchestrator change; this change ships only the setup helper)*

## Impact

- **Files added**:
  - `src/build/workspace.ts` — `setupBuildWorkspace`, `cleanupBuildWorkspace`, `renderUserContext`, types.
  - `src/build/workspace.test.ts` — happy path, USER_CONTEXT.md content, existing-capabilities snapshot, git init verification, idempotent cleanup.
- **Files modified**:
  - `src/build/index.ts` (new barrel) — re-export `runClaudeCode`, `setupBuildWorkspace`, etc., so consumers (orchestrator, future) have one import path.
- **Non-goals**:
  - No PLAN.md *content generation*. Plans come from the plan-phase (`/opsx:explore` output stored at `<dataDir>/plans/<topic>/final.md`); `setupBuildWorkspace` just copies the file the caller points to.
  - No `--resume` plumbing. The runner already accepts a session id; the orchestrator threads it through. The workspace setup is one-shot per build.
  - No locking. Build workdirs are session-scoped and timestamp-suffixed; concurrent builds for the same session get distinct paths. Cross-process locking is a future concern.
  - No `existing_capabilities/` *cloning of pipelines*. We copy `meta.json` + `migrations/` per capability so Claude Code knows what already exists; the actual `pipeline.ts` source is not needed for the LLM to reason about new capability boundaries.
