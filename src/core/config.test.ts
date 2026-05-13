import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoForbiddenKeys,
  ConfigSchema,
  expandTilde,
  loadConfig,
} from "./config.js";
import { ConfigError } from "./errors.js";

describe("expandTilde", () => {
  it("returns the home dir for a bare '~'", () => {
    expect(expandTilde("~")).toBe(os.homedir());
  });

  it("expands a leading '~/' to under the home dir", () => {
    expect(expandTilde("~/foo/bar")).toBe(path.join(os.homedir(), "foo", "bar"));
  });

  it("leaves other paths alone", () => {
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    expect(expandTilde("relative/path")).toBe("relative/path");
    expect(expandTilde("not~prefixed")).toBe("not~prefixed");
  });
});

describe("assertNoForbiddenKeys", () => {
  it("accepts an object with no forbidden keys", () => {
    expect(() => assertNoForbiddenKeys({ ok: 1, nested: { fine: true } })).not.toThrow();
  });

  it.each(["api_key", "API_KEY", "apiKey", "api-key", "token", "secret"])(
    "rejects top-level key %s",
    (key) => {
      const cfg = { [key]: "x" };
      expect(() => assertNoForbiddenKeys(cfg)).toThrowError(ConfigError);
    },
  );

  it("rejects forbidden keys at depth", () => {
    const cfg = { provider: { settings: { token: "x" } } };
    let caught: unknown;
    try {
      assertNoForbiddenKeys(cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("STRATA_E_CONFIG_FORBIDDEN_KEY");
    expect((caught as ConfigError).message).toContain("provider.settings.token");
  });

  it("does not flag innocent keys that merely contain a forbidden substring", () => {
    expect(() =>
      assertNoForbiddenKeys({ secret_friend_quote: "ok" }),
    ).not.toThrow();
    expect(() => assertNoForbiddenKeys({ topkey: "ok" })).not.toThrow();
  });

  it("walks arrays", () => {
    const cfg = { providers: [{ name: "anthropic", api_key: "x" }] };
    expect(() => assertNoForbiddenKeys(cfg)).toThrowError(ConfigError);
  });
});

describe("ConfigSchema defaults", () => {
  it("fills every default when given an empty object", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.version).toBe("1.0");
    expect(cfg.database.path).toBe("~/.strata/main.db");
    expect(cfg.paths.dataDir).toBe("~/.strata");
    expect(cfg.logging.level).toBe("info");
    expect(cfg.pending.timeoutMinutes).toBe(30);
    expect(cfg.models.fast).toBe("auto");
    expect(cfg.models.smart).toBe("auto");
    expect(cfg.models.coder).toBe("claude-code-cli");
  });

  it("rejects unknown top-level keys", () => {
    expect(() => ConfigSchema.parse({ unknown: true })).toThrow();
  });

  it("accepts a real 'provider/modelId' in models.fast", () => {
    const cfg = ConfigSchema.parse({
      models: { fast: "anthropic/claude-haiku-4-5" },
    });
    expect(cfg.models.fast).toBe("anthropic/claude-haiku-4-5");
  });

  it("rejects an invalid log level", () => {
    expect(() => ConfigSchema.parse({ logging: { level: "trace" } })).toThrow();
  });
});

describe("loadConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-cfg-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const write = (body: string): string => {
    const p = path.join(tmp, "config.json");
    writeFileSync(p, body, "utf8");
    return p;
  };

  it("returns defaults when the file is missing", async () => {
    const cfg = await loadConfig({ path: path.join(tmp, "missing.json") });
    expect(cfg.version).toBe("1.0");
    expect(cfg.logging.level).toBe("info");
    // Paths are expanded.
    expect(cfg.database.path.startsWith("/")).toBe(true);
  });

  it("loads a valid JSON5 config and expands tilde paths", async () => {
    const p = write(`{
      // a JSON5 comment
      version: '1.0',
      paths: {
        dataDir: '~/somewhere',
        capabilitiesDir: '~/somewhere/capabilities',
        openspecDir: '~/somewhere/openspec',
        plansDir: '~/somewhere/plans',
        buildsDir: '~/somewhere/builds',
        logsDir: '~/somewhere/logs',
      },
      logging: { level: 'warn' },
    }`);
    const cfg = await loadConfig({ path: p });
    expect(cfg.paths.dataDir).toBe(path.join(os.homedir(), "somewhere"));
    expect(cfg.logging.level).toBe("warn");
  });

  it("rejects an invalid schema with STRATA_E_CONFIG_INVALID and a field path", async () => {
    const p = write(`{ logging: { level: 'verbose' } }`);
    let caught: unknown;
    try {
      await loadConfig({ path: p });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const cfg = caught as ConfigError;
    expect(cfg.code).toBe("STRATA_E_CONFIG_INVALID");
    expect(cfg.message).toContain("logging.level");
  });

  it("rejects malformed JSON5 with STRATA_E_CONFIG_INVALID", async () => {
    const p = write(`{ not: valid, json,, }`);
    await expect(loadConfig({ path: p })).rejects.toMatchObject({
      code: "STRATA_E_CONFIG_INVALID",
    });
  });

  it.each([
    ["top-level", `{ api_key: 'x' }`],
    ["nested", `{ providers: { anthropic: { token: 'x' } } }`],
  ])("rejects a forbidden key (%s)", async (_label, body) => {
    const p = write(body);
    await expect(loadConfig({ path: p })).rejects.toMatchObject({
      code: "STRATA_E_CONFIG_FORBIDDEN_KEY",
    });
  });

  it("returns a frozen config", async () => {
    const cfg = await loadConfig({ path: path.join(tmp, "missing.json") });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
