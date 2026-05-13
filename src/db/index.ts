/**
 * Strata data-access primitives.
 * Connection setup, repository contract, and migration runner.
 */
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
