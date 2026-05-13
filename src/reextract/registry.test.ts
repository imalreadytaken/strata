import { describe, expect, it } from "vitest";

import { ReextractStrategyRegistry } from "./registry.js";
import type { ReextractStrategy } from "./types.js";

const stub: ReextractStrategy = {
  name: "stub",
  async process() {
    return { kind: "skipped", reason: "noop" };
  },
};

describe("ReextractStrategyRegistry", () => {
  it("register + get returns the same strategy", () => {
    const r = new ReextractStrategyRegistry();
    r.register(stub);
    expect(r.get("stub")).toBe(stub);
  });

  it("get on unknown name returns undefined", () => {
    const r = new ReextractStrategyRegistry();
    expect(r.get("unknown")).toBeUndefined();
  });

  it("list returns every registered strategy", () => {
    const r = new ReextractStrategyRegistry();
    r.register(stub);
    r.register({ name: "other", process: stub.process });
    expect(r.list().map((s) => s.name).sort()).toEqual(["other", "stub"]);
  });

  it("registering a duplicate name throws STRATA_E_VALIDATION", () => {
    const r = new ReextractStrategyRegistry();
    r.register(stub);
    expect(() => r.register(stub)).toThrow(/already registered/);
  });
});
