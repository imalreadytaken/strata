/**
 * Re-extraction worker. `setInterval` ticks every `intervalMs` (default 30s)
 * and picks the lowest-id `pending` job. Transitions it `running → done/failed`.
 * All exceptions are warn-logged + `last_error`-stamped; the next tick
 * continues regardless. `enabled=false` means no timer is ever registered.
 */
import type { Logger } from "../core/logger.js";
import type {
  ReextractJobRow,
  ReextractJobsRepository,
} from "../db/repositories/reextract_jobs.js";
import { defaultRegistry, type ReextractStrategyRegistry } from "./registry.js";
import { runReextractJob } from "./runner.js";
import type { ReextractRunDeps } from "./types.js";

const DEFAULT_INTERVAL_MS = 30_000;

export interface WorkerDeps extends ReextractRunDeps {
  reextractJobsRepo: ReextractJobsRepository;
}

export interface StartReextractWorkerOptions {
  enabled?: boolean;
  intervalMs?: number;
  registry?: ReextractStrategyRegistry;
  now?: () => Date;
}

export async function pickNextPendingJob(
  repo: ReextractJobsRepository,
): Promise<ReextractJobRow | null> {
  const rows = await repo.findMany(
    { status: "pending" },
    { orderBy: "id", direction: "asc", limit: 1 },
  );
  return rows[0] ?? null;
}

export function startReextractWorker(
  deps: WorkerDeps,
  opts: StartReextractWorkerOptions = {},
): () => void {
  const log = deps.logger.child({ module: "reextract.worker" });
  if (opts.enabled === false) {
    log.info("reextract worker disabled by config");
    return () => {};
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const registry = opts.registry ?? defaultRegistry;
  const now = opts.now ?? deps.now ?? (() => new Date());

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // skip when previous tick still in flight
    running = true;
    try {
      const job = await pickNextPendingJob(deps.reextractJobsRepo);
      if (!job) return;

      try {
        await deps.reextractJobsRepo.update(job.id, {
          status: "running",
          started_at: now().toISOString(),
        });
      } catch (err) {
        log.warn("failed to transition job to running", {
          job_id: job.id,
          error: (err as Error).message,
        });
        return;
      }

      try {
        const outcome = await runReextractJob(job, deps, registry);
        await deps.reextractJobsRepo.update(job.id, {
          status: outcome.status,
          rows_done: outcome.rows_done,
          rows_failed: outcome.rows_failed,
          rows_low_confidence: outcome.rows_low_confidence,
          actual_cost_cents: outcome.cost_cents,
          completed_at: now().toISOString(),
          last_error: outcome.last_error ?? null,
        });
        log.info("reextract job complete", {
          job_id: job.id,
          status: outcome.status,
          rows_done: outcome.rows_done,
          rows_failed: outcome.rows_failed,
          rows_low_confidence: outcome.rows_low_confidence,
        });
      } catch (err) {
        await deps.reextractJobsRepo.update(job.id, {
          status: "failed",
          completed_at: now().toISOString(),
          last_error: (err as Error).message,
        });
        log.error("reextract job threw", {
          job_id: job.id,
          error: (err as Error).message,
        });
      }
    } catch (err) {
      log.error("reextract worker tick threw outside job loop", {
        error: (err as Error).message,
      });
    } finally {
      running = false;
    }
  };

  let handle: ReturnType<typeof setInterval> | null = setInterval(() => {
    void tick();
  }, intervalMs);
  log.info("reextract worker started", { intervalMs });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) {
      clearInterval(handle);
      handle = null;
    }
    log.info("reextract worker stopped");
  };
}
