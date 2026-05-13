/**
 * Real LLM-backed `LLMClient` using `@mariozechner/pi-ai`. The runtime
 * factory `resolveLLMClient(config, opts)` picks pi-ai when the user has
 * configured a real model + provided an API key via environment; otherwise
 * it falls back to the `HeuristicLLMClient` so Strata stays usable.
 *
 * See `openspec/changes/add-llm-client/specs/llm-client/spec.md`.
 */
import {
  complete as piAiComplete,
  getModel as piAiGetModel,
  getEnvApiKey as piAiGetEnvApiKey,
  type AssistantMessage,
  type KnownProvider,
} from "@mariozechner/pi-ai";

import type { StrataConfig } from "../core/config.js";
import { StrataError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { HeuristicLLMClient } from "../triage/heuristics.js";
import type { LLMClient } from "../triage/index.js";

/** Subset of pi-ai's KnownProvider list we accept in `models.<purpose>`. */
const KNOWN_PROVIDERS = new Set<string>([
  "amazon-bedrock",
  "anthropic",
  "google",
  "google-gemini-cli",
  "google-antigravity",
  "google-vertex",
  "openai",
  "azure-openai-responses",
  "openai-codex",
  "github-copilot",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "mistral",
  "minimax",
  "minimax-cn",
  "huggingface",
  "opencode",
  "opencode-go",
  "kimi-coding",
]);

export interface PiAiLLMClientOptions {
  provider: KnownProvider;
  modelId: string;
  /** Override the env-derived key. Tests / OpenClaw auth path use this. */
  apiKey?: string;
  /** Injectable pi-ai `complete` for tests. */
  complete?: typeof piAiComplete;
  /** Injectable pi-ai `getModel` for tests. */
  getModel?: typeof piAiGetModel;
  logger?: Logger;
}

interface CompletePayload {
  apiKey?: string;
}

type CompleteFn = (
  model: unknown,
  context: unknown,
  options?: CompletePayload,
) => Promise<AssistantMessage>;

export class PiAiLLMClient implements LLMClient {
  private readonly provider: KnownProvider;
  private readonly modelId: string;
  private readonly apiKey: string | undefined;
  private readonly completeFn: CompleteFn;
  private readonly getModelFn: typeof piAiGetModel;
  private readonly logger: Logger | undefined;

  constructor(opts: PiAiLLMClientOptions) {
    this.provider = opts.provider;
    this.modelId = opts.modelId;
    this.apiKey = opts.apiKey;
    this.completeFn = (opts.complete ?? piAiComplete) as unknown as CompleteFn;
    this.getModelFn = opts.getModel ?? piAiGetModel;
    this.logger = opts.logger;
  }

  async infer(params: {
    system: string;
    user: string;
    responseSchema?: unknown;
  }): Promise<string> {
    const log = this.logger?.child({ module: "llm.pi_ai_client" });
    let model: unknown;
    try {
      // Cast forced: getModel's generic constraint wants a literal type pair,
      // but at runtime it accepts any (provider, modelId) and returns a Model
      // shape pi-ai can dispatch on.
      model = (this.getModelFn as unknown as (p: string, m: string) => unknown)(
        this.provider,
        this.modelId,
      );
    } catch (err) {
      throw new StrataError(
        "STRATA_E_LLM_FAILED",
        `pi-ai getModel('${this.provider}', '${this.modelId}') failed: ${(err as Error).message}`,
        { cause: err },
      );
    }

    const context = {
      systemPrompt: params.system,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: params.user }],
        },
      ],
    };

    const completeOpts: CompletePayload = {};
    if (this.apiKey) completeOpts.apiKey = this.apiKey;
    let assistant: AssistantMessage;
    try {
      assistant = await this.completeFn(model, context, completeOpts);
    } catch (err) {
      log?.warn("pi-ai complete() rejected", { error: (err as Error).message });
      throw new StrataError(
        "STRATA_E_LLM_FAILED",
        `pi-ai complete() failed: ${(err as Error).message}`,
        { cause: err },
      );
    }

    const text = flattenAssistantText(assistant);
    if (text.length === 0) {
      throw new StrataError(
        "STRATA_E_LLM_EMPTY_RESPONSE",
        "pi-ai complete() returned no text content",
      );
    }
    return text;
  }
}

function flattenAssistantText(assistant: AssistantMessage): string {
  if (!assistant || !Array.isArray(assistant.content)) return "";
  const parts: string[] = [];
  for (const c of assistant.content) {
    if (typeof c === "object" && c !== null && "type" in c) {
      const obj = c as { type: string; text?: unknown };
      if (obj.type === "text" && typeof obj.text === "string") {
        parts.push(obj.text);
      }
    }
  }
  return parts.join("");
}

// -------------------------------------------------------------------------
// Resolver
// -------------------------------------------------------------------------

export interface LLMClientResolution {
  client: LLMClient;
  backend: "pi-ai" | "heuristic";
  /** `'provider/modelId'` when backend is pi-ai. */
  model?: string;
}

export interface ResolveLLMClientOptions {
  logger: Logger;
  /** Override env API key lookup (tests). */
  getEnvApiKey?: typeof piAiGetEnvApiKey;
  /** Override the explicit API key (tests / future OpenClaw auth integration). */
  apiKey?: string;
  /** Test override for pi-ai's `complete`. */
  complete?: typeof piAiComplete;
  /** Test override for pi-ai's `getModel`. */
  getModel?: typeof piAiGetModel;
}

/**
 * Pick the LLM backend based on `config.models.fast`. Falls back to the
 * heuristic on any failure (unknown provider, missing key). Never throws —
 * triage runs on every inbound message and must keep working when the LLM
 * is unreachable.
 */
export function resolveLLMClient(
  config: StrataConfig,
  opts: ResolveLLMClientOptions,
): LLMClientResolution {
  const log = opts.logger.child({ module: "llm.resolve" });
  const spec = config.models.fast;

  if (spec === "auto") {
    log.info("llmClient backend: heuristic (config.models.fast='auto')");
    return { client: new HeuristicLLMClient(), backend: "heuristic" };
  }

  const slashIdx = spec.indexOf("/");
  if (slashIdx <= 0 || slashIdx === spec.length - 1) {
    log.warn("config.models.fast does not match '<provider>/<modelId>'; falling back to heuristic", {
      spec,
    });
    return { client: new HeuristicLLMClient(), backend: "heuristic" };
  }
  const provider = spec.slice(0, slashIdx);
  const modelId = spec.slice(slashIdx + 1);

  if (!KNOWN_PROVIDERS.has(provider)) {
    log.warn("config.models.fast provider is not a pi-ai KnownProvider; falling back to heuristic", {
      provider,
      spec,
    });
    return { client: new HeuristicLLMClient(), backend: "heuristic" };
  }

  const getEnvKey = opts.getEnvApiKey ?? piAiGetEnvApiKey;
  const apiKey = opts.apiKey ?? getEnvKey(provider);
  if (!apiKey || apiKey.length === 0) {
    log.warn(
      "no API key resolved for provider; falling back to heuristic (set the relevant *_API_KEY env var to enable real LLM)",
      { provider },
    );
    return { client: new HeuristicLLMClient(), backend: "heuristic" };
  }

  log.info("llmClient backend: pi-ai", { provider, modelId });
  const clientOpts: PiAiLLMClientOptions = {
    provider: provider as KnownProvider,
    modelId,
    apiKey,
    logger: opts.logger,
  };
  if (opts.complete) clientOpts.complete = opts.complete;
  if (opts.getModel) clientOpts.getModel = opts.getModel;
  return {
    client: new PiAiLLMClient(clientOpts),
    backend: "pi-ai",
    model: `${provider}/${modelId}`,
  };
}
