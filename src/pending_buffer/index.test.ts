import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type Logger } from "../core/logger.js";
import { PendingBuffer } from "./index.js";

describe("PendingBuffer", () => {
  let tmp: string;
  let stateFile: string;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-pbuf-"));
    stateFile = path.join(tmp, "state", "pending_buffer.json");
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("tracks distinct sessions independently", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    await buf.add("s1", 1);
    await buf.add("s1", 2);
    await buf.add("s2", 3);
    expect(await buf.getAll("s1")).toEqual([1, 2]);
    expect(await buf.getAll("s2")).toEqual([3]);
  });

  it("add is idempotent", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    await buf.add("s1", 1);
    await buf.add("s1", 1);
    expect(await buf.getAll("s1")).toEqual([1]);
  });

  it("remove is idempotent and prunes empty sessions", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    await buf.add("s1", 1);
    await buf.remove("s1", 1);
    await buf.remove("s1", 1); // no-op
    await buf.remove("s1", 999); // no-op
    expect(await buf.getAll("s1")).toEqual([]);
    const snap = await buf.snapshot();
    expect(snap).toEqual({});
  });

  it("clearSession removes every pending event for a session", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    await buf.add("s1", 1);
    await buf.add("s1", 2);
    await buf.add("s2", 3);
    await buf.clearSession("s1");
    expect(await buf.getAll("s1")).toEqual([]);
    expect(await buf.getAll("s2")).toEqual([3]);
  });

  it("has returns the right bool", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    await buf.add("s1", 7);
    expect(await buf.has("s1", 7)).toBe(true);
    expect(await buf.has("s1", 8)).toBe(false);
    expect(await buf.has("unknown", 7)).toBe(false);
  });

  it("persists state to disk after every mutation", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    await buf.add("s1", 1);
    await buf.add("s1", 2);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      s1: [1, 2],
    });
    await buf.remove("s1", 1);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      s1: [2],
    });
  });

  it("a new instance picks up the persisted state", async () => {
    const first = new PendingBuffer({ stateFile, logger });
    await first.add("s1", 10);
    await first.add("s1", 11);
    await first.add("s2", 99);
    const second = new PendingBuffer({ stateFile, logger });
    expect(await second.snapshot()).toEqual({ s1: [10, 11], s2: [99] });
  });

  it("a missing state file boots an empty buffer", async () => {
    const buf = new PendingBuffer({ stateFile, logger });
    expect(await buf.snapshot()).toEqual({});
  });

  it("an unparseable state file boots an empty buffer", async () => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, "not json{");
    const buf = new PendingBuffer({ stateFile, logger });
    expect(await buf.snapshot()).toEqual({});
  });

  it("persistence failure is swallowed and logged", async () => {
    // Point the state file at /System (read-only on macOS) so renameSync fails.
    const badFile = "/System/strata-pbuf-test/pending_buffer.json";
    const logFile = path.join(tmp, "warn.log");
    const warnLogger = createLogger({ level: "debug", logFilePath: logFile });
    const buf = new PendingBuffer({ stateFile: badFile, logger: warnLogger });
    await expect(buf.add("s1", 1)).resolves.toBeUndefined();
    const lines = readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => l.level === "warn")).toBe(true);
  });
});
