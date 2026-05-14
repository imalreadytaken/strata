/**
 * Build Bridge — barrel. Re-exports the runner + workspace surfaces so
 * orchestrator code (future) has one import path.
 */
export {
  abortRunClaudeCode,
  parseStreamJsonLines,
  runClaudeCode,
  type RunClaudeCodeOptions,
  type RunClaudeCodeResult,
  type RunHandle,
  type RunMode,
  type StreamJsonEvent,
} from "./claude_code_runner.js";

export {
  cleanupBuildWorkspace,
  renderUserContext,
  setupBuildWorkspace,
  type BuildContext,
  type BuildWorkspaceHandle,
  type RenderUserContextOptions,
  type SetupBuildWorkspaceOptions,
} from "./workspace.js";

export {
  parseCreateTables,
  runValidationChecks,
  STANDARD_VALIDATION_CHECKS,
  type ValidationCheck,
  type ValidationContext,
  type ValidationFinding,
  type ValidationReport,
} from "./validator.js";

export {
  BuildProgressForwarder,
  formatStreamJsonEvent,
  summarizeToolResult,
  summarizeToolUse,
  type BuildProgressForwarderOptions,
} from "./progress_forwarder.js";

export {
  DECOMPOSE_PROMPT_TEMPLATE,
  PLAN_PROMPT_TEMPLATE,
  renderDecomposePrompt,
  renderPlanPrompt,
  runDecomposePhase,
  runPlanPhase,
  type DecomposePhaseResult,
  type PlanPhaseResult,
  type PlanProposal,
  type RunDecomposePhaseOptions,
  type RunPlanPhaseOptions,
} from "./phases.js";

export {
  runApplyPhase,
  runBuild,
  type ApplyPhaseResult,
  type BuildOrchestratorDeps,
  type BuildRunResult,
  type PhaseRunner,
  type RunApplyPhaseOptions,
  type RunBuildOptions,
} from "./orchestrator.js";

export {
  runIntegration,
  type IntegratedCapability,
  type IntegrationDeps,
  type IntegrationResult,
  type RunIntegrationOptions,
} from "./integration.js";
