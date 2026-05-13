/**
 * Re-extraction strategies — shared LLM helper.
 *
 * Both `reextract_raw_events` and `reextract_messages` differ only in
 * where the context text comes from. Everything else (diff parse, prompt
 * render, LLM call, response parse, conditional UPDATE) lives here.
 */
import { z } from "zod";

import type { CapabilityRegistryRow } from "../../db/repositories/capability_registry.js";
import type {
  ReextractRow,
  ReextractRunDeps,
  StrategyOutcome,
} from "../types.js";
import type { ReextractJobRow } from "../../db/repositories/reextract_jobs.js";

export const LlmFieldDiffSchema = z.object({
  kind: z.literal("llm_field"),
  target_column: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
  extract_prompt: z.string().min(1),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
});

export type LlmFieldDiff = z.infer<typeof LlmFieldDiffSchema>;

export const LlmInferResponseSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1),
});

export function renderLlmPrompt(template: string, contextText: string): string {
  return template.replace(/\{\{\s*context\s*\}\}/g, contextText);
}

const LOW_CONFIDENCE_FLOOR = 0.3;

interface CachedContext {
  diff: LlmFieldDiff;
  cap: CapabilityRegistryRow;
}

function getCache(job: ReextractJobRow): CachedContext | undefined {
  return (job as unknown as { __llm_cache?: CachedContext }).__llm_cache;
}

function setCache(job: ReextractJobRow, value: CachedContext): void {
  (job as unknown as { __llm_cache?: CachedContext }).__llm_cache = value;
}

export async function runLlmReextract(
  row: ReextractRow,
  job: ReextractJobRow,
  deps: ReextractRunDeps,
  contextText: string,
): Promise<StrategyOutcome> {
  if (!deps.llmClient) {
    return { kind: "failed", error: "llmClient_not_wired" };
  }

  let cached = getCache(job);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(evolution.diff);
    } catch (err) {
      return {
        kind: "failed",
        error: `schema_evolution.diff is not valid JSON: ${(err as Error).message}`,
      };
    }
    const result = LlmFieldDiffSchema.safeParse(parsed);
    if (!result.success) {
      return {
        kind: "failed",
        error: `schema_evolution.diff does not match llm_field shape: ${result.error.message}`,
      };
    }
    const cap = await deps.capabilityRegistryRepo.findById(job.capability_name);
    if (!cap) {
      return {
        kind: "failed",
        error: `capability_registry.findById('${job.capability_name}') returned null`,
      };
    }
    cached = { diff: result.data, cap };
    setCache(job, cached);
  }

  const { diff, cap } = cached;
  // Already-set guard.
  const existing = deps.db
    .prepare(
      `SELECT ${diff.target_column} AS v FROM ${cap.primary_table} WHERE id = ?`,
    )
    .get(row.id) as { v: unknown } | undefined;
  if (existing && existing.v !== null && existing.v !== undefined && existing.v !== "") {
    return { kind: "skipped", reason: "already_set" };
  }

  const prompt = renderLlmPrompt(diff.extract_prompt, contextText);
  let raw: string;
  try {
    raw = await deps.llmClient.infer({
      system:
        "You are filling in one column of a Strata capability's business table. Respond with ONE JSON object: { \"value\": <the value>, \"confidence\": <0..1> }. Nothing else.",
      user: prompt,
    });
  } catch (err) {
    return {
      kind: "failed",
      error: `llmClient.infer failed: ${(err as Error).message}`,
    };
  }

  let parsedResp: unknown;
  try {
    parsedResp = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "failed",
      error: `LLM response is not JSON: ${(err as Error).message}`,
    };
  }
  const respResult = LlmInferResponseSchema.safeParse(parsedResp);
  if (!respResult.success) {
    return {
      kind: "failed",
      error: `LLM response does not match expected shape: ${respResult.error.message}`,
    };
  }
  const { value, confidence } = respResult.data;

  if (confidence < LOW_CONFIDENCE_FLOOR) {
    return {
      kind: "failed",
      error: `confidence ${confidence} < ${LOW_CONFIDENCE_FLOOR}; value discarded`,
    };
  }

  try {
    deps.db
      .prepare(
        `UPDATE ${cap.primary_table} SET ${diff.target_column} = ? WHERE id = ?`,
      )
      .run(value as never, row.id);
  } catch (err) {
    return {
      kind: "failed",
      error: `UPDATE failed: ${(err as Error).message}`,
    };
  }

  if (confidence >= diff.confidence_threshold) {
    return { kind: "wrote", confidence };
  }
  return { kind: "low_confidence", confidence };
}
