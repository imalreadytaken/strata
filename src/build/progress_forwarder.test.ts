import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BuildProgressForwarder,
  formatStreamJsonEvent,
  summarizeToolResult,
  summarizeToolUse,
} from "./progress_forwarder.js";
import type { StreamJsonEvent } from "./claude_code_runner.js";

describe("formatStreamJsonEvent", () => {
  it("renders an assistant event with the 💬 prefix", () => {
    const out = formatStreamJsonEvent({
      type: "assistant",
      raw: { content: "hello world" },
    });
    expect(out).not.toBeNull();
    expect(out!.startsWith("💬 ")).toBe(true);
    expect(out).toContain("hello world");
  });

  it("renders an assistant event nested under message.content[]", () => {
    const out = formatStreamJsonEvent({
      type: "assistant",
      raw: { message: { content: [{ type: "text", text: "nested" }] } },
    });
    expect(out).toContain("nested");
  });

  it("returns null for thinking", () => {
    expect(
      formatStreamJsonEvent({ type: "thinking", raw: {} }),
    ).toBeNull();
  });

  it("renders tool_use with 🛠 + summary", () => {
    const out = formatStreamJsonEvent({
      type: "tool_use",
      raw: { name: "Edit", input: { path: "/x", content: "y" } },
    });
    expect(out).toMatch(/^🛠 Edit\(/);
    expect(out).toContain("path");
    expect(out).toContain("content");
  });

  it("renders tool_result with ↳", () => {
    const out = formatStreamJsonEvent({
      type: "tool_result",
      raw: { content: "did the thing" },
    });
    expect(out).toBe("↳ did the thing");
  });

  it("renders successful result with ✅", () => {
    const out = formatStreamJsonEvent({
      type: "result",
      raw: { summary: "all good", is_error: false },
    });
    expect(out).toBe("✅ result: all good");
  });

  it("renders error result with ❌", () => {
    const out = formatStreamJsonEvent({
      type: "result",
      raw: { is_error: true, error: "build failed" },
    });
    expect(out).toBe("❌ result: build failed");
  });

  it("renders parse_error with ⚠", () => {
    const out = formatStreamJsonEvent({
      type: "parse_error",
      raw: "not json",
      error: "Unexpected token",
    });
    expect(out!.startsWith("⚠ parse_error: ")).toBe(true);
    expect(out).toContain("not json");
  });

  it("renders unknown with the inner type when present", () => {
    const out = formatStreamJsonEvent({
      type: "unknown",
      raw: { type: "some_new_kind", x: 1 },
    });
    expect(out).toBe("· some_new_kind");
  });

  it("renders system events with the model", () => {
    const out = formatStreamJsonEvent({
      type: "system",
      raw: { model: "claude-sonnet-4-6" },
    });
    expect(out).toBe("🔧 system: claude-sonnet-4-6");
  });
});

describe("summarizeToolUse", () => {
  it("renders name(k=v) for primitive args", () => {
    expect(
      summarizeToolUse({
        name: "Bash",
        input: { command: "ls", timeout: 5000 },
      }),
    ).toBe('Bash(command="ls", timeout=5000)');
  });

  it("truncates long string values to ~32 chars", () => {
    const result = summarizeToolUse({
      name: "Edit",
      input: { content: "x".repeat(200) },
    });
    expect(result).toMatch(/Edit\(content="x{1,31}…"\)/);
  });

  it("truncates the total length to 120 chars", () => {
    const result = summarizeToolUse({
      name: "Big",
      input: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`field${i}`, `value${i}`]),
      ),
    });
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toContain("…");
  });

  it("handles non-object input gracefully", () => {
    expect(summarizeToolUse({ name: "Naked", input: "hi" })).toContain("Naked(");
  });
});

describe("summarizeToolResult", () => {
  it("returns string content truncated to 200 chars", () => {
    const result = summarizeToolResult({ content: "ok".repeat(200) });
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("joins array-of-text content", () => {
    expect(
      summarizeToolResult({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first second");
  });

  it("prefixes 'error: ' when is_error is true", () => {
    expect(
      summarizeToolResult({ content: "boom", is_error: true }),
    ).toBe("error: boom");
  });
});

describe("BuildProgressForwarder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches multiple events into one send on tick", async () => {
    const send = vi.fn(async () => {});
    const f = new BuildProgressForwarder({ send, flushIntervalMs: 1000 });
    f.start();
    f.onEvent({ type: "assistant", raw: { content: "a" } });
    f.onEvent({ type: "assistant", raw: { content: "b" } });
    f.onEvent({ type: "assistant", raw: { content: "c" } });
    await vi.advanceTimersByTimeAsync(1000);
    await f.stop();
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]?.[0] as string;
    expect(arg.split("\n")).toHaveLength(3);
  });

  it("caps a single flush at maxEventsPerBatch and leaves the rest queued", async () => {
    const send = vi.fn(async () => {});
    const f = new BuildProgressForwarder({
      send,
      flushIntervalMs: 1000,
      maxEventsPerBatch: 10,
    });
    f.start();
    for (let i = 0; i < 30; i++) {
      f.onEvent({ type: "assistant", raw: { content: `m${i}` } });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]?.[0] as string).split("\n")).toHaveLength(10);
    expect(f.pending()).toBe(20);

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.pending()).toBe(10);

    await f.stop();
    // stop() performs a final flush.
    expect(send).toHaveBeenCalledTimes(3);
    expect(f.pending()).toBe(0);
  });

  it("does not call send on an empty queue", async () => {
    const send = vi.fn(async () => {});
    const f = new BuildProgressForwarder({ send, flushIntervalMs: 500 });
    f.start();
    await vi.advanceTimersByTimeAsync(1500);
    await f.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("thinking events do not enqueue or flush", async () => {
    const send = vi.fn(async () => {});
    const f = new BuildProgressForwarder({ send, flushIntervalMs: 500 });
    f.start();
    for (let i = 0; i < 10; i++) {
      f.onEvent({ type: "thinking", raw: { content: "..." } } as StreamJsonEvent);
    }
    expect(f.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await f.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("stop() does a final flush of pending events", async () => {
    const send = vi.fn(async () => {});
    const f = new BuildProgressForwarder({ send, flushIntervalMs: 10_000 });
    f.start();
    f.onEvent({ type: "assistant", raw: { content: "before stop" } });
    await f.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain("before stop");
  });

  it("send rejection is swallowed; subsequent flushes still work", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network");
    });
    const f = new BuildProgressForwarder({ send, flushIntervalMs: 500 });
    f.start();
    f.onEvent({ type: "assistant", raw: { content: "first" } });
    await vi.advanceTimersByTimeAsync(500);
    f.onEvent({ type: "assistant", raw: { content: "second" } });
    await vi.advanceTimersByTimeAsync(500);
    await f.stop();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("start() is idempotent", async () => {
    const send = vi.fn(async () => {});
    const f = new BuildProgressForwarder({ send, flushIntervalMs: 500 });
    f.start();
    f.start();
    f.start();
    f.onEvent({ type: "assistant", raw: { content: "x" } });
    await vi.advanceTimersByTimeAsync(500);
    await f.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
