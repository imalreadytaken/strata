import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _bootCountersForTests,
  _resetBootCountersForTests,
  bootRuntime,
  resetRuntimeForTests,
} from "./runtime.js";

function makeMockApi(): OpenClawPluginApi {
  return {
    on: vi.fn(),
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

describe("bootRuntime", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-runtime-"));
    // Point HOME at the temp dir so loadConfig() reads its missing
    // ~/.strata/config.json and falls back to defaults under tmp.
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
    _resetBootCountersForTests();
  });

  afterEach(async () => {
    await resetRuntimeForTests();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  it("opens the DB, runs migrations, and exposes every repository", async () => {
    const api = makeMockApi();
    const runtime = await bootRuntime(api);
    expect(runtime.config.paths.dataDir).toBe(path.join(tmp, ".strata"));
    expect(runtime.db.open).toBe(true);
    // All eight repositories present
    expect(runtime.messagesRepo).toBeDefined();
    expect(runtime.rawEventsRepo).toBeDefined();
    expect(runtime.capabilityRegistryRepo).toBeDefined();
    expect(runtime.schemaEvolutionsRepo).toBeDefined();
    expect(runtime.reextractJobsRepo).toBeDefined();
    expect(runtime.buildsRepo).toBeDefined();
    expect(runtime.proposalsRepo).toBeDefined();
    expect(runtime.capabilityHealthRepo).toBeDefined();
    // System tables exist (we can insert).
    expect(await runtime.messagesRepo.count()).toBe(0);
    // First-party capabilities load from the bundled root.
    expect(runtime.capabilities).toBeInstanceOf(Map);
    expect(runtime.capabilities.has("expenses")).toBe(true);
    expect(runtime.capabilities.get("expenses")!.meta.primary_table).toBe(
      "expenses",
    );
    expect(runtime.capabilities.get("expenses")!.meta.ingest_event_types).toContain(
      "consumption",
    );
    // LLMClient is wired (default: heuristic backend).
    expect(runtime.llmClient).toBeDefined();
    expect(typeof runtime.llmClient.infer).toBe("function");
  });

  it("is idempotent: two calls return the same runtime, migrations run once", async () => {
    const api = makeMockApi();
    const r1 = await bootRuntime(api);
    const r2 = await bootRuntime(api);
    expect(r2).toBe(r1);
    const counters = _bootCountersForTests();
    expect(counters.bootCount).toBe(1);
    expect(counters.migrateCount).toBe(1);
  });

  it("propagates and does not poison the cache on first-call failure", async () => {
    // Write a config that violates the forbidden-key rule so loadConfig throws.
    const cfgDir = path.join(tmp, ".strata");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(path.join(cfgDir, "config.json"), `{ api_key: "x" }`);

    const api = makeMockApi();
    await expect(bootRuntime(api)).rejects.toMatchObject({
      code: "STRATA_E_CONFIG_FORBIDDEN_KEY",
    });

    // The error logger was called once with our failure.
    expect(api.logger.error).toHaveBeenCalled();

    // Now fix the config and try again — the cache should have been cleared,
    // so this call really retries the boot rather than returning the prior
    // failed promise.
    writeFileSync(path.join(cfgDir, "config.json"), `{}`);
    const runtime = await bootRuntime(api);
    expect(runtime.config.version).toBe("1.0");
  });
});
