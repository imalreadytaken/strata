/**
 * Repository contract.
 *
 * Concrete implementations land in `add-repositories`. This file is the
 * type-only contract every Strata data-access class must satisfy; keeping
 * SQL out of the rest of the codebase is what makes a future Postgres adapter
 * possible (per `STRATA_SPEC.md` §3.3).
 *
 * Soft-delete instead of `delete`: AGENTS.md forbids hard deletes anywhere
 * in the system. Each concrete repository decides which column flips
 * (e.g. `status = 'archived'` for capability_registry).
 */

export interface FindManyOptions<T> {
  limit?: number;
  offset?: number;
  orderBy?: keyof T;
  direction?: "asc" | "desc";
}

export interface Repository<T extends { id: number }> {
  findById(id: number): Promise<T | null>;

  findMany(
    filter?: Partial<T>,
    options?: FindManyOptions<T>,
  ): Promise<T[]>;

  count(filter?: Partial<T>): Promise<number>;

  insert(data: Omit<T, "id">): Promise<T>;

  update(id: number, patch: Partial<Omit<T, "id">>): Promise<T>;

  /**
   * Semantic delete. Implementations MUST flip a status column, not
   * issue a `DELETE FROM`. See AGENTS.md "What you MUST NOT do".
   */
  softDelete(id: number): Promise<void>;

  transaction<R>(fn: () => Promise<R>): Promise<R>;
}
