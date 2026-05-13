/**
 * Heuristic `LLMClient` for triage — a deterministic in-tree backend so
 * `classifyIntent` is usable today without a wired LLM. Each rule is
 * data-driven so adding new patterns is one entry. Ordered list: the first
 * match wins (so the `build_request` keyword "加个追踪" beats the `capture`
 * keyword "咖啡" inside the same message).
 *
 * The real LLM-backed implementation will replace this in a future change;
 * the heuristic stays as a deterministic test fixture and offline fallback.
 */
import type { LLMClient, TriageKind, TriageResult } from "./index.js";

export interface HeuristicRule {
  kind: TriageKind;
  name: string;
  regex: RegExp;
  confidence: number;
}

export const HEURISTIC_RULES: readonly HeuristicRule[] = [
  {
    kind: "build_request",
    name: "build_request:explicit",
    regex: /加.*功能|加个.*追踪|track.*for me|build.*for me|^\/build/i,
    confidence: 0.85,
  },
  {
    kind: "correction",
    name: "correction:phrase",
    regex: /其实是|不是.*而是|应该是|修正|^\/fix\b|correction/i,
    confidence: 0.8,
  },
  {
    kind: "query",
    name: "query:keyword",
    regex: /多少|几次|统计|最近\s*\d+\s*笔|how\s+much|how\s+many|^\/query/i,
    confidence: 0.75,
  },
  {
    kind: "capture",
    name: "capture:fact",
    regex:
      /¥\s*\d+|\$\s*\d+|\d+\s*(?:元|块)|\d+\s*km|\d+\s*kg|\d+\s*分钟|跑步|咖啡|吃了|读完|心情|喝了|买了/,
    confidence: 0.7,
  },
];

interface ParsedUserPayload {
  user_message?: string;
  [key: string]: unknown;
}

/**
 * Classify by walking `HEURISTIC_RULES` in order. Defaults to chitchat
 * (matching the spec's "prefer chitchat over capture when uncertain"
 * directive).
 */
export class HeuristicLLMClient implements LLMClient {
  async infer(params: {
    system: string;
    user: string;
    responseSchema?: unknown;
  }): Promise<string> {
    let payload: ParsedUserPayload;
    try {
      payload = JSON.parse(params.user) as ParsedUserPayload;
    } catch {
      payload = { user_message: params.user };
    }
    const message = typeof payload.user_message === "string"
      ? payload.user_message
      : "";

    const result: TriageResult = pickRule(message);
    return JSON.stringify(result);
  }
}

function pickRule(message: string): TriageResult {
  for (const rule of HEURISTIC_RULES) {
    if (rule.regex.test(message)) {
      return {
        kind: rule.kind,
        confidence: rule.confidence,
        reasoning: `matched rule '${rule.name}'`,
      };
    }
  }
  return {
    kind: "chitchat",
    confidence: 0.5,
    reasoning: "no rule matched; defaulting to chitchat (prefer-chitchat-on-uncertainty)",
  };
}
