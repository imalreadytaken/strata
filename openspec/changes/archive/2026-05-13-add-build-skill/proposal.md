## Why

When the user says "我想加个体重追踪 / I want to track sleep" today, triage classifies as `build_request` and the routing context tells the agent to **respond conversationally — Build Bridge is not yet shipped**. The user's request goes nowhere: no row in any table records it. By the time Build Bridge ships, every request the user made in the meantime is lost.

We close this gap **without** running an actual build. The fix:

- A new agent tool `strata_propose_capability` that inserts one row in the existing `proposals` table (`source='user_request'`, `kind='new_capability'`, `status='pending'`).
- A new agent skill `src/skills/build/SKILL.md` that tells the LLM how to do that: identify the requested domain, ask 1–2 clarifying questions if the domain is too vague, then call the tool with a coherent `title` / `summary` / `rationale`.
- The triage hook's `build_request` template flips from "not shipped" to "use the build skill — `strata_propose_capability`".

When the actual Build Bridge ships (next changes), it scans `proposals WHERE status='pending' AND source='user_request'` and picks up the queue. Until then, the user gets an honest acknowledgement ("I've recorded proposal #N; when Build Bridge ships, it'll pick this up") and we don't quietly drop their intent.

References: `STRATA_SPEC.md` §3.1 (`proposals` table — `source='user_request'`, `kind='new_capability'`), §5.4 (per-skill markdown convention), §5.6 + §7.1 (triage build_request kind), `add-triage-hook` D5 (build_request template was a placeholder).

## What Changes

- Add `build-skill` capability covering:
  - **`strata_propose_capability` agent tool**: Zod schema `{ title, summary, rationale, target_capability?, estimated_time_minutes? }`. Inserts a `proposals` row with `source='user_request'`, `kind='new_capability'`, `status='pending'`, `created_at=now`. Returns `{ proposal_id, status: 'pending' }`.
  - **`src/skills/build/SKILL.md`**: agent-facing skill with worked examples ("加个梦境追踪" → propose `dreams`; "track sleep" → propose `sleep`), confidence-threshold guidance ("clarify before proposing if the domain is too vague"), and the explicit reminder that we record the proposal — we do NOT run a build.
  - **`loadBuildSkill()`**: shipped alongside `loadCaptureSkill()`, same shape.
- **Modify `triage` hook**: `build_request` template now says "Use the build skill (src/skills/build/SKILL.md). Tool: strata_propose_capability." instead of "Build Bridge not yet shipped — respond conversationally."
- **Modify `registerEventTools`**: also registers `strata_propose_capability`. Same factory pattern. (Naming nit: it's not strictly an "event tool" — it writes to `proposals` rather than `raw_events`. We keep the same registration path for minimal disruption; a future change can split if the surface diverges.)

## Capabilities

### New Capabilities
- `build-skill`: the agent-facing skill markdown + `strata_propose_capability` tool that turns "I want X tracked" into a `proposals` row.

### Modified Capabilities
- `event-tools`: adds `strata_propose_capability` to the registered set (7 tools total).
- `triage-hook`: `build_request` template now routes to the build skill instead of the placeholder.
- `capture-skill`: gains a one-line cross-reference to the build skill (so the capture skill knows to defer when an intent is actually a build request).

## Impact

- **Files added**:
  - `src/tools/propose_capability.ts` — tool factory + Zod schema + `ProposeCapabilityDetails` type.
  - `src/tools/propose_capability.test.ts` — happy path, status defaults, target_capability optional, schema rejections.
  - `src/skills/build/SKILL.md` — the skill markdown.
- **Files modified**:
  - `src/skills/index.ts` — adds `loadBuildSkill()` (and refactors the shared parser as a small helper if not already).
  - `src/skills/index.test.ts` — adds parallel assertions for the build skill: mentions `strata_propose_capability`, names the `proposals` table.
  - `src/tools/index.ts` — `buildEventTools` includes the propose tool; `registerEventTools` registers it.
  - `src/tools/types.ts` — `EventToolDeps` adds `proposalsRepo: ProposalsRepository` so the new tool can write.
  - `src/tools/test_helpers.ts` — harness instantiates `proposalsRepo` and threads it into `deps`.
  - `src/triage/hook.ts` — `build_request` template rewritten.
  - `src/triage/hook.test.ts` — assertion updated to expect `strata_propose_capability`.
  - `src/runtime.ts` — no shape change; the existing `proposalsRepo` is now threaded into `EventToolDeps` via `registerEventTools`.
  - `src/capabilities/expenses/v1/...` — unchanged. `src/skills/capture/SKILL.md` — adds one cross-reference line.
  - `tests/integration/capture_loop.test.ts` — unchanged (separate domain).
- **Non-goals**:
  - No actual Build Bridge run. The proposal sits at `status='pending'` waiting for the orchestrator.
  - No automatic "did this capability already exist" check. If the user proposes `expenses` again, we INSERT a duplicate `proposals` row; the future orchestrator can dedupe.
  - No proposal expiry / cooldown. Those columns exist on the row but stay null until the Reflect agent (P5) owns them.
  - No inline-keyboard for accepting/rejecting a proposal. Future change can add `propose:accept:N` / `propose:decline:N` callbacks in the strata namespace alongside the event ones.
