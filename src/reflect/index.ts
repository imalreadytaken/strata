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
