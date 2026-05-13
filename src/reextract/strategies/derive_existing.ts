/**
 * `derive_existing` strategy. The cheapest re-extract: no LLM, no model
 * calls. Reads the linked `schema_evolutions.diff` JSON which describes a
 * one-shot transform — copy a column or fill a constant — and applies it
 * to each capability row. Idempotent via `WHERE <target> IS NULL`.
 */
import { z } from "zod";

import { ValidationError } from "../../core/errors.js";
import type { CapabilityRegistryRow } from "../../db/repositories/capability_registry.js";
import type { ReextractStrategy, StrategyOutcome } from "../types.js";

const DiffSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("constant"),
    target_column: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    kind: z.literal("copy"),
    target_column: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
    source_column: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
  }),
]);

type DerivationDiff = z.infer<typeof DiffSchema>;

interface CachedDiff {
  evolutionId: number;
  diff: DerivationDiff;
  primaryTable: string;
}

export const deriveExistingStrategy: ReextractStrategy = {
  name: "derive_existing",
  async process(row, job, deps): Promise<StrategyOutcome> {
    // Cached lookup of schema_evolutions.diff per job invocation.
    let cached = (job as unknown as { __derive_cached?: CachedDiff }).__derive_cached;
    if (!cached) {
      const evolution = await deps.schemaEvolutionsRepo.findById(
        job.schema_evolution_id,
      );
      if (!evolution) {
        return {
          kind: "failed",
          error: `schema_evolution #${job.schema_evolution_id} not found`,
        };
      }
      let parsedDiff: unknown;
      try {
        parsedDiff = JSON.parse(evolution.diff);
      } catch (err) {
        return {
          kind: "failed",
          error: `schema_evolution.diff is not valid JSON: ${(err as Error).message}`,
        };
      }
      const result = DiffSchema.safeParse(parsedDiff);
      if (!result.success) {
        return {
          kind: "failed",
          error: `schema_evolution.diff does not match derive_existing shape: ${result.error.message}`,
        };
      }
      const cap = await deps.capabilityRegistryRepo.findById(job.capability_name);
      if (!cap) {
        return {
          kind: "failed",
          error: `capability_registry.findById('${job.capability_name}') returned null`,
        };
      }
      cached = {
        evolutionId: evolution.id,
        diff: result.data,
        primaryTable: (cap as CapabilityRegistryRow).primary_table,
      };
      (job as unknown as { __derive_cached?: CachedDiff }).__derive_cached = cached;
    }

    const { diff, primaryTable } = cached;
    try {
      if (diff.kind === "constant") {
        const stmt = deps.db.prepare(
          `UPDATE ${primaryTable} SET ${diff.target_column} = ? WHERE id = ? AND ${diff.target_column} IS NULL`,
        );
        const info = stmt.run(diff.value as never, row.id);
        return info.changes === 0
          ? { kind: "skipped", reason: "already_set" }
          : { kind: "wrote", confidence: 1.0 };
      }
      // copy
      const stmt = deps.db.prepare(
        `UPDATE ${primaryTable} SET ${diff.target_column} = ${diff.source_column} WHERE id = ? AND ${diff.target_column} IS NULL`,
      );
      const info = stmt.run(row.id);
      return info.changes === 0
        ? { kind: "skipped", reason: "already_set" }
        : { kind: "wrote", confidence: 1.0 };
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      return {
        kind: "failed",
        error: `update failed: ${(err as Error).message}`,
      };
    }
  },
};
