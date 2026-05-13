/**
 * Re-extraction Worker — barrel.
 */
export type {
  ReextractJobOutcome,
  ReextractRow,
  ReextractRunDeps,
  ReextractStrategy,
  StrategyOutcome,
} from "./types.js";

export {
  defaultRegistry,
  ReextractStrategyRegistry,
} from "./registry.js";

export { runReextractJob } from "./runner.js";

export {
  pickNextPendingJob,
  startReextractWorker,
  type StartReextractWorkerOptions,
  type WorkerDeps,
} from "./worker.js";

export { deriveExistingStrategy } from "./strategies/derive_existing.js";
export {
  LlmFieldDiffSchema,
  LlmInferResponseSchema,
  renderLlmPrompt,
  runLlmReextract,
  type LlmFieldDiff,
} from "./strategies/llm_shared.js";
export { reextractRawEventsStrategy } from "./strategies/reextract_raw_events.js";
export { reextractMessagesStrategy } from "./strategies/reextract_messages.js";
