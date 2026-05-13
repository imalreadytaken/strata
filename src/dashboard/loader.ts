/**
 * Per-capability dashboard.json loader.
 *
 * Reads `<dir>/dashboard.json`, parses JSON5, validates against
 * `DashboardSchema`, and registers the result into a `DashboardRegistry`.
 * Missing files are silently OK; malformed files throw
 * `STRATA_E_CAPABILITY_INVALID` so the same boot-abort semantics as
 * `meta.json` apply.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import JSON5 from "json5";

import { ValidationError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { DashboardRegistry } from "./registry.js";
import { DashboardSchema } from "./types.js";

export interface LoadCapabilityDashboardArgs {
  dir: string;
  name: string;
  registry: DashboardRegistry;
  logger: Logger;
}

/**
 * @returns `true` when a dashboard was registered, `false` when no
 * `dashboard.json` was found.
 */
export async function loadCapabilityDashboard(
  args: LoadCapabilityDashboardArgs,
): Promise<boolean> {
  const log = args.logger.child({ module: "dashboard.loader" });
  const filePath = join(args.dir, "dashboard.json");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug("no dashboard.json", { capability: args.name, path: filePath });
      return false;
    }
    throw new ValidationError(
      "STRATA_E_CAPABILITY_INVALID",
      `failed to read ${filePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    throw new ValidationError(
      "STRATA_E_CAPABILITY_INVALID",
      `${filePath} is not valid JSON5: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const result = DashboardSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      "STRATA_E_CAPABILITY_INVALID",
      `${filePath} failed dashboard schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }

  args.registry.register(args.name, result.data);
  log.info("dashboard loaded", {
    capability: args.name,
    widget_count: result.data.widgets.length,
  });
  return true;
}
