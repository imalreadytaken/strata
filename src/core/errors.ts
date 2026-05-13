/**
 * Typed error hierarchy for Strata. Every error carries a stable `code`
 * string callers can match on; messages are for humans and are free to change.
 *
 * See `openspec/changes/add-core-infra/specs/core-infrastructure/spec.md`
 * for the contract.
 */

/** Stable error codes used across the Strata codebase. Extend as needed. */
export type StrataErrorCode =
  | "STRATA_E_CONFIG_INVALID"
  | "STRATA_E_CONFIG_FORBIDDEN_KEY"
  | "STRATA_E_CONFIG_READ_FAILED"
  | "STRATA_E_DB_OPEN_FAILED"
  | "STRATA_E_DB_MIGRATE_FAILED"
  | "STRATA_E_DB_QUERY_FAILED"
  | "STRATA_E_VALIDATION"
  | "STRATA_E_NOT_FOUND"
  | "STRATA_E_STATE_TRANSITION";

export interface StrataErrorOptions {
  cause?: unknown;
}

/** Base class for every Strata-thrown error. */
export class StrataError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  constructor(code: string, message: string, options: StrataErrorOptions = {}) {
    super(message);
    this.code = code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    this.name = "StrataError";
    // Restore prototype chain — Error subclassing loses it on older Node otherwise.
    Object.setPrototypeOf(this, new.target.prototype);
    // Preserve V8 stack trace where available.
    const captureStackTrace = (Error as unknown as {
      captureStackTrace?: (target: object, ctor: Function) => void;
    }).captureStackTrace;
    if (typeof captureStackTrace === "function") {
      captureStackTrace(this, new.target);
    }
  }

  /** Stable JSON form suitable for logging. Avoids leaking stack traces. */
  toJSON(): {
    name: string;
    code: string;
    message: string;
    cause?: string;
  } {
    const out: { name: string; code: string; message: string; cause?: string } = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.cause !== undefined) {
      out.cause =
        this.cause instanceof Error ? this.cause.message : String(this.cause);
    }
    return out;
  }
}

export class ConfigError extends StrataError {
  constructor(code: string, message: string, options: StrataErrorOptions = {}) {
    super(code, message, options);
    this.name = "ConfigError";
  }
}

export class DatabaseError extends StrataError {
  constructor(code: string, message: string, options: StrataErrorOptions = {}) {
    super(code, message, options);
    this.name = "DatabaseError";
  }
}

export class ValidationError extends StrataError {
  constructor(
    code: string,
    message: string,
    options: StrataErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends StrataError {
  constructor(code: string, message: string, options: StrataErrorOptions = {}) {
    super(code, message, options);
    this.name = "NotFoundError";
  }
}

export class StateMachineError extends StrataError {
  constructor(
    code: string,
    message: string,
    options: StrataErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "StateMachineError";
  }
}
