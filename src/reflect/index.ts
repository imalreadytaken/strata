/**
 * Reflect Agent — barrel.
 */
export {
  REFLECT_THRESHOLDS,
  type DecaySignal,
  type EmergenceSignal,
  type EvolutionSignal,
  type ReflectSignal,
  type ReflectThresholds,
} from "./types.js";

export { scanRawEvents, type ScanRawEventsOptions } from "./scanner.js";

export {
  detectNewCapabilityEmergence,
  detectSchemaEvolutionNeed,
  type DetectEmergenceOptions,
  type EmergenceDeps,
} from "./emergence_detector.js";

export {
  detectArchiveCandidates,
  type DecayDeps,
  type DetectDecayOptions,
} from "./decay_detector.js";

export {
  generateProposals,
  renderProposalCard,
  type GenerateProposalsDeps,
  type GenerateProposalsResult,
  type ProposalCard,
  type SkippedReason,
} from "./proposal_generator.js";

export { pushProposalsToUser, type PushDeps } from "./push.js";

export {
  runReflectOnce,
  type ReflectRunDeps,
  type ReflectRunResult,
} from "./runner.js";

export {
  alreadyFiredThisWeek,
  DEFAULT_REFLECT_SCHEDULE,
  startReflectAgent,
  type ReflectSchedule,
  type StartReflectAgentOptions,
} from "./cron.js";

export {
  buildReflectKeyboard,
  handleReflectCallback,
  parseReflectPayload,
  type ParsedReflectPayload,
  type ReflectButton,
  type ReflectCallbackAction,
  type ReflectCallbackDeps,
  type ReflectKeyboard,
} from "./callback.js";
