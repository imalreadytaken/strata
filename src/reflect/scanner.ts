/**
 * Reflect Agent — raw_events scanner.
 *
 * Returns `committed` events in a time window. Used by the emergence
 * detector to bucket and decide which clusters cross the threshold.
 */
import type Database from "better-sqlite3";

import type { RawEventRow } from "../db/repositories/raw_events.js";

export interface ScanRawEventsDeps {
  db: Database.Database;
}

export interface ScanRawEventsOptions {
  sinceDays?: number;
  now?: () => Date;
}

const DEFAULT_SINCE_DAYS = 90;

export async function scanRawEvents(
  deps: ScanRawEventsDeps,
  opts: ScanRawEventsOptions = {},
): Promise<RawEventRow[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
  const rows = deps.db
    .prepare(
      "SELECT * FROM raw_events WHERE status = 'committed' AND created_at >= ? ORDER BY created_at ASC",
    )
    .all(cutoff);
  return rows as RawEventRow[];
}
