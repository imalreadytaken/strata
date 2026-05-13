/**
 * Session-scoped pending-event buffer.
 *
 * In-memory `Map<session_id, Set<event_id>>` mirrored to disk after every
 * mutation. Constructed at boot from `<dataDir>/.strata-state/pending_buffer.json`
 * so a plugin restart picks up where it left off.
 *
 * See `openspec/changes/add-pending-buffer/specs/pending-buffer/spec.md`.
 */
import type { Logger } from "../core/logger.js";
import {
  readState,
  writeState,
  type PendingBufferState,
} from "./persistence.js";

export interface PendingBufferOptions {
  /** Absolute path to the on-disk state file. */
  stateFile: string;
  /** Optional logger for persistence-failure warnings. */
  logger?: Logger;
}

export class PendingBuffer {
  private readonly stateFile: string;
  private readonly logger: Logger | undefined;
  private readonly state: Map<string, Set<number>>;

  constructor(opts: PendingBufferOptions) {
    this.stateFile = opts.stateFile;
    this.logger = opts.logger;
    this.state = new Map();
    const initial = readState(opts.stateFile);
    for (const [sessionId, ids] of Object.entries(initial)) {
      this.state.set(sessionId, new Set(ids));
    }
  }

  async add(session_id: string, event_id: number): Promise<void> {
    let set = this.state.get(session_id);
    if (!set) {
      set = new Set<number>();
      this.state.set(session_id, set);
    }
    if (set.has(event_id)) return; // idempotent
    set.add(event_id);
    this.persist();
  }

  async has(session_id: string, event_id: number): Promise<boolean> {
    return this.state.get(session_id)?.has(event_id) ?? false;
  }

  async getAll(session_id: string): Promise<number[]> {
    return [...(this.state.get(session_id) ?? [])];
  }

  async remove(session_id: string, event_id: number): Promise<void> {
    const set = this.state.get(session_id);
    if (!set?.has(event_id)) return; // idempotent
    set.delete(event_id);
    if (set.size === 0) this.state.delete(session_id);
    this.persist();
  }

  async clearSession(session_id: string): Promise<void> {
    if (!this.state.has(session_id)) return;
    this.state.delete(session_id);
    this.persist();
  }

  async snapshot(): Promise<PendingBufferState> {
    return this.toJSON();
  }

  private toJSON(): PendingBufferState {
    const out: PendingBufferState = {};
    for (const [sessionId, set] of this.state) {
      out[sessionId] = [...set];
    }
    return out;
  }

  private persist(): void {
    try {
      writeState(this.stateFile, this.toJSON());
    } catch (err) {
      this.logger
        ?.child({ module: "pending_buffer" })
        .warn("failed to persist pending buffer state", {
          stateFile: this.stateFile,
          error: (err as Error).message,
        });
    }
  }
}

export { startPendingTimeoutLoop } from "./timeout.js";
