import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { spawn as nodeSpawn } from "node:child_process";
import {
  abortRunClaudeCode,
  parseStreamJsonLines,
  runClaudeCode,
  type RunHandle,
  type StreamJsonEvent,
} from "./claude_code_runner.js";

// ---- fake-spawn harness ---------------------------------------------------

interface FakeChildOptions {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  /** ms before exit fires after the last stdout chunk. */
  exitDelayMs?: number;
  /** SIGTERM handler: 'exit' to exit on SIGTERM, 'ignore' to do nothing. */
  onSigterm?: "exit" | "ignore";
  /** Code to report on SIGTERM-triggered exit. */
  sigtermExitCode?: number;
}

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  stdout: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr: EventEmitter & { setEncoding?: (enc: string) => void };
  kill(signal?: NodeJS.Signals): boolean;
}

function makeFakeChild(opts: FakeChildOptions): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 12345;
  child.exitCode = null;
  const stdout = new EventEmitter() as FakeChild["stdout"];
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as FakeChild["stderr"];
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;

  let killed = false;
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (killed) return false;
    if (signal === "SIGKILL") {
      killed = true;
      queueMicrotask(() => {
        child.exitCode = 137;
        child.emit("exit", 137);
      });
      return true;
    }
    if (signal === "SIGTERM") {
      if (opts.onSigterm === "ignore") return true; // pretend to ignore
      killed = true;
      const code = opts.sigtermExitCode ?? 143;
      queueMicrotask(() => {
        child.exitCode = code;
        child.emit("exit", code);
      });
      return true;
    }
    return true;
  };

  // Drive the streams + exit on the next tick so the caller can attach
  // listeners first.
  queueMicrotask(async () => {
    for (const chunk of opts.stdoutChunks ?? []) {
      stdout.emit("data", chunk);
    }
    for (const chunk of opts.stderrChunks ?? []) {
      stderr.emit("data", chunk);
    }
    if (opts.exitDelayMs && opts.exitDelayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.exitDelayMs));
    }
    if (!killed) {
      child.exitCode = opts.exitCode ?? 0;
      child.emit("exit", opts.exitCode ?? 0);
    }
  });
  return child;
}

function makeFakeSpawn(opts: FakeChildOptions): typeof nodeSpawn {
  return ((..._args: unknown[]) => makeFakeChild(opts)) as unknown as typeof nodeSpawn;
}

// ---- parser ---------------------------------------------------------------

describe("parseStreamJsonLines", () => {
  it("returns no events for an empty chunk", () => {
    expect(parseStreamJsonLines("", "")).toEqual({ events: [], leftover: "" });
  });

  it("parses a single complete line", () => {
    const r = parseStreamJsonLines('{"type":"assistant","content":"hi"}\n', "");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type).toBe("assistant");
    expect(r.leftover).toBe("");
  });

  it("preserves partial trailing data in leftover", () => {
    const r = parseStreamJsonLines('{"type":"assist', "");
    expect(r.events).toHaveLength(0);
    expect(r.leftover).toBe('{"type":"assist');
  });

  it("joins leftover + chunk across calls", () => {
    const r1 = parseStreamJsonLines('{"type":"assist', "");
    const r2 = parseStreamJsonLines('ant"}\n', r1.leftover);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0]?.type).toBe("assistant");
  });

  it("emits parse_error for malformed lines", () => {
    const r = parseStreamJsonLines("not json\n", "");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type).toBe("parse_error");
    expect((r.events[0] as { raw: string }).raw).toBe("not json");
  });

  it("strips trailing CR (Windows line endings)", () => {
    const r = parseStreamJsonLines('{"type":"assistant"}\r\n', "");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type).toBe("assistant");
  });

  it("skips empty lines", () => {
    const r = parseStreamJsonLines('\n\n{"type":"assistant"}\n', "");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type).toBe("assistant");
  });

  it("classifies all known types", () => {
    const types = [
      "assistant",
      "user",
      "tool_use",
      "tool_result",
      "thinking",
      "system",
      "result",
    ];
    for (const t of types) {
      const r = parseStreamJsonLines(`{"type":"${t}"}\n`, "");
      expect(r.events[0]?.type).toBe(t);
    }
  });

  it("falls back to 'unknown' for unrecognised type", () => {
    const r = parseStreamJsonLines('{"type":"some_new_type","foo":1}\n', "");
    expect(r.events[0]?.type).toBe("unknown");
    expect((r.events[0] as { raw: { type: string } }).raw.type).toBe("some_new_type");
  });

  it("handles multiple events in one chunk", () => {
    const r = parseStreamJsonLines(
      '{"type":"assistant"}\n{"type":"tool_use"}\n{"type":"result"}\n',
      "",
    );
    expect(r.events.map((e) => e.type)).toEqual([
      "assistant",
      "tool_use",
      "result",
    ]);
  });

  it("falls back to 'unknown' for non-object JSON", () => {
    const r = parseStreamJsonLines("42\n", "");
    expect(r.events[0]?.type).toBe("unknown");
  });
});

// ---- runClaudeCode --------------------------------------------------------

describe("runClaudeCode", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-ccr-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path: emits events and resolves with exitCode + count + stderr", async () => {
    const events: StreamJsonEvent[] = [];
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: [
        '{"type":"system","model":"sonnet-4"}\n',
        '{"type":"assistant","content":"working..."}\n',
        '{"type":"result","exit":"ok"}\n',
      ],
      stderrChunks: ["warn: deprecated flag\n"],
      exitCode: 0,
    });
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "plan a thing",
      mode: "explore",
      maxTurns: 10,
      onEvent: (e) => events.push(e),
      spawn: fakeSpawn,
    });
    const result = await handle.result;
    expect(result).toEqual({
      exitCode: 0,
      eventCount: 3,
      stderr: "warn: deprecated flag\n",
    });
    expect(events.map((e) => e.type)).toEqual([
      "system",
      "assistant",
      "result",
    ]);
  });

  it("surfaces a malformed line as parse_error without aborting", async () => {
    const events: StreamJsonEvent[] = [];
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: [
        '{"type":"assistant"}\n',
        "not json\n",
        '{"type":"result"}\n',
      ],
      exitCode: 0,
    });
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: (e) => events.push(e),
      spawn: fakeSpawn,
    });
    await handle.result;
    expect(events.map((e) => e.type)).toEqual([
      "assistant",
      "parse_error",
      "result",
    ]);
  });

  it("throws synchronously when workdir is missing", () => {
    expect(() =>
      runClaudeCode({
        workdir: "",
        prompt: "x",
        mode: "explore",
        maxTurns: 1,
        onEvent: () => {},
      }),
    ).toThrow(/workdir is required/);
  });

  it("throws synchronously when workdir does not exist", () => {
    expect(() =>
      runClaudeCode({
        workdir: path.join(tmp, "nope"),
        prompt: "x",
        mode: "explore",
        maxTurns: 1,
        onEvent: () => {},
      }),
    ).toThrow(/does not exist/);
  });

  it("AbortSignal triggers SIGTERM and resolves with exitCode 143", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"assistant"}\n'],
      exitDelayMs: 10_000, // would hang without abort
    });
    const controller = new AbortController();
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: () => {},
      spawn: fakeSpawn,
      signal: controller.signal,
    });
    controller.abort();
    const result = await handle.result;
    expect(result.exitCode).toBe(143);
  });

  it("consumer onEvent throws are swallowed and don't break the run", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"assistant"}\n', '{"type":"result"}\n'],
      exitCode: 0,
    });
    let calls = 0;
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: () => {
        calls++;
        throw new Error("consumer bug");
      },
      spawn: fakeSpawn,
    });
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(result.eventCount).toBe(2);
  });

  it("flushes trailing partial line as a parse_error on exit", async () => {
    const events: StreamJsonEvent[] = [];
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"assistant"}\n', '{"type":"partial'],
      exitCode: 0,
    });
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: (e) => events.push(e),
      spawn: fakeSpawn,
    });
    await handle.result;
    expect(events.map((e) => e.type)).toEqual(["assistant", "parse_error"]);
  });
});

// ---- abortRunClaudeCode ---------------------------------------------------

describe("abortRunClaudeCode", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-ccr-abort-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("SIGTERM exits the subprocess within grace", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: [],
      exitDelayMs: 60_000, // would hang otherwise
    });
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: () => {},
      spawn: fakeSpawn,
    });
    await abortRunClaudeCode(handle, { graceMs: 100 });
    const result = await handle.result;
    expect(result.exitCode).toBe(143);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: [],
      exitDelayMs: 60_000,
      onSigterm: "ignore",
    });
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: () => {},
      spawn: fakeSpawn,
    });
    await abortRunClaudeCode(handle, { graceMs: 10 });
    const result = await handle.result;
    expect(result.exitCode).toBe(137); // SIGKILL'd
  });

  it("is idempotent on an already-exited process", async () => {
    const fakeSpawn = makeFakeSpawn({
      stdoutChunks: ['{"type":"result"}\n'],
      exitCode: 0,
    });
    const handle = runClaudeCode({
      workdir: tmp,
      prompt: "x",
      mode: "explore",
      maxTurns: 1,
      onEvent: () => {},
      spawn: fakeSpawn,
    });
    await handle.result;
    await expect(
      abortRunClaudeCode(handle, { graceMs: 10 }),
    ).resolves.toBeUndefined();
  });
});
