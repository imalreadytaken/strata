/**
 * Background loop that drains stale `pending` raw_events:
 *
 *   confidence >= 0.7   →  auto-commit  (status='committed', committed_at = now)
 *   otherwise           →  auto-abandon (status='abandoned', abandoned_reason='pending_timeout')
 *
 * Either way, the matching session+id is removed from the in-memory buffer so
 * a follow-up message doesn't try to extend a row that's no longer live.
 *
 * See `openspec/changes/add-pending-buffer/specs/pending-buffer/spec.md`.
 */
import type { Logger } from "../core/logger.js";
import type {
  RawEventRow,
  RawEventsRepository,
} from "../db/repositories/raw_events.js";
import type { PendingBuffer } from "./index.js";

export const AUTO_COMMIT_CONFIDENCE_THRESHOLD = 0.7;

export interface PendingTimeoutDeps {
  pendingBuffer: PendingBuffer;
  rawEventsRepo: RawEventsRepository;
  timeoutMinutes: number;
  logger: Logger;
  pollEveryMs?: number;
  now?: () => string;
}

/**
 * Schedule the timeout drain. Returns a `stop()` handle that clears the
 * interval and is safe to call multiple times.
 */
export function startPendingTimeoutLoop(
  deps: PendingTimeoutDeps,
): () => void {
  const pollEveryMs = deps.pollEveryMs ?? 60_000;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.logger.child({ module: "pending_buffer.timeout" });

  const tick = async (): Promise<void> => {
    let rows: RawEventRow[] = [];
    try {
      rows = await deps.rawEventsRepo.findExpiredPending(deps.timeoutMinutes);
    } catch (err) {
      log.error("findExpiredPending failed", { error: (err as Error).message });
      return;
    }

    for (const row of rows) {
      const ts = now();
      const highConfidence =
        row.extraction_confidence !== null &&
        row.extraction_confidence >= AUTO_COMMIT_CONFIDENCE_THRESHOLD;

      try {
        if (highConfidence) {
          await deps.rawEventsRepo.update(row.id, {
            status: "committed",
            committed_at: ts,
            updated_at: ts,
          });
          log.info("auto-committed pending event past timeout", {
            event_id: row.id,
            session_id: row.session_id,
            confidence: row.extraction_confidence,
          });
        } else {
          await deps.rawEventsRepo.update(row.id, {
            status: "abandoned",
            abandoned_reason: "pending_timeout",
            updated_at: ts,
          });
          log.info("auto-abandoned pending event past timeout", {
            event_id: row.id,
            session_id: row.session_id,
            confidence: row.extraction_confidence,
          });
        }
      } catch (err) {
        log.error("failed to transition expired pending event", {
          event_id: row.id,
          error: (err as Error).message,
        });
        continue;
      }
      await deps.pendingBuffer.remove(row.session_id, row.id);
    }
  };

  let stopped = false;
  const handle = setInterval(() => {
    void tick();
  }, pollEveryMs);

  return (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}
