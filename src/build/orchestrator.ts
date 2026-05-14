/**
 * Build Bridge — orchestrator. Coordinates plan → decompose → apply →
 * validate. Persists state in the `builds` table; returns a structured
 * `BuildRunResult` the integration phase (next change) consumes.
 *
 * The orchestrator NEVER throws on phase failure — it transitions the
 * `builds` row to `phase='failed'` and returns `{ status: 'failed', ... }`.
 * The only thrown errors are programmer mistakes (e.g., proposal not found)
 * and DB I/O failures.
 *
 * See `openspec/changes/add-build-orchestrator/specs/build-orchestrator/spec.md`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import JSON5 from "json5";

import type { CapabilityRegistry } from "../capabilities/types.js";
import type { Logger } from "../core/logger.js";
import type { BuildsRepository } from "../db/repositories/builds.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { ProposalsRepository } from "../db/repositories/proposals.js";
import {
  runClaudeCode,
  type RunClaudeCodeOptions,
  type StreamJsonEvent,
} from "./claude_code_runner.js";
import {
  runDecomposePhase,
  runPlanPhase,
  type DecomposePhaseResult,
  type PlanPhaseResult,
  type PlanProposal,
} from "./phases.js";
import type { BuildProgressForwarder } from "./progress_forwarder.js";
import {
  setupBuildWorkspace,
  type BuildWorkspaceHandle,
} from "./workspace.js";
import {
  runValidationChecks,
  type ValidationReport,
} from "./validator.js";

// ---------- types ---------------------------------------------------------

export interface ApplyPhaseResult {
  exitCode: number;
  eventCount: number;
  sessionId: string | null;
  stderr: string;
}

export interface RunApplyPhaseOptions {
  workdir: string;
  changeId: string;
  maxTurns: number;
  onEvent?: (event: StreamJsonEvent) => void;
  resumeSessionId?: string;
  signal?: AbortSignal;
  spawn?: RunClaudeCodeOptions["spawn"];
  env?: Record<string, string>;
}

export interface PhaseRunner {
  setupBuildWorkspace: typeof setupBuildWorkspace;
  runPlanPhase: typeof runPlanPhase;
  runDecomposePhase: typeof runDecomposePhase;
  runApplyPhase: typeof runApplyPhase;
  runValidationChecks: typeof runValidationChecks;
}

export interface BuildOrchestratorDeps {
  buildsRepo: BuildsRepository;
  proposalsRepo: ProposalsRepository;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  capabilities: CapabilityRegistry;
  agentsMdSource: string;
  buildsDir: string;
  maxTurnsPerPhase: number;
  logger: Logger;
  progressForwarder?: BuildProgressForwarder;
  /** Override individual phase runners (tests). */
  phaseRunner?: Partial<PhaseRunner>;
}

export interface RunBuildOptions {
  proposalId: number;
  sessionId: string;
  deps: BuildOrchestratorDeps;
  signal?: AbortSignal;
  /**
   * Called once with the freshly-inserted `builds.id` so callers can wire
   * the in-process build session registry. Used by `strata_run_build` to
   * register an `AbortController` for `strata_stop_build`.
   */
  onBuildIdAssigned?: (buildId: number) => void;
}

export type BuildRunStatus = "ready_for_integration" | "failed" | "cancelled";

interface BuildRunResultSuccess {
  status: "ready_for_integration";
  build_id: number;
  workdir: string;
  plan: string;
  changeIds: string[];
  validationReports: Record<string, ValidationReport>;
}

interface BuildRunResultFailure {
  status: "failed";
  build_id: number;
  failureReason: string;
  validationReports: Record<string, ValidationReport>;
  partial: {
    workdir?: string;
    plan?: string;
    changeIds?: string[];
  };
}

interface BuildRunResultCancelled {
  status: "cancelled";
  build_id: number;
  partial: {
    workdir?: string;
    plan?: string;
    changeIds?: string[];
  };
}

export type BuildRunResult =
  | BuildRunResultSuccess
  | BuildRunResultFailure
  | BuildRunResultCancelled;

// ---------- apply phase ---------------------------------------------------

function wrapWithSessionCapture(
  onEvent: ((event: StreamJsonEvent) => void) | undefined,
): { wrapped: (event: StreamJsonEvent) => void; getSessionId: () => string | null } {
  let sessionId: string | null = null;
  return {
    wrapped: (event) => {
      if (sessionId === null && event.type === "system") {
        const r = event.raw as Record<string, unknown>;
        const id = r.session_id ?? r.id;
        if (typeof id === "string" && id.length > 0) sessionId = id;
      }
      if (onEvent) onEvent(event);
    },
    getSessionId: () => sessionId,
  };
}

export async function runApplyPhase(
  opts: RunApplyPhaseOptions,
): Promise<ApplyPhaseResult> {
  const sess = wrapWithSessionCapture(opts.onEvent);
  const runnerOpts: RunClaudeCodeOptions = {
    workdir: opts.workdir,
    prompt: `/opsx:apply ${opts.changeId}`,
    mode: "apply",
    maxTurns: opts.maxTurns,
    onEvent: sess.wrapped,
  };
  if (opts.resumeSessionId) runnerOpts.resumeSessionId = opts.resumeSessionId;
  if (opts.env) runnerOpts.env = opts.env;
  if (opts.signal) runnerOpts.signal = opts.signal;
  if (opts.spawn) runnerOpts.spawn = opts.spawn;
  const handle = runClaudeCode(runnerOpts);
  const result = await handle.result;
  return {
    exitCode: result.exitCode,
    eventCount: result.eventCount,
    sessionId: sess.getSessionId(),
    stderr: result.stderr,
  };
}

// ---------- runBuild ------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Try to find the capability the change is operating on by reading its
 * meta.json under `<workdir>/capabilities/<x>/v<N>/meta.json`. Used by the
 * validator's `capabilityName`. Returns the first capability found.
 */
async function detectCapabilityName(workdir: string): Promise<string | undefined> {
  const root = path.join(workdir, "capabilities");
  if (!existsSync(root)) return undefined;
  let names: string[];
  try {
    const { readdirSync, statSync } = await import("node:fs");
    names = readdirSync(root).filter((n) => {
      try {
        return statSync(path.join(root, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    const versionDirs = (() => {
      try {
        const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
        return readdirSync(dir)
          .filter((d) => /^v\d+$/.test(d) || d === "current")
          .filter((d) => {
            try {
              return statSync(path.join(dir, d)).isDirectory();
            } catch {
              return false;
            }
          });
      } catch {
        return [] as string[];
      }
    })();
    for (const v of versionDirs) {
      const metaFile = path.join(dir, v, "meta.json");
      if (!existsSync(metaFile)) continue;
      try {
        const raw = await readFile(metaFile, "utf8");
        const meta = JSON5.parse(raw) as { name?: unknown };
        if (typeof meta.name === "string") return meta.name;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

export async function runBuild(opts: RunBuildOptions): Promise<BuildRunResult> {
  const { deps, signal } = opts;
  const log = deps.logger.child({ module: "build.orchestrator" });
  const phases: PhaseRunner = {
    setupBuildWorkspace: deps.phaseRunner?.setupBuildWorkspace ?? setupBuildWorkspace,
    runPlanPhase: deps.phaseRunner?.runPlanPhase ?? runPlanPhase,
    runDecomposePhase: deps.phaseRunner?.runDecomposePhase ?? runDecomposePhase,
    runApplyPhase: deps.phaseRunner?.runApplyPhase ?? runApplyPhase,
    runValidationChecks: deps.phaseRunner?.runValidationChecks ?? runValidationChecks,
  };

  // 1. Look up the proposal.
  const proposal = await deps.proposalsRepo.findById(opts.proposalId);
  if (!proposal) {
    throw new Error(`runBuild: proposal #${opts.proposalId} not found`);
  }

  const planProposal: PlanProposal = {
    title: proposal.title,
    summary: proposal.summary,
    rationale: proposal.rationale,
  };
  const targetCapability = proposal.target_capability ?? slugifyTitle(proposal.title);

  // 2. INSERT the builds row.
  const buildRow = await deps.buildsRepo.insert({
    session_id: opts.sessionId,
    trigger_kind: "user_request",
    trigger_proposal_id: opts.proposalId,
    target_capability: targetCapability,
    target_action: "create",
    phase: "plan",
    changes_done: 0,
    created_at: nowIso(),
    last_heartbeat_at: nowIso(),
  });

  // The build id only exists after the insert; surface it to the caller
  // (e.g. `strata_run_build`) so it can register an AbortController for
  // `strata_stop_build`. Wrapped so a buggy callback can't sink the build.
  if (opts.onBuildIdAssigned) {
    try {
      opts.onBuildIdAssigned(buildRow.id);
    } catch (cbErr) {
      log.warn("onBuildIdAssigned callback threw — continuing", {
        build_id: buildRow.id,
        error: (cbErr as Error).message,
      });
    }
  }

  const validationReports: Record<string, ValidationReport> = {};
  const partial: BuildRunResultFailure["partial"] = {};

  const abortIfNeeded = async (): Promise<BuildRunResultCancelled | null> => {
    if (signal?.aborted) {
      await deps.buildsRepo.update(buildRow.id, {
        phase: "cancelled",
        completed_at: nowIso(),
        last_heartbeat_at: nowIso(),
        failure_reason: "aborted",
      });
      return {
        status: "cancelled",
        build_id: buildRow.id,
        partial: { ...partial },
      };
    }
    return null;
  };

  const failBuild = async (failureReason: string): Promise<BuildRunResultFailure> => {
    await deps.buildsRepo.update(buildRow.id, {
      phase: "failed",
      completed_at: nowIso(),
      last_heartbeat_at: nowIso(),
      failure_reason: failureReason,
    });
    log.warn("build failed", { build_id: buildRow.id, reason: failureReason });
    return {
      status: "failed",
      build_id: buildRow.id,
      failureReason,
      validationReports,
      partial: { ...partial },
    };
  };

  try {
    // 3. Setup workspace.
    const cancelled1 = await abortIfNeeded();
    if (cancelled1) return cancelled1;
    deps.progressForwarder?.onPhase("plan");
    let workspace: BuildWorkspaceHandle;
    try {
      workspace = await phases.setupBuildWorkspace({
        sessionId: opts.sessionId,
        planContents: "(placeholder — plan_phase will overwrite)",
        buildContext: {
          requestedTitle: proposal.title,
          requestedSummary: proposal.summary,
          rationale: proposal.rationale,
        },
        agentsMdSource: deps.agentsMdSource,
        buildsDir: deps.buildsDir,
        capabilities: deps.capabilities,
        proposalsRepo: deps.proposalsRepo,
        capabilityRegistryRepo: deps.capabilityRegistryRepo,
        logger: deps.logger,
      });
    } catch (e) {
      return failBuild(`workspace_setup_failed: ${(e as Error).message}`);
    }
    partial.workdir = workspace.workdir;
    await deps.buildsRepo.update(buildRow.id, {
      workdir_path: workspace.workdir,
      last_heartbeat_at: nowIso(),
    });

    // 4. Plan phase.
    const cancelled2 = await abortIfNeeded();
    if (cancelled2) return cancelled2;
    const planResult: PlanPhaseResult = await phases.runPlanPhase({
      workdir: workspace.workdir,
      maxTurns: deps.maxTurnsPerPhase,
      proposal: planProposal,
      capabilitiesList: [...deps.capabilities.keys()],
      ...(deps.progressForwarder
        ? { onEvent: deps.progressForwarder.onEvent.bind(deps.progressForwarder) }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!planResult.planMd || planResult.planMd.length === 0) {
      return failBuild("plan_empty");
    }
    partial.plan = planResult.planMd;
    await deps.buildsRepo.update(buildRow.id, {
      phase: "decompose",
      plan_path: workspace.planMdPath,
      claude_session_id: planResult.sessionId,
      last_heartbeat_at: nowIso(),
    });

    // 5. Decompose phase.
    const cancelled3 = await abortIfNeeded();
    if (cancelled3) return cancelled3;
    deps.progressForwarder?.onPhase("decompose");
    const decomposeResult: DecomposePhaseResult = await phases.runDecomposePhase({
      workdir: workspace.workdir,
      maxTurns: deps.maxTurnsPerPhase,
      ...(deps.progressForwarder
        ? { onEvent: deps.progressForwarder.onEvent.bind(deps.progressForwarder) }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (decomposeResult.changeIds.length === 0) {
      return failBuild("decompose_empty");
    }
    partial.changeIds = decomposeResult.changeIds;
    await deps.buildsRepo.update(buildRow.id, {
      phase: "build",
      changes_total: decomposeResult.changeIds.length,
      last_heartbeat_at: nowIso(),
    });

    // 6. Apply + validate per change.
    for (const changeId of decomposeResult.changeIds) {
      const cancelledN = await abortIfNeeded();
      if (cancelledN) return cancelledN;

      await deps.buildsRepo.update(buildRow.id, {
        current_change_id: changeId,
        last_heartbeat_at: nowIso(),
      });

      deps.progressForwarder?.onPhase(`apply:${changeId}`);
      const applyResult = await phases.runApplyPhase({
        workdir: workspace.workdir,
        changeId,
        maxTurns: deps.maxTurnsPerPhase,
        ...(deps.progressForwarder
        ? { onEvent: deps.progressForwarder.onEvent.bind(deps.progressForwarder) }
        : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (applyResult.exitCode !== 0) {
        return failBuild(`apply_failed_${changeId}`);
      }

      deps.progressForwarder?.onPhase(`validate:${changeId}`);
      const capabilityName = await detectCapabilityName(workspace.workdir);
      const validationCtx = {
        workdir: workspace.workdir,
        changeId,
        gitInitialCommit: workspace.gitInitialCommit,
        ...(capabilityName !== undefined ? { capabilityName } : {}),
      };
      const report = await phases.runValidationChecks(validationCtx);
      validationReports[changeId] = report;
      if (!report.ok) {
        return failBuild(`validation_failed_${changeId}`);
      }

      await deps.buildsRepo.update(buildRow.id, {
        changes_done: (await deps.buildsRepo.findById(buildRow.id))!.changes_done + 1,
        last_heartbeat_at: nowIso(),
      });
    }

    // 7. All changes ok → ready for integration.
    deps.progressForwarder?.onPhase("integrate");
    await deps.buildsRepo.update(buildRow.id, {
      phase: "integrate",
      last_heartbeat_at: nowIso(),
    });

    return {
      status: "ready_for_integration",
      build_id: buildRow.id,
      workdir: workspace.workdir,
      plan: planResult.planMd,
      changeIds: decomposeResult.changeIds,
      validationReports,
    };
  } catch (e) {
    // Unexpected error inside a phase runner — log + fail.
    log.error("build threw unexpectedly", {
      build_id: buildRow.id,
      error: (e as Error).message,
    });
    return failBuild(`unexpected: ${(e as Error).message}`);
  }
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}
