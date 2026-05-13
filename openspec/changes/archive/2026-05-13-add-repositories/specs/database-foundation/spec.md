## MODIFIED Requirements

### Requirement: Repository interface

The system SHALL expose a generic `Repository<T, ID = number>` interface declaring the following methods. The default `ID` is `number`, so existing call sites are unaffected; tables whose primary key is a string (e.g. `capability_registry.name`, `capability_health.capability_name`) instantiate the interface with `ID = string`.

- `findById(id: ID): Promise<T | null>`
- `findMany(filter: Partial<T>, options?: { limit?: number; offset?: number; orderBy?: keyof T; direction?: 'asc' | 'desc' }): Promise<T[]>`
- `insert(data: Partial<T>): Promise<T>` — the loose `Partial<T>` accommodates both synthetic-id tables (caller omits `id`) and natural-key tables (caller must provide the key column); concrete implementations validate required fields at runtime
- `update(id: ID, patch: Partial<T>): Promise<T>`
- `softDelete(id: ID): Promise<void>` — semantic delete; concrete implementations decide which column flips
- `count(filter?: Partial<T>): Promise<number>`
- `transaction<R>(fn: () => Promise<R>): Promise<R>`

The interface MUST NOT prescribe how implementations talk to SQLite — it is a contract, not an implementation.

#### Scenario: Type-only contract compiles for number-ID tables

- **WHEN** a downstream module imports `Repository<T>` (default `ID = number`) and writes a stub class declaring the methods
- **THEN** the TypeScript compiler accepts the class without raw-SQL leakage from `Repository<T>`

#### Scenario: Type-only contract compiles for string-ID tables

- **WHEN** a downstream module imports `Repository<T, string>` and writes a stub class with `findById(id: string)`, `update(id: string, ...)` etc.
- **THEN** the TypeScript compiler accepts the class without complaint
