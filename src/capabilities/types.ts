/**
 * Strata capability metadata + loader output types.
 *
 * `CapabilityMetaSchema` matches the contract in `openspec/AGENTS.md`
 * "meta.json schema". Validated at boot by `loadCapabilities(...)`.
 */
import { z } from "zod";

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const SNAKE_RE = /^[a-z][a-z0-9_]*$/;

export const CapabilityMetaSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_RE, "name must be kebab/snake-case starting with a letter"),
    version: z.number().int().positive(),
    description: z.string().min(1),
    primary_table: z
      .string()
      .regex(SNAKE_RE, "primary_table must be snake_case starting with a letter"),
    depends_on_capabilities: z.array(z.string()).default([]),
    ingest_event_types: z.array(z.string()).default([]),
    owner_pipeline: z.string().default("pipeline.ts"),
    exposed_skills: z.array(z.string()).default([]),
  })
  .strict();

export type CapabilityMeta = z.infer<typeof CapabilityMetaSchema>;

/**
 * Result of `discoverCapabilities`: enough info to read `meta.json` and run
 * migrations, no parsing done yet.
 */
export interface DiscoveredCapability {
  /** Capability name as read from the directory. */
  name: string;
  /** Numeric version selected (1 from `v1`, 2 from `v2`, … or NaN when picked via `current`). */
  version: number;
  /** Absolute path to the versioned directory (`.../expenses/v1` or `.../expenses/current`). */
  path: string;
  /** Absolute path to `meta.json` inside `path`. */
  metaPath: string;
  /** Absolute path to `migrations/` inside `path`. May not exist. */
  migrationsPath: string;
}

/** Loader output: validated meta + paths, ready for the pipeline runner. */
export interface LoadedCapability {
  meta: CapabilityMeta;
  /** Path to the active version dir (e.g. `.../expenses/v1` or `.../expenses/current`). */
  path: string;
  /** Path to the validated `meta.json` (recorded into `capability_registry.meta_path`). */
  metaPath: string;
}

export type CapabilityRegistry = Map<string, LoadedCapability>;
