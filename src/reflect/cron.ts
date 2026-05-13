/**
 * Reflect Agent — weekly cron.
 *
 * `setInterval` ticks every `intervalMs` (default 1h) and checks whether
 * the current `now` is inside the configured one-hour fire window
 * (default Sunday 03:00). The "already fired this week" check reads
 * recent `reflect_agent` proposals from the DB so a restart mid-window
 * doesn't double-fire.
 */
import type { Logger } from "../core/logger.js";
import type { ProposalsRepository } from "../db/repositories/proposals.js";
import { runReflectOnce, type ReflectRunDeps } from "./runner.js";

export interface ReflectSchedule {
  /** 0 = Sunday, 6 = Saturday. */
  dayOfWeek: number;
  /** 0–23 in local time. */
  hour: number;
}

export const DEFAULT_REFLECT_SCHEDULE: ReflectSchedule = {
  dayOfWeek: 0,
  hour: 3,
};

const DEFAULT_INTERVAL_MS = 3_600_000;
const ONE_WEEK_MS = 7 * 86_400_000;

export interface StartReflectAgentOptions {
  schedule?: Partial<ReflectSchedule>;
  intervalMs?: number;
  now?: () => Date;
}

interface StartDeps extends ReflectRunDeps {
  proposalsRepo: ProposalsRepository;
  logger: Logger;
}

export async function alreadyFiredThisWeek(
  proposalsRepo: ProposalsRepository,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - 6 * 86_400_000).toISOString();
  const rows = await proposalsRepo.findMany({ source: "reflect_agent" });
  return rows.some((r) => r.created_at && r.created_at >= cutoff);
}

export function startReflectAgent(
  deps: StartDeps,
  opts: StartReflectAgentOptions = {},
): () => void {
  const log = deps.logger.child({ module: "reflect.cron" });
  const schedule: ReflectSchedule = {
    ...DEFAULT_REFLECT_SCHEDULE,
    ...opts.schedule,
  };
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const nowFn = opts.now ?? (() => new Date());

  const tick = async (): Promise<void> => {
    const now = nowFn();
    if (now.getDay() !== schedule.dayOfWeek) return;
    if (now.getHours() !== schedule.hour) return;
    if (await alreadyFiredThisWeek(deps.proposalsRepo, now)) {
      log.debug("reflect already fired this week; skipping tick");
      return;
    }
    log.info("reflect cron firing", { now: now.toISOString() });
    try {
      const tickDeps = {
        ...deps,
        ...(opts.now ? { now: opts.now } : {}),
      };
      const result = await runReflectOnce(tickDeps);
      log.info("reflect run complete", {
        signals: result.signals.length,
        inserted: result.generated.inserted.length,
        pushed: result.pushed,
      });
    } catch (err) {
      log.error("reflect run threw", { error: (err as Error).message });
    }
  };

  let handle: ReturnType<typeof setInterval> | null = setInterval(() => {
    void tick();
  }, intervalMs);

  log.info("reflect cron started", { schedule, intervalMs });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) {
      clearInterval(handle);
      handle = null;
    }
    log.info("reflect cron stopped");
  };
}

// Re-export for tests / future consumers.
export const _WINDOW_MS = ONE_WEEK_MS;
