/**
 * Strata configuration loader.
 *
 * Reads `~/.strata/config.json` (JSON5 syntax), validates with Zod, expands
 * leading-tilde paths to absolute, and refuses to load any config containing
 * a key whose name looks like an API key / token / secret (P5 in
 * `STRATA_SPEC.md` §1.3: provider credentials live in OpenClaw, never here).
 */
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

import { ConfigError } from "./errors.js";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * The shape of `~/.strata/config.json`. `.strict()` everywhere so a typo in
 * any field fails fast — we'd rather the user see "unknown key X" than have
 * the value silently ignored.
 */
export const ConfigSchema = z
  .object({
    version: z.string().default("1.0"),
    database: z
      .object({
        path: z.string().default("~/.strata/main.db"),
      })
      .strict()
      .prefault({}),
    paths: z
      .object({
        dataDir: z.string().default("~/.strata"),
        capabilitiesDir: z.string().default("~/.strata/capabilities"),
        openspecDir: z.string().default("~/.strata/openspec"),
        plansDir: z.string().default("~/.strata/plans"),
        buildsDir: z.string().default("~/.strata/builds"),
        logsDir: z.string().default("~/.strata/logs"),
      })
      .strict()
      .prefault({}),
    logging: z
      .object({
        level: LogLevelSchema.default("info"),
        toStderr: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    pending: z
      .object({
        timeoutMinutes: z.number().int().positive().default(30),
      })
      .strict()
      .prefault({}),
    /**
     * LLM model selection per logical purpose. `'auto'` keeps the heuristic
     * fallback; `'<provider>/<modelId>'` opts in to a real pi-ai backend.
     * Provider names must be one of pi-ai's `KnownProvider` set. AGENTS.md
     * forbids storing API keys here; the key is read from environment.
     */
    models: z
      .object({
        fast: z.string().default("auto"),
        smart: z.string().default("auto"),
        coder: z.string().default("claude-code-cli"),
      })
      .strict()
      .prefault({}),
    /**
     * Re-extraction worker configuration. The worker drains
     * `reextract_jobs` rows; one job at a time.
     */
    reextract: z
      .object({
        enabled: z.boolean().default(true),
        poll_interval_seconds: z.number().int().positive().default(30),
        checkpoint_every_rows: z.number().int().positive().default(20),
        max_concurrent_jobs: z.number().int().positive().default(1),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type StrataConfig = z.infer<typeof ConfigSchema>;

/** Regex matching forbidden key names (case-insensitive). */
const FORBIDDEN_KEY_RE = /^(api[_-]?key|apikey|token|secret)$/i;

/** Expand a leading `~/` (and bare `~`) to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Throws `ConfigError(STRATA_E_CONFIG_FORBIDDEN_KEY, ...)` if any key
 * (at any depth) matches `FORBIDDEN_KEY_RE`. Walks plain objects and arrays;
 * does not descend into class instances.
 */
export function assertNoForbiddenKeys(value: unknown, pathSoFar = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenKeys(value[i], `${pathSoFar}[${i}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(key)) {
      throw new ConfigError(
        "STRATA_E_CONFIG_FORBIDDEN_KEY",
        `Forbidden key '${key}' at ${pathSoFar}.${key} — provider credentials must live in OpenClaw, never in ~/.strata/config.json`,
      );
    }
    assertNoForbiddenKeys(child, `${pathSoFar}.${key}`);
  }
}

const PATH_FIELDS = [
  "database.path",
  "paths.dataDir",
  "paths.capabilitiesDir",
  "paths.openspecDir",
  "paths.plansDir",
  "paths.buildsDir",
  "paths.logsDir",
] as const;

function expandConfigPaths(cfg: StrataConfig): StrataConfig {
  const out: StrataConfig = {
    ...cfg,
    database: { ...cfg.database, path: expandTilde(cfg.database.path) },
    paths: {
      dataDir: expandTilde(cfg.paths.dataDir),
      capabilitiesDir: expandTilde(cfg.paths.capabilitiesDir),
      openspecDir: expandTilde(cfg.paths.openspecDir),
      plansDir: expandTilde(cfg.paths.plansDir),
      buildsDir: expandTilde(cfg.paths.buildsDir),
      logsDir: expandTilde(cfg.paths.logsDir),
    },
    logging: { ...cfg.logging },
    pending: { ...cfg.pending },
  };
  // PATH_FIELDS is only here so a future audit can grep for every path-typed
  // field; if anything is missed in `out` above, this dead-store is a tell.
  void PATH_FIELDS;
  return out;
}

export interface LoadConfigOptions {
  /** Override the config file location. Default: `~/.strata/config.json`. */
  path?: string;
}

/**
 * Load and validate `~/.strata/config.json`. Returns a frozen, fully-defaulted,
 * tilde-expanded `StrataConfig`. Missing file → defaults (not an error).
 */
export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<Readonly<StrataConfig>> {
  const configPath = expandTilde(opts.path ?? "~/.strata/config.json");

  let raw: string | undefined;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing file: return defaults.
      const defaults = ConfigSchema.parse({});
      return Object.freeze(expandConfigPaths(defaults));
    }
    throw new ConfigError(
      "STRATA_E_CONFIG_READ_FAILED",
      `Failed to read config at ${configPath}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    throw new ConfigError(
      "STRATA_E_CONFIG_INVALID",
      `Config at ${configPath} is not valid JSON5: ${(err as Error).message}`,
      { cause: err },
    );
  }

  // Forbidden-key walk runs on the raw parsed object so we catch keys that
  // would be stripped or ignored by Zod's `.strict()`.
  assertNoForbiddenKeys(parsed);

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first ? first.path.join(".") : "(root)";
    const what = first?.message ?? "schema validation failed";
    throw new ConfigError(
      "STRATA_E_CONFIG_INVALID",
      `Invalid config at ${configPath}: ${where} — ${what}`,
      { cause: result.error },
    );
  }

  return Object.freeze(expandConfigPaths(result.data));
}
