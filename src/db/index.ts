/**
 * Strata data-access primitives.
 * Connection setup, repository contract, and migration runner.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export {
  openDatabase,
  type OpenDatabaseOptions,
  type Database,
} from "./connection.js";

export {
  type Repository,
  type FindManyOptions,
} from "./repository.js";

export {
  applyMigrations,
  MIGRATION_FILE_RE,
  type MigrationSummary,
} from "./migrations.js";

/**
 * Absolute path to the directory containing the eight system-table
 * `NNN_*.sql` migration files. Resolved at module load via
 * `import.meta.url`, so it works whether this file is imported from
 * source (vitest) or from a compiled `dist/` (production build, once
 * the build script copies `.sql` siblings into `dist/`).
 */
export const SYSTEM_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export * from "./repositories/index.js";
