/**
 * expenses capability — ingest pipeline.
 *
 * Called by `runPipeline` when a `raw_event` whose `capability_name = 'expenses'`
 * transitions to `committed`. Parses `rawEvent.extracted_data` with a Zod
 * schema, resolves `occurred_at` (event time > extracted time > created_at),
 * INSERTs one `expenses` row, returns its id.
 *
 * Do NOT wrap writes in `db.transaction(...)` — the runner already opens a
 * transaction around the entire `ingest` call (see
 * `src/capabilities/pipeline_runner.ts`, design.md D2 and D5).
 *
 * See `openspec/changes/add-expenses-capability/specs/expenses-capability/spec.md`.
 */
import { z } from "zod";

import type {
  PipelineDeps,
  PipelineIngestResult,
} from "../../pipeline_runner.js";
import type { RawEventRow } from "../../../db/repositories/raw_events.js";

const CATEGORIES = [
  "dining",
  "transport",
  "groceries",
  "entertainment",
  "service",
  "health",
  "other",
] as const;

const ExtractedExpenseSchema = z.object({
  amount_minor: z.number().int().nonnegative(),
  currency: z.string().min(1).default("CNY"),
  merchant: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  occurred_at: z.string().min(1).optional(),
});

export async function ingest(
  rawEvent: RawEventRow,
  deps: PipelineDeps,
): Promise<PipelineIngestResult> {
  const parsed = ExtractedExpenseSchema.parse(
    JSON.parse(rawEvent.extracted_data),
  );
  const occurred_at =
    rawEvent.event_occurred_at ?? parsed.occurred_at ?? rawEvent.created_at;
  const now = deps.now();

  const row = deps.db
    .prepare(
      `INSERT INTO expenses (
         raw_event_id,
         extraction_version,
         extraction_confidence,
         occurred_at,
         amount_minor,
         currency,
         merchant,
         category,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      rawEvent.id,
      rawEvent.extraction_version,
      rawEvent.extraction_confidence,
      occurred_at,
      parsed.amount_minor,
      parsed.currency,
      parsed.merchant ?? null,
      parsed.category ?? null,
      now,
      now,
    ) as { id: number };

  return { business_row_id: row.id, business_table: "expenses" };
}
