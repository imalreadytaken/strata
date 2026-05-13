import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { discoverCapabilities } from "./discover.js";

function writeMeta(dir: string, content = '{"name":"x","version":1}'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), content);
}

describe("discoverCapabilities", () => {
  let tmp: string;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-discover-"));
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns [] when all roots are missing", async () => {
    const r = await discoverCapabilities(
      [path.join(tmp, "nope-a"), path.join(tmp, "nope-b")],
      logger,
    );
    expect(r).toEqual([]);
  });

  it("returns [] for an empty root", async () => {
    const root = path.join(tmp, "root");
    mkdirSync(root, { recursive: true });
    const r = await discoverCapabilities([root], logger);
    expect(r).toEqual([]);
  });

  it("discovers a single v1 capability", async () => {
    const root = path.join(tmp, "root");
    writeMeta(path.join(root, "expenses", "v1"));
    const r = await discoverCapabilities([root], logger);
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe("expenses");
    expect(r[0]?.version).toBe(1);
    expect(r[0]?.path).toBe(path.join(root, "expenses", "v1"));
  });

  it("picks the highest numeric version (v10 > v2 > v1)", async () => {
    const root = path.join(tmp, "root");
    writeMeta(path.join(root, "expenses", "v1"));
    writeMeta(path.join(root, "expenses", "v2"));
    writeMeta(path.join(root, "expenses", "v10"));
    const r = await discoverCapabilities([root], logger);
    expect(r[0]?.version).toBe(10);
    expect(r[0]?.path.endsWith("v10")).toBe(true);
  });

  it("prefers current/ over vN/", async () => {
    const root = path.join(tmp, "root");
    writeMeta(path.join(root, "expenses", "v1"));
    writeMeta(path.join(root, "expenses", "v2"));
    symlinkSync(
      path.join(root, "expenses", "v1"),
      path.join(root, "expenses", "current"),
    );
    const r = await discoverCapabilities([root], logger);
    expect(r[0]?.path.endsWith("current")).toBe(true);
  });

  it("skips malformed name with a warn", async () => {
    const root = path.join(tmp, "root");
    writeMeta(path.join(root, "Expenses", "v1"));
    const logFile = path.join(tmp, "warn.log");
    const warnLog = createLogger({ level: "debug", logFilePath: logFile });
    const r = await discoverCapabilities([root], warnLog);
    expect(r).toEqual([]);
  });

  it("skips an empty <name>/ dir with a warn", async () => {
    const root = path.join(tmp, "root");
    mkdirSync(path.join(root, "expenses"), { recursive: true });
    const r = await discoverCapabilities([root], logger);
    expect(r).toEqual([]);
  });

  it("user root shadows bundled root", async () => {
    const bundled = path.join(tmp, "bundled");
    const user = path.join(tmp, "user");
    writeMeta(path.join(bundled, "expenses", "v1"));
    writeMeta(path.join(user, "expenses", "v2"));
    const r = await discoverCapabilities([bundled, user], logger);
    expect(r).toHaveLength(1);
    expect(r[0]?.version).toBe(2);
    expect(r[0]?.path.startsWith(user)).toBe(true);
  });

  it("discovers multiple capabilities in one root", async () => {
    const root = path.join(tmp, "root");
    writeMeta(path.join(root, "expenses", "v1"));
    writeMeta(path.join(root, "moods", "v1"));
    const r = await discoverCapabilities([root], logger);
    expect(r.map((e) => e.name).sort()).toEqual(["expenses", "moods"]);
  });
});
