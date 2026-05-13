/**
 * Capability discovery — walk one or more root directories and decide,
 * for each `<name>/` subdir, which version is currently active.
 *
 * Decision order:
 *   1. `<name>/current/meta.json` exists → use `<name>/current`.
 *   2. Else pick the highest-numbered `<name>/v<N>/` whose `meta.json`
 *      is readable.
 *   3. Else log `warn` and skip the capability.
 *
 * Roots are walked in order; later roots shadow earlier ones on `<name>`
 * collision (so user-installed capabilities override bundled ones).
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import * as path from "node:path";

import type { Logger } from "../core/logger.js";
import type { DiscoveredCapability } from "./types.js";

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const VERSION_RE = /^v(\d+)$/;

interface VersionDir {
  version: number;
  path: string;
}

/**
 * Walk `roots` and return one `DiscoveredCapability` per unique capability
 * name. Roots are processed left-to-right; later roots override earlier ones.
 *
 * Missing roots are debug-logged and skipped. Malformed capability names are
 * warn-logged and skipped.
 */
export async function discoverCapabilities(
  roots: string[],
  logger: Logger,
): Promise<DiscoveredCapability[]> {
  const log = logger.child({ module: "capabilities.discover" });
  const byName = new Map<string, DiscoveredCapability>();

  for (const root of roots) {
    if (!existsSync(root)) {
      log.debug("capability root missing; skipping", { root });
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      log.warn("failed to read capability root; skipping", {
        root,
        error: (err as Error).message,
      });
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(root, entry);
      let entryStat: ReturnType<typeof statSync>;
      try {
        entryStat = statSync(entryPath);
      } catch {
        continue; // dangling symlink or similar
      }
      if (!entryStat.isDirectory()) continue;

      if (!NAME_RE.test(entry)) {
        log.warn("capability dir name is malformed; skipping", {
          name: entry,
          root,
        });
        continue;
      }

      const selected = pickActiveVersion(entryPath);
      if (!selected) {
        log.warn(
          "capability dir has no readable current/ or v<N>/meta.json; skipping",
          { name: entry, path: entryPath },
        );
        continue;
      }

      byName.set(entry, {
        name: entry,
        version: selected.version,
        path: selected.path,
        metaPath: path.join(selected.path, "meta.json"),
        migrationsPath: path.join(selected.path, "migrations"),
      });
    }
  }

  return [...byName.values()];
}

/** Picks the active version directory for a single capability `<name>/`. */
function pickActiveVersion(
  capabilityDir: string,
): { version: number; path: string } | null {
  const currentDir = path.join(capabilityDir, "current");
  if (existsSync(path.join(currentDir, "meta.json"))) {
    return { version: Number.NaN, path: currentDir };
  }

  let children: string[];
  try {
    children = readdirSync(capabilityDir);
  } catch {
    return null;
  }

  const versions: VersionDir[] = [];
  for (const child of children) {
    const m = child.match(VERSION_RE);
    if (!m) continue;
    const childPath = path.join(capabilityDir, child);
    if (!existsSync(path.join(childPath, "meta.json"))) continue;
    versions.push({ version: Number.parseInt(m[1]!, 10), path: childPath });
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => b.version - a.version);
  return versions[0] ?? null;
}
