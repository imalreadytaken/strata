/**
 * Shared types for Strata's agent tools.
 *
 * OpenClaw's public `AnyAgentTool` is `AgentTool<any, unknown> & { ownerOnly? }`.
 * We mirror the minimum shape we actually populate so this file does not have
 * to follow the SDK's deep type chains. The cast in `tools/index.ts::buildTools`
 * upgrades these objects to the SDK's expected type at the boundary.
 */
import type { PipelineToolDeps } from "../capabilities/pipeline_runner.js";
import type { Logger } from "../core/logger.js";
import type { RawEventsRepository } from "../db/repositories/raw_events.js";
import type { PendingBuffer } from "../pending_buffer/index.js";
import type { ToolResult } from "./result.js";

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
  pendingBuffer: PendingBuffer;
  sessionId: string;
  logger: Logger;
  /**
   * Pipeline-runner deps for `commitEventCore`. Optional so unit tests that
   * don't care about capability writes can omit it. When supplied AND the
   * committed event has a `capability_name`, the bound pipeline runs.
   */
  pipelineDeps?: PipelineToolDeps;
}
