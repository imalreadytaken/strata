import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigSchema } from "../core/config.js";
import { createLogger, type Logger } from "../core/logger.js";
import {
  PiAiLLMClient,
  resolveLLMClient,
} from "./pi_ai_client.js";

function makeConfig(modelsFast: string): ReturnType<typeof ConfigSchema.parse> {
  return ConfigSchema.parse({ models: { fast: modelsFast } });
}

describe("PiAiLLMClient", () => {
  let tmp: string;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-piai-"));
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("happy path concatenates assistant text parts", async () => {
    const complete = vi.fn(async () => ({
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "hi" },
        { type: "text" as const, text: " there" },
      ],
      stopReason: "stop" as const,
      usage: {} as never,
    })) as unknown as Parameters<typeof PiAiLLMClient.prototype.infer>[0] extends never
      ? never
      : never;
    const getModel = vi.fn(() => ({ id: "m" }) as never);
    const client = new PiAiLLMClient({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      apiKey: "fake-key",
      complete: complete as unknown as Parameters<typeof PiAiLLMClient>[0]["complete"],
      getModel: getModel as unknown as Parameters<typeof PiAiLLMClient>[0]["getModel"],
      logger,
    });
    const out = await client.infer({ system: "S", user: "U" });
    expect(out).toBe("hi there");
    // complete invoked with our injected model and a context shaped like
    // { systemPrompt, messages }.
    expect((complete as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
    const callArgs = (complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const ctx = callArgs[1] as { systemPrompt: string; messages: unknown[] };
    expect(ctx.systemPrompt).toBe("S");
    expect(ctx.messages).toHaveLength(1);
  });

  it("empty content throws STRATA_E_LLM_EMPTY_RESPONSE", async () => {
    const complete = vi.fn(async () => ({
      role: "assistant",
      content: [],
      stopReason: "stop",
      usage: {} as never,
    }));
    const getModel = vi.fn(() => ({}) as never);
    const client = new PiAiLLMClient({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      apiKey: "fake",
      complete: complete as never,
      getModel: getModel as never,
    });
    await expect(client.infer({ system: "x", user: "y" })).rejects.toMatchObject({
      code: "STRATA_E_LLM_EMPTY_RESPONSE",
    });
  });

  it("complete rejection becomes STRATA_E_LLM_FAILED with cause preserved", async () => {
    const original = new Error("network down");
    const complete = vi.fn(async () => {
      throw original;
    });
    const getModel = vi.fn(() => ({}) as never);
    const client = new PiAiLLMClient({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      apiKey: "fake",
      complete: complete as never,
      getModel: getModel as never,
    });
    await expect(client.infer({ system: "x", user: "y" })).rejects.toMatchObject({
      code: "STRATA_E_LLM_FAILED",
    });
    // cause is preserved
    try {
      await client.infer({ system: "x", user: "y" });
    } catch (err) {
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  it("getModel rejection becomes STRATA_E_LLM_FAILED", async () => {
    const getModel = vi.fn(() => {
      throw new Error("unknown modelId");
    });
    const client = new PiAiLLMClient({
      provider: "anthropic",
      modelId: "non-existent",
      apiKey: "fake",
      complete: (async () => ({})) as never,
      getModel: getModel as never,
    });
    await expect(client.infer({ system: "x", user: "y" })).rejects.toMatchObject({
      code: "STRATA_E_LLM_FAILED",
    });
  });
});

describe("resolveLLMClient", () => {
  let tmp: string;
  let logger: Logger;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "strata-piai-resolve-"));
    logger = createLogger({
      level: "debug",
      logFilePath: path.join(tmp, "log.log"),
    });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("'auto' returns heuristic backend", () => {
    const res = resolveLLMClient(makeConfig("auto"), { logger });
    expect(res.backend).toBe("heuristic");
    expect(res.model).toBeUndefined();
  });

  it("known provider + present env key returns pi-ai backend", () => {
    const res = resolveLLMClient(makeConfig("anthropic/claude-haiku-4-5"), {
      logger,
      getEnvApiKey: () => "fake-key",
    });
    expect(res.backend).toBe("pi-ai");
    expect(res.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("missing env key falls back to heuristic", () => {
    const res = resolveLLMClient(makeConfig("anthropic/claude-haiku-4-5"), {
      logger,
      getEnvApiKey: () => undefined,
    });
    expect(res.backend).toBe("heuristic");
  });

  it("unknown provider falls back to heuristic", () => {
    const res = resolveLLMClient(makeConfig("magic/x"), {
      logger,
      getEnvApiKey: () => "fake",
    });
    expect(res.backend).toBe("heuristic");
  });

  it("malformed spec (no slash) falls back to heuristic", () => {
    const res = resolveLLMClient(makeConfig("just-a-name"), {
      logger,
      getEnvApiKey: () => "fake",
    });
    expect(res.backend).toBe("heuristic");
  });

  it("empty apiKey is treated as missing", () => {
    const res = resolveLLMClient(makeConfig("anthropic/claude-haiku-4-5"), {
      logger,
      getEnvApiKey: () => "",
    });
    expect(res.backend).toBe("heuristic");
  });

  it("explicit apiKey overrides the env lookup", () => {
    const res = resolveLLMClient(makeConfig("anthropic/claude-haiku-4-5"), {
      logger,
      apiKey: "explicit",
      getEnvApiKey: () => undefined, // would otherwise fail
    });
    expect(res.backend).toBe("pi-ai");
  });
});
