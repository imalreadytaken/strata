## Context

The workspace is **Claude Code's view of Strata**. When the runner starts the subprocess, Claude Code reads `AGENTS.md` to know the rules, `PLAN.md` to know what to build, `USER_CONTEXT.md` to know the user's current setup, and `existing_capabilities/` to know what to avoid duplicating. The whole point is that the LLM operates inside a deliberately-isolated workdir whose only writes can be reverted by `git reset --hard`.

The plugin source's `openspec/AGENTS.md` is the source-of-truth constitution. We copy it verbatim — symlinks would be tempting (one source of truth) but break the `--dangerously-skip-permissions` isolation we rely on. The copy means a constitution edit between builds works as expected: next build picks up the new text.

`USER_CONTEXT.md` is generated, not stored: it embeds the live capability registry, a few recent active session ids, and any open proposals so Claude Code's plan-phase has the right context for "what's the user already doing."

## Goals / Non-Goals

**Goals:**
- One async function (`setupBuildWorkspace`) does **all** the IO; tests call it against a tmp HOME and inspect the resulting filesystem.
- `git init` runs synchronously via `child_process.execFileSync('git', ...)` so the function can return the initial commit SHA. Tests use the real git binary — every dev machine has one.
- `existing_capabilities/` snapshot copies `meta.json` + `migrations/` *only* — not `pipeline.ts`. The plan-phase doesn't need pipeline source to reason; the apply-phase will get it via the live filesystem when Claude Code wants to read it.
- `cleanupBuildWorkspace` is idempotent and does NOT throw on a missing dir (the orchestrator may call it twice on a stop/resume).
- `renderUserContext` is a pure async function over a deps bag (`{ capabilityRegistryRepo, proposalsRepo }`) so its output is testable without setting up a runtime.

**Non-Goals:**
- No `.gitignore` template inside the workdir. Claude Code's writes are the artefact we want to capture; we don't want to filter any of them out.
- No locking. Concurrent builds for the same session get distinct timestamped paths.
- No `.strata-state/` inside the workdir. The pending buffer lives outside; the workdir is purely Build-Bridge scratch.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/workspace.ts` | new | `setupBuildWorkspace`, `cleanupBuildWorkspace`, `renderUserContext`, `BuildWorkspaceHandle`, `SetupBuildWorkspaceOptions`. |
| `src/build/workspace.test.ts` | new | Happy path; USER_CONTEXT.md content; existing-capabilities snapshot; git init present + initial commit; cleanup idempotency. |
| `src/build/index.ts` | new | Barrel re-exporting `claude_code_runner` + `workspace` so consumers have one import. |

## Decisions

### D1 — Constitution is **copied**, not symlinked

A symlink would conflict with Claude Code's `--dangerously-skip-permissions` invariant. We `fs.copyFile(plugin/openspec/AGENTS.md, workdir/AGENTS.md)`. The downside (a constitution edit mid-build doesn't propagate) is the right trade-off: each build sees a frozen constitution per the time it started.

### D2 — `git init` uses `execFileSync`, not `simple-git` or another wrapper

We need three calls: `git init`, `git add .`, `git commit -m 'initial workspace'`. `execFileSync` covers it. Adding a wrapper library for three calls is wasted dependency mass; if we ever need diff/log/branch features the orchestrator can shell out individually.

### D3 — `existing_capabilities/` snapshot copies `meta.json` + `migrations/`, NOT `pipeline.ts`

A new-capability build doesn't need to read existing pipelines — its job is to write its own. A new pipeline that duplicates an existing capability's logic is a different problem (the proposal flow should have caught it). Skipping `pipeline.ts` keeps the workdir small and unambiguous about what Claude Code can vs. must NOT modify.

### D4 — `USER_CONTEXT.md` is **rendered**, not stored

The user's state changes constantly (new capabilities, new proposals). Storing a snapshot in the workdir is fine because the workdir itself is short-lived; the freshness story is "as of the moment the build started." Tests pin the rendered output by snapshotting a tiny fixture state.

### D5 — Timestamp format is ISO 8601 with `:` replaced by `-`

`new Date().toISOString().replace(/[:.]/g, '-')`. Windows-safe (no colons in path components) and lexicographically sortable. The buildsDir gets one dir per `<session_id>-<timestamp>`; concurrent builds for the same session land in distinct paths even at sub-second granularity (the ISO timestamp includes ms).

### D6 — `cleanupBuildWorkspace` does NOT git-archive before removing

A future change can add `archiveBuildWorkspace(workdir, dest)` that tarballs the dir before deletion (for forensic replay of failed builds). For now, cleanup is a flat `rm -rf` — keeps the storage cost bounded and the contract simple.

### D7 — `renderUserContext` deps are repos, not the full runtime

A deps bag `{ capabilityRegistryRepo, proposalsRepo, now? }` is the smallest surface that works. The function takes a `BuildContext` argument (`{ requestedTitle, requestedSummary, sessionId }`) so the rendered markdown can lead with "this build was triggered for…".

## Risks / Trade-offs

- **AGENTS.md drift across plugin updates.** If the user upgrades Strata mid-build (rare, but possible), the constitution in the workdir is stale. Acceptable: builds are minutes, plugin upgrades are deliberate.
- **`git init` runs synchronously.** ~50 ms cost per build. Async would buy nothing — the orchestrator can't start the plan-phase until the workdir exists.
- **`existing_capabilities/` copy is O(n) on capability count.** Strata has 0–dozens of capabilities; the copy cost is negligible even at 100.
