## Context

`STRATA_SPEC.md` §5.8.5 sketches a 12-step integration phase. About half of those steps reference subsystems we haven't built yet (skill registry, cron scheduler, dashboard registry). This change scopes integration to the **data-only** subset that's available today:

- Filesystem move (`workdir/capabilities/<X>/v<N>/` → `<userCapabilitiesDir>/<X>/v<N>/`).
- Capability migrations applied to the main DB.
- Four DB inserts (`capability_registry`, `capability_health`, `schema_evolutions`) + two DB updates (`proposals`, `builds`).

When the skill / cron / dashboard subsystems land, they'll plug into the same function via additional opts.

## Goals / Non-Goals

**Goals:**
- The function is **idempotent on partial failure** at the per-capability level: a failure on capability #2 of 3 leaves capability #1 fully integrated and capability #3 untouched.
- Each per-capability operation is **transactional**: FS move + migrations + DB inserts all succeed or all roll back. If FS move succeeds but migrations fail, the moved dir is removed.
- The function never throws on a per-capability failure — it transitions the build to `phase='failed'` with a `failure_reason`, returns `{ status: 'failed', partial: { integrated: [..] } }` listing what DID succeed.
- Programmer errors (build_id not found, build not in `phase='integrate'`) throw.

**Non-Goals:**
- No in-process hot reload of the runtime's `CapabilityRegistry`. The loader walks on next boot; we don't yet have a runtime mutator.
- No `existing_capabilities/` snapshot cleanup — those are inside the build workdir which the caller can `cleanupBuildWorkspace` after.
- No archive of the workdir for forensic replay. The caller decides.

## Files this change creates or modifies

| File | Status | Purpose |
|---|---|---|
| `src/build/integration.ts` | new | `runIntegration`, `IntegrationResult`, `RunIntegrationOptions`, `IntegratedCapability` types. |
| `src/build/integration.test.ts` | new | Happy path; partial failure rollback; idempotent on re-run; version_conflict. |
| `src/build/index.ts` | modified | Re-export. |

## Decisions

### D1 — Move via `fs.cp { recursive: true }` + `fs.rm` rather than `fs.rename`

`fs.rename` fails across filesystems (workdir might be on `/tmp`, user dir on `$HOME`). `cp -r` + `rm -r` is safer; the cost is negligible because capability dirs are small.

### D2 — Per-capability transaction is FS first, DB second

If `fs.cp` succeeds and we then fail to insert into `capability_registry`, we roll back by `fs.rm` the moved dir. The other direction (DB first) would leave us with a registry row pointing at nothing. FS first means a failure mid-DB-write has a clean rollback target: the new files exist at the destination, we know exactly where, and we delete them.

### D3 — `schema_evolutions` row uses `from_version=0` for `kind=new_capability`

The schema is `from_version → to_version`. A brand-new capability is `0 → version`. Existing AGENTS.md flow defines "0" as "didn't exist before."

### D4 — `proposals.responded_at` is set when status flips to `'applied'`

Same convention as `softDelete` on the repo: `responded_at = now()`. Lets the Reflect agent later see "this proposal was answered."

### D5 — `version_conflict` is a per-capability failure, not a build-wide one

If a build emits two capabilities and the second has `<userDir>/<name>/v<N>/` already populated, only that capability fails. The first still integrates cleanly. The `partial.integrated` list captures what landed.

### D6 — No git operations

The user's main repo (if they keep one for `~/.strata/`) is outside our concern. A future "commit capability install" hook can layer on top.

## Risks / Trade-offs

- **No in-process runtime refresh.** Until the user restarts the plugin, the new capability is on disk + in `capability_registry` but `runtime.capabilities` doesn't yet contain it. Tools that look up the registry (`registerEventTools`, `runPipelineForEvent`) won't dispatch to it. Documented gap; restart-to-pick-up is the V1 story.
- **Partial-failure rollback is best-effort.** If `fs.rm` itself fails after a DB insert succeeded, we log + propagate; a manual cleanup is needed. Real-world disk-failure scenarios are rare; we don't try to be cleverer.
- **No version_conflict resolution path** — the orchestrator surfaces the failure; the user has to remove the old version manually (or via a future tool). Pragmatic for V1.
