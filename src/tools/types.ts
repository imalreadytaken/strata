/**
 * Shared types for Strata's agent tools.
 *
 * OpenClaw's public `AnyAgentTool` is `AgentTool<any, unknown> & { ownerOnly? }`.
 * We mirror the minimum shape we actually populate so this file does not have
 * to follow the SDK's deep type chains. The cast in `tools/index.ts::buildTools`
 * upgrades these objects to the SDK's expected type at the boundary.
 */
import type { CapabilityRegistry } from "../capabilities/types.js";
import type { PipelineToolDeps } from "../capabilities/pipeline_runner.js";
import type { Logger } from "../core/logger.js";
import type { BuildsRepository } from "../db/repositories/builds.js";
import type { CapabilityHealthRepository } from "../db/repositories/capability_health.js";
import type { CapabilityRegistryRepository } from "../db/repositories/capability_registry.js";
import type { ProposalsRepository } from "../db/repositories/proposals.js";
import type { RawEventsRepository } from "../db/repositories/raw_events.js";
import type { SchemaEvolutionsRepository } from "../db/repositories/schema_evolutions.js";
import type { PendingBuffer } from "../pending_buffer/index.js";
import type { BuildProgressForwarder } from "../build/progress_forwarder.js";
import type { runBuild as runBuildFn } from "../build/orchestrator.js";
import type { runIntegration as runIntegrationFn } from "../build/integration.js";
import type Database from "better-sqlite3";
import type { ToolResult } from "./result.js";

/** Optional deps the `strata_run_build` tool needs to dispatch end-to-end. */
export interface BuildToolDeps {
  db: Database.Database;
  buildsRepo: BuildsRepository;
  capabilityRegistryRepo: CapabilityRegistryRepository;
  capabilityHealthRepo: CapabilityHealthRepository;
  schemaEvolutionsRepo: SchemaEvolutionsRepository;
  capabilities: CapabilityRegistry;
  agentsMdSource: string;
  buildsDir: string;
  userCapabilitiesDir: string;
  maxTurnsPerPhase: number;
  progressForwarder?: BuildProgressForwarder;
  /** Injectable for tests. Defaults to the real implementations. */
  runBuild?: typeof runBuildFn;
  runIntegration?: typeof runIntegrationFn;
}

export interface AnyAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    rawParams: unknown,
  ) => Promise<ToolResult<unknown>>;
}

/** Dependency bag every tool factory accepts. */
export interface EventToolDeps {
  rawEventsRepo: RawEventsRepository;
  proposalsRepo: ProposalsRepository;
  pendingBuffer: PendingBuffer;
  sessionId: string;
  logger: Logger;
  /**
   * Pipeline-runner deps for `commitEventCore`. Optional so unit tests that
   * don't care about capability writes can omit it. When supplied AND the
   * committed event has a `capability_name`, the bound pipeline runs.
   */
  pipelineDeps?: PipelineToolDeps;
  /**
   * Build Bridge deps for `strata_run_build`. Optional so non-build tests
   * + the heuristic-only paths don't have to populate the full bag.
   */
  buildDeps?: BuildToolDeps;
}
