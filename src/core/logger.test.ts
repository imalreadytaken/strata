import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger.js";

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe("createLogger", () => {
  let tmp: string;
  let logFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-log-"));
    logFile = path.join(tmp, "subdir", "plugin.log");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates the parent directory on first emit", () => {
    const log = createLogger({ level: "info", logFilePath: logFile });
    log.info("hello");
    const lines = readLines(logFile);
    expect(lines).toHaveLength(1);
  });

  it("emits a JSON record with ts/level/msg and merged fields", () => {
    const log = createLogger({ level: "info", logFilePath: logFile });
    log.info("hello", { user: "seven" });
    const [record] = readLines(logFile);
    expect(record).toBeDefined();
    expect(typeof record!.ts).toBe("string");
    expect(record!.level).toBe("info");
    expect(record!.msg).toBe("hello");
    expect(record!.user).toBe("seven");
    // Round-trip the timestamp.
    expect(Number.isFinite(Date.parse(record!.ts as string))).toBe(true);
  });

  it("drops records below the configured level", () => {
    const log = createLogger({ level: "warn", logFilePath: logFile });
    log.debug("noise");
    log.info("still noise");
    log.warn("real");
    log.error("real");
    const records = readLines(logFile);
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("respects every level boundary", () => {
    const log = createLogger({ level: "info", logFilePath: logFile });
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
    const levels = readLines(logFile).map((r) => r.level);
    expect(levels).toEqual(["info", "warn", "error"]);
  });

  it("child loggers inherit and extend bindings", () => {
    const log = createLogger({
      level: "info",
      logFilePath: logFile,
      bindings: { app: "strata" },
    });
    const dbLog = log.child({ module: "db" });
    const opLog = dbLog.child({ op: "migrate" });
    opLog.info("running");
    const [record] = readLines(logFile);
    expect(record).toBeDefined();
    expect(record!.app).toBe("strata");
    expect(record!.module).toBe("db");
    expect(record!.op).toBe("migrate");
  });

  it("mirrors to stderr when toStderr is true", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const log = createLogger({
        level: "info",
        logFilePath: logFile,
        toStderr: true,
      });
      log.info("hello");
      expect(write).toHaveBeenCalledTimes(1);
      const call = write.mock.calls[0]?.[0];
      const line = typeof call === "string" ? call : "";
      const parsed = JSON.parse(line.trimEnd()) as { msg: string };
      expect(parsed.msg).toBe("hello");
    } finally {
      write.mockRestore();
    }
  });

  it("does not write to stderr when toStderr is false (default)", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const log = createLogger({ level: "info", logFilePath: logFile });
      log.info("hello");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("does not mutate the bindings of the parent when a child adds keys", () => {
    const log = createLogger({
      level: "info",
      logFilePath: logFile,
      bindings: { module: "root" },
    });
    log.child({ module: "child" }).info("c");
    log.info("r");
    const records = readLines(logFile);
    expect(records[0]!.module).toBe("child");
    expect(records[1]!.module).toBe("root");
  });
});
