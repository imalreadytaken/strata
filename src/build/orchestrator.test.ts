import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityRegistry } from "../capabilities/types.js";
import { createLogger, type Logger } from "../core/logger.js";
import { openDatabase, type Database } from "../db/connection.js";
import { applyMigrations } from "../db/migrations.js";
import { SYSTEM_MIGRATIONS_DIR } from "../db/index.js";
import {
  BuildsRepository,
  CapabilityRegistryRepository,
  ProposalsRepository,
} from "../db/repositories/index.js";
import {
  runBuild,
  type BuildOrchestratorDeps,
  type PhaseRunner,
} from "./orchestrator.js";
import type { BuildWorkspaceHandle } from "./workspace.js";
import type { ValidationReport } from "./validator.js";

const VALID_META = JSON.stringify({
  name: "weight",
  version: 1,
  description: "Track weight",
  primary_table: "weight",
});

const VALID_PIPELINE = `export async function ingest(rawEvent, deps) {
  return { business_row_id: 1, business_table: "weight" };
}`;

interface PhaseStubs {
  setupBuildWorkspace?: PhaseRunner["setupBuildWorkspace"];
  runPlanPhase?: PhaseRunner["runPlanPhase"];
  runDecomposePhase?: PhaseRunner["runDecomposePhase"];
  runApplyPhase?: PhaseRunner["runApplyPhase"];
  runValidationChecks?: PhaseRunner["runValidationChecks"];
}

function defaultStubs(workdir: string): PhaseStubs {
  const handle: BuildWorkspaceHandle = {
    workdir,
    agentsMdPath: path.join(workdir, "AGENTS.md"),
    planMdPath: path.join(workdir, "PLAN.md"),
    userContextMdPath: path.join(workdir, "USER_CONTEXT.md"),
    existingCapabilitiesDir: path.join(workdir, "existing_capabilities"),
    gitInitialCommit: "abc123",
  };
  return {
    setupBuildWorkspace: vi.fn(async () => handle) as PhaseRunner["setupBuildWorkspace"],
    runPlanPhase: vi.fn(async () => ({
      planMd: "# Plan",
      sessionId: "sess-plan",
      exitCode: 0,
      eventCount: 1,
      stderr: "",
    })) as PhaseRunner["runPlanPhase"],
    runDecomposePhase: vi.fn(async () => ({
      changeIds: ["add-weight"],
      sessionId: "sess-dec",
      exitCode: 0,
      eventCount: 1,
      stderr: "",
    })) as PhaseRunner["runDecomposePhase"],
    runApplyPhase: vi.fn(async () => ({
      exitCode: 0,
      eventCount: 1,
      sessionId: "sess-app",
      stderr: "",
    })) as PhaseRunner["runApplyPhase"],
    runValidationChecks: vi.fn(async () => ({
      ok: true,
      findings: [],
      perCheck: {},
    })) as PhaseRunner["runValidationChecks"],
  };
}

describe("runBuild", () => {
  let tmp: string;
  let db: Database;
  let logger: Logger;
  let buildsRepo: BuildsRepository;
  let proposalsRepo: ProposalsRepository;
  let capabilityRegistryRepo: CapabilityRegistryRepository;
  let proposalId: number;
  let workdir: string;

  /** Build a deps bag with optional phase stub overrides. */
  function depsWith(overrides: PhaseStubs = {}): BuildOrchestratorDeps {
    const base = defaultStubs(workdir);
    const phaseRunner: Partial<PhaseRunner> = { ...base, ...overrides };
    return {
      buildsRepo,
      proposalsRepo,
      capabilityRegistryRepo,
      capabilities: new Map() as CapabilityRegistry,
      agentsMdSource: "# Constitution\n",
      buildsDir: path.join(tmp, "builds"),
      maxTurnsPerPhase: 5,
      logger,
      phaseRunner,
    };
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-orch-"));
    db = openDatabase({ path: path.join(tmp, "main.db"), loadVec: false });
    applyMigrations(db, SYSTEM_MIGRATIONS_DIR);
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
    buildsRepo = new BuildsRepository(db);
    proposalsRepo = new ProposalsRepository(db);
    capabilityRegistryRepo = new CapabilityRegistryRepository(db);

    const p = await proposalsRepo.insert({
      source: "user_request",
      kind: "new_capability",
      title: "Track weight",
      summary: "Track body weight over time.",
      rationale: "Health monitoring.",
      status: "pending",
      created_at: new Date().toISOString(),
    });
    proposalId = p.id;

    // Pre-create the workdir for the stubbed setupBuildWorkspace to point at.
    workdir = path.join(tmp, "workdir");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(path.join(workdir, "capabilities", "weight", "v1", "migrations"), {
      recursive: true,
    });
    writeFileSync(
      path.join(workdir, "capabilities", "weight", "v1", "meta.json"),
      VALID_META,
    );
    writeFileSync(
      path.join(workdir, "capabilities", "weight", "v1", "pipeline.ts"),
      VALID_PIPELINE,
    );
  });
  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path: returns ready_for_integration and builds row at phase='integrate'", async () => {
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith(),
    });
    expect(result.status).toBe("ready_for_integration");
    if (result.status !== "ready_for_integration") throw new Error("expected ready");
    expect(result.changeIds).toEqual(["add-weight"]);
    expect(result.plan).toBe("# Plan");
    expect(result.validationReports["add-weight"]?.ok).toBe(true);

    const row = await buildsRepo.findById(result.build_id);
    expect(row?.phase).toBe("integrate");
    expect(row?.changes_total).toBe(1);
    expect(row?.changes_done).toBe(1);
    expect(row?.workdir_path).toBe(workdir);
    expect(row?.plan_path).toBeTruthy();
    expect(row?.claude_session_id).toBe("sess-plan");
  });

  it("plan_empty: failureReason and phase='failed'", async () => {
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith({
        runPlanPhase: vi.fn(async () => ({
          planMd: "",
          sessionId: null,
          exitCode: 0,
          eventCount: 0,
          stderr: "",
        })) as PhaseRunner["runPlanPhase"],
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failureReason).toBe("plan_empty");
    const row = await buildsRepo.findById(result.build_id);
    expect(row?.phase).toBe("failed");
  });

  it("decompose_empty: failureReason and no apply called", async () => {
    const applySpy = vi.fn(async () => ({
      exitCode: 0,
      eventCount: 0,
      sessionId: null,
      stderr: "",
    })) as PhaseRunner["runApplyPhase"];
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith({
        runDecomposePhase: vi.fn(async () => ({
          changeIds: [],
          sessionId: null,
          exitCode: 0,
          eventCount: 0,
          stderr: "",
        })) as PhaseRunner["runDecomposePhase"],
        runApplyPhase: applySpy,
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failureReason).toBe("decompose_empty");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("apply_failed: failureReason names the change, validate not called", async () => {
    const validateSpy = vi.fn(async () => ({
      ok: true,
      findings: [],
      perCheck: {},
    })) as PhaseRunner["runValidationChecks"];
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith({
        runApplyPhase: vi.fn(async () => ({
          exitCode: 2,
          eventCount: 0,
          sessionId: null,
          stderr: "",
        })) as PhaseRunner["runApplyPhase"],
        runValidationChecks: validateSpy,
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failureReason).toBe("apply_failed_add-weight");
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("validation_failed: captures the report and short-circuits", async () => {
    const failReport: ValidationReport = {
      ok: false,
      findings: [
        { severity: "error", check: "x", message: "y" },
      ],
      perCheck: { x: [{ severity: "error", check: "x", message: "y" }] },
    };
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith({
        runDecomposePhase: vi.fn(async () => ({
          changeIds: ["add-weight", "add-second"],
          sessionId: null,
          exitCode: 0,
          eventCount: 0,
          stderr: "",
        })) as PhaseRunner["runDecomposePhase"],
        runValidationChecks: vi.fn(async () => failReport) as PhaseRunner["runValidationChecks"],
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.failureReason).toBe("validation_failed_add-weight");
    expect(result.validationReports["add-weight"]?.ok).toBe(false);
    expect(result.validationReports["add-second"]).toBeUndefined();
  });

  it("multi-change happy path: every change applied + validated", async () => {
    const applySpy = vi.fn(async () => ({
      exitCode: 0,
      eventCount: 0,
      sessionId: null,
      stderr: "",
    })) as PhaseRunner["runApplyPhase"];
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith({
        runDecomposePhase: vi.fn(async () => ({
          changeIds: ["a", "b", "c"],
          sessionId: null,
          exitCode: 0,
          eventCount: 0,
          stderr: "",
        })) as PhaseRunner["runDecomposePhase"],
        runApplyPhase: applySpy,
      }),
    });
    expect(result.status).toBe("ready_for_integration");
    if (result.status !== "ready_for_integration") throw new Error("expected ready");
    expect(applySpy).toHaveBeenCalledTimes(3);
    const row = await buildsRepo.findById(result.build_id);
    expect(row?.changes_done).toBe(3);
  });

  it("aborted signal cancels the build", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: depsWith(),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    const row = await buildsRepo.findById(result.build_id);
    expect(row?.phase).toBe("cancelled");
  });

  it("calls progressForwarder.onPhase at each transition", async () => {
    const phases: string[] = [];
    const forwarder = {
      onPhase: (name: string) => phases.push(name),
      onEvent: () => {},
    } as unknown as BuildOrchestratorDeps["progressForwarder"];
    const result = await runBuild({
      proposalId,
      sessionId: "s-build",
      deps: { ...depsWith(), progressForwarder: forwarder },
    });
    expect(result.status).toBe("ready_for_integration");
    expect(phases).toContain("plan");
    expect(phases).toContain("decompose");
    expect(phases).toContain("apply:add-weight");
    expect(phases).toContain("validate:add-weight");
    expect(phases).toContain("integrate");
  });

  it("throws when the proposal_id is missing (programmer error)", async () => {
    await expect(
      runBuild({
        proposalId: 99999,
        sessionId: "s-build",
        deps: depsWith(),
      }),
    ).rejects.toThrow(/proposal #99999 not found/);
  });
});
