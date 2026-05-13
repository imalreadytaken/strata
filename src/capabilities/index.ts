export {
  CapabilityMetaSchema,
  type CapabilityMeta,
  type DiscoveredCapability,
  type LoadedCapability,
  type CapabilityRegistry,
} from "./types.js";
export { discoverCapabilities } from "./discover.js";
export {
  applyCapabilityMigrations,
  type CapabilityMigrationSummary,
} from "./migrations.js";
export { loadCapabilities, type LoadCapabilitiesDeps } from "./loader.js";
