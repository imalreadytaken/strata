/**
 * Structured JSON logger for Strata.
 *
 * Every emitted record is one line: `JSON.stringify({ ts, level, msg, ...bindings, ...fields })`.
 * Records are appended to `<logsDir>/plugin.log` and optionally mirrored to stderr.
 * See `openspec/changes/add-core-infra/specs/core-infrastructure/spec.md`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** Minimum level that is emitted; lower-priority records are dropped. */
  level: LogLevel;
  /** Absolute path to the log file. Parent dir is created on first emit. */
  logFilePath: string;
  /** Mirror records to `process.stderr` as well. Default: `false`. */
  toStderr?: boolean;
  /** Default fields merged into every record (e.g. `{ module: 'db' }`). */
  bindings?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger whose bindings extend this logger's bindings. */
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerState {
  level: LogLevel;
  logFilePath: string;
  toStderr: boolean;
  bindings: Readonly<Record<string, unknown>>;
  /** Set after the parent directory has been ensured. */
  dirReady: boolean;
}

function emit(state: LoggerState, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

  if (!state.dirReady) {
    mkdirSync(path.dirname(state.logFilePath), { recursive: true });
    state.dirReady = true;
  }

  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...state.bindings,
    ...(fields ?? {}),
  };
  const line = JSON.stringify(record) + "\n";

  appendFileSync(state.logFilePath, line);
  if (state.toStderr) {
    process.stderr.write(line);
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const state: LoggerState = {
    level: opts.level,
    logFilePath: opts.logFilePath,
    toStderr: opts.toStderr ?? false,
    bindings: Object.freeze({ ...(opts.bindings ?? {}) }),
    dirReady: false,
  };
  return makeLogger(state);
}

function makeLogger(state: LoggerState): Logger {
  return {
    debug: (msg, fields) => emit(state, "debug", msg, fields),
    info: (msg, fields) => emit(state, "info", msg, fields),
    warn: (msg, fields) => emit(state, "warn", msg, fields),
    error: (msg, fields) => emit(state, "error", msg, fields),
    child(bindings: Record<string, unknown>): Logger {
      const childState: LoggerState = {
        ...state,
        bindings: Object.freeze({ ...state.bindings, ...bindings }),
      };
      return makeLogger(childState);
    },
  };
}
