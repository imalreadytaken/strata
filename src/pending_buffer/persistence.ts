/**
 * Disk persistence for the session-scoped pending-event buffer.
 *
 * Format on disk:  { "<session_id>": [eventId, eventId, ...], ... }
 * Atomic write:    writeFileSync(tmp); renameSync(tmp, target)
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export type PendingBufferState = Record<string, number[]>;

/**
 * Read state from disk. Missing file or unparseable contents → `{}` (the
 * timeout loop will rescue any orphan rows still in raw_events on its next
 * tick). Caller is responsible for logging if they care about the distinction.
 */
export function readState(file: string): PendingBufferState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Other read errors (perm, etc.) also fall back to empty; we cannot
    // throw here without breaking buffer construction.
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: PendingBufferState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((n) => typeof n === "number")) {
        out[k] = v as number[];
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomic-write the state to disk. Creates the parent directory as needed.
 * Errors propagate to the caller — the buffer's own `persist()` wraps
 * this in a try/catch and logs at `warn` level rather than failing the
 * caller's mutation.
 */
export function writeState(file: string, state: PendingBufferState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, file);
}
