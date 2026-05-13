import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DatabaseError,
  NotFoundError,
  StateMachineError,
  StrataError,
  ValidationError,
} from "./errors.js";

describe("StrataError hierarchy", () => {
  const subclasses = [
    ["ConfigError", ConfigError],
    ["DatabaseError", DatabaseError],
    ["ValidationError", ValidationError],
    ["NotFoundError", NotFoundError],
    ["StateMachineError", StateMachineError],
  ] as const;

  for (const [name, Cls] of subclasses) {
    it(`${name} is instanceof StrataError, ${name}, and Error`, () => {
      const err = new Cls("STRATA_E_VALIDATION", "boom");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(StrataError);
      expect(err).toBeInstanceOf(Cls);
      expect(err.name).toBe(name);
    });
  }

  it("preserves the supplied code on the instance", () => {
    const err = new ConfigError("STRATA_E_CONFIG_INVALID", "bad value");
    expect(err.code).toBe("STRATA_E_CONFIG_INVALID");
    expect(err.message).toBe("bad value");
  });

  it("captures a cause when provided", () => {
    const inner = new Error("disk full");
    const err = new DatabaseError("STRATA_E_DB_OPEN_FAILED", "open failed", {
      cause: inner,
    });
    expect(err.cause).toBe(inner);
  });

  it("toJSON returns { name, code, message } and no cause when absent", () => {
    const err = new ValidationError("STRATA_E_VALIDATION", "nope");
    expect(err.toJSON()).toEqual({
      name: "ValidationError",
      code: "STRATA_E_VALIDATION",
      message: "nope",
    });
  });

  it("toJSON includes cause.message when cause is an Error", () => {
    const err = new DatabaseError("STRATA_E_DB_QUERY_FAILED", "nope", {
      cause: new Error("syntax"),
    });
    expect(err.toJSON()).toEqual({
      name: "DatabaseError",
      code: "STRATA_E_DB_QUERY_FAILED",
      message: "nope",
      cause: "syntax",
    });
  });

  it("toJSON stringifies non-Error causes", () => {
    const err = new StrataError("STRATA_E_VALIDATION", "nope", {
      cause: { msg: "primitive cause" },
    });
    expect(err.toJSON().cause).toBe("[object Object]");
  });

  it("preserves a usable stack trace", () => {
    const err = new ConfigError("STRATA_E_CONFIG_INVALID", "x");
    expect(typeof err.stack).toBe("string");
    expect(err.stack ?? "").toContain("ConfigError");
  });
});
