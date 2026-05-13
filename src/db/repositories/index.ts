/**
 * Strata repository implementations.
 * One class per system table, plus a generic SQLite base.
 */
export { SQLiteRepository, type SQLiteRepositoryOptions } from "./base.js";

export {
  MessagesRepository,
  type MessageRow,
} from "./messages.js";

export {
  RawEventsRepository,
  type RawEventRow,
  type RawEventStatus,
} from "./raw_events.js";

export {
  CapabilityRegistryRepository,
  type CapabilityRegistryRow,
  type CapabilityStatus,
} from "./capability_registry.js";

export {
  SchemaEvolutionsRepository,
  type SchemaEvolutionRow,
  type SchemaEvolutionChangeType,
  type BackfillStatus,
} from "./schema_evolutions.js";

export {
  ReextractJobsRepository,
  type ReextractJobRow,
  type ReextractJobStatus,
} from "./reextract_jobs.js";

export {
  BuildsRepository,
  type BuildRow,
  type BuildPhase,
  type BuildTriggerKind,
  type BuildTargetAction,
} from "./builds.js";

export {
  ProposalsRepository,
  type ProposalRow,
  type ProposalSource,
  type ProposalKind,
  type ProposalStatus,
} from "./proposals.js";

export {
  CapabilityHealthRepository,
  type CapabilityHealthRow,
} from "./capability_health.js";
