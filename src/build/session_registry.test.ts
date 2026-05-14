import { describe, expect, it } from "vitest";

import { createLogger } from "../core/logger.js";
import { BuildSessionRegistry } from "./session_registry.js";

function makeRegistry() {
  return new BuildSessionRegistry(
    createLogger({ level: "warn", logFilePath: "/dev/null" }),
  );
}

describe("BuildSessionRegistry", () => {
  it("register → get returns the entry", () => {
    const r = makeRegistry();
    const c = new AbortController();
    r.register(7, c, "s1");
    const entry = r.get(7);
    expect(entry?.controller).toBe(c);
    expect(entry?.sessionId).toBe("s1");
    expect(typeof entry?.startedAt).toBe("string");
  });

  it("abort fires the signal and returns stopped:true", () => {
    const r = makeRegistry();
    const c = new AbortController();
    r.register(7, c, "s1");
    const result = r.abort(7);
    expect(result).toEqual({ stopped: true });
    expect(c.signal.aborted).toBe(true);
  });

  it("abort on missing id returns stopped:false", () => {
    const r = makeRegistry();
    expect(r.abort(99)).toEqual({ stopped: false });
  });

  it("complete deregisters; subsequent abort returns stopped:false", () => {
    const r = makeRegistry();
    const c = new AbortController();
    r.register(7, c, "s1");
    r.complete(7);
    expect(r.get(7)).toBeUndefined();
    expect(r.abort(7)).toEqual({ stopped: false });
    expect(c.signal.aborted).toBe(false);
  });

  it("complete on missing id is a no-op", () => {
    const r = makeRegistry();
    expect(() => r.complete(99)).not.toThrow();
  });

  it("list returns one entry per register", () => {
    const r = makeRegistry();
    r.register(1, new AbortController(), "s1");
    r.register(2, new AbortController(), "s2");
    const items = r.list().sort((a, b) => a.buildId - b.buildId);
    expect(items.map((x) => x.buildId)).toEqual([1, 2]);
    expect(r.size()).toBe(2);
  });

  it("re-registering the same id replaces the previous controller", () => {
    const r = makeRegistry();
    const c1 = new AbortController();
    const c2 = new AbortController();
    r.register(7, c1, "s1");
    r.register(7, c2, "s2");
    expect(r.get(7)?.controller).toBe(c2);
    expect(r.size()).toBe(1);
  });
});
