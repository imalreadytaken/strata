/**
 * Strata core — config, structured logging, and typed errors.
 * Imported by every other module; intentionally tiny and dependency-free
 * beyond `zod` and `json5`.
 */
export {
  StrataError,
  ConfigError,
  DatabaseError,
  ValidationError,
  NotFoundError,
  StateMachineError,
  type StrataErrorCode,
  type StrataErrorOptions,
} from "./errors.js";

export {
  ConfigSchema,
  loadConfig,
  expandTilde,
  assertNoForbiddenKeys,
  type StrataConfig,
  type LoadConfigOptions,
  type LogLevel,
} from "./config.js";

export { createLogger, type Logger, type LoggerOptions } from "./logger.js";
