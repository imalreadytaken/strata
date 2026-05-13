## 1. `strata_propose_capability` tool

- [x] 1.1 Create `src/tools/propose_capability.ts` exporting:
  - `proposeCapabilitySchema = z.object({ title: z.string().min(1), summary: z.string().min(1), rationale: z.string().min(1), target_capability: z.string().min(1).optional(), estimated_time_minutes: z.number().int().positive().optional() })`.
  - `ProposeCapabilityDetails = { proposal_id: number; status: 'pending' }`.
  - `proposeCapabilityTool(deps): AnyAgentTool` factory.
- [x] 1.2 `execute` parses raw params, INSERTs a `proposals` row with `source='user_request'`, `kind='new_capability'`, `status='pending'`, `created_at=now`, and the parsed fields. Returns `payloadTextResult({ proposal_id, status: 'pending' })`.
- [x] 1.3 Tool description names exactly when to use it (the user wants to track or capture a new domain) and explicitly rules out schema evolution of an existing capability (handled in a future change).

## 2. `EventToolDeps` + harness + register

- [x] 2.1 Modify `src/tools/types.ts`: add `proposalsRepo: ProposalsRepository` to `EventToolDeps`.
- [x] 2.2 Modify `src/tools/test_helpers.ts`: instantiate `proposalsRepo` from the open DB and thread into `deps`.
- [x] 2.3 Modify `src/tools/index.ts`:
  - Export `proposeCapabilityTool`, `proposeCapabilitySchema`, `ProposeCapabilityDetails` types.
  - Add to `buildEventTools`.
  - `registerEventTools` puts `proposalsRepo: runtime.proposalsRepo` on the deps bag.
- [x] 2.4 Modify `src/callbacks/index.ts`'s `registerStrataCallbacks` deps bag to include `proposalsRepo` (callbacks' commit/abandon path doesn't use it today, but the type now requires it).

## 3. Build SKILL.md + loader

- [x] 3.1 Create `src/skills/build/SKILL.md` with:
  - Frontmatter: `name: build`, multi-line `description` covering trigger conditions ("track X", "记录Y的能力", "/build") and non-triggers (capture facts, query history).
  - Workflow section: identify domain → ask one clarifying question if too vague → draft `title` (`'Track <domain>'`), `summary` (one sentence), `rationale` (why this matters to the user) → call `strata_propose_capability` → acknowledge with the returned `proposal_id` and a note that Build Bridge will pick it up.
  - "Do NOT" section: do not run a build, do not edit `capabilities/`, do not promise immediate availability.
  - Worked example: "我想加个体重追踪" → `title='Track weight'`, `summary='Track body weight measurements over time'`, `rationale='User wants to monitor health trends'`, no `target_capability`.
- [x] 3.2 Modify `src/skills/index.ts`: add `loadBuildSkill(): Promise<LoadedSkill>` that points at `./build/SKILL.md` (factor a small helper if `loadCaptureSkill` and `loadBuildSkill` share most logic; otherwise duplicate the 3 lines).
- [x] 3.3 Modify `src/skills/index.test.ts`: parallel assertions for build skill — file exists, frontmatter `name='build'`, body contains `strata_propose_capability`, body contains the word `proposals`.

## 4. Triage hook template

- [x] 4.1 Modify `src/triage/hook.ts`'s `build_request` branch:
  - Tool sequence: `strata_propose_capability` → acknowledge with `proposal_id`.
  - Recommended skill: `build (src/skills/build/SKILL.md)`.
  - Drop the "Build Bridge not yet shipped" phrasing.
- [x] 4.2 Modify `src/triage/hook.test.ts`:
  - `build_request` template assertion: expect `'strata_propose_capability'` in `prependContext`, no longer expect `'build bridge'`.

## 5. Capture skill cross-reference

- [x] 5.1 Modify `src/skills/capture/SKILL.md`: in the "Do NOT activate for" section, change the build-request line to explicitly point at `strata_propose_capability` / the build skill (one sentence).

## 6. Tests

- [x] 6.1 `src/tools/propose_capability.test.ts` (≥ 5 cases):
  - Happy path: minimal inputs → row in `proposals` with `status='pending'`, `source='user_request'`, `kind='new_capability'`, all fields set.
  - With `target_capability` + `estimated_time_minutes`: those land on the row.
  - Empty `title` → ZodError, no row.
  - Empty `summary` → ZodError.
  - Empty `rationale` → ZodError.
- [x] 6.2 Update `src/tools/index.test.ts`:
  - `buildEventTools` returns 7 tools now, list ends with `strata_propose_capability`.
  - `registerEventTools` test still passes (7 tools instead of 6).

## 7. Integration

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm test` all pass.
- [x] 7.3 `openspec validate add-build-skill --strict`.
