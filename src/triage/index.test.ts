import { describe, expect, it } from "vitest";

import {
  classifyIntent,
  triageInputSchema,
  triageResultSchema,
  type LLMClient,
} from "./index.js";

function stub(response: string): LLMClient {
  return { infer: async () => response };
}

describe("triageResultSchema", () => {
  it("accepts a valid result", () => {
    expect(() =>
      triageResultSchema.parse({
        kind: "capture",
        confidence: 0.9,
        reasoning: "money pattern",
      }),
    ).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      triageResultSchema.parse({
        kind: "something_else",
        confidence: 0.5,
        reasoning: "x",
      }),
    ).toThrow();
  });

  it("rejects confidence > 1", () => {
    expect(() =>
      triageResultSchema.parse({
        kind: "capture",
        confidence: 1.5,
        reasoning: "x",
      }),
    ).toThrow();
  });

  it("rejects empty reasoning", () => {
    expect(() =>
      triageResultSchema.parse({
        kind: "capture",
        confidence: 0.5,
        reasoning: "",
      }),
    ).toThrow();
  });
});

describe("triageInputSchema", () => {
  it("defaults array fields to []", () => {
    const parsed = triageInputSchema.parse({ user_message: "hi" });
    expect(parsed.recent_messages).toEqual([]);
    expect(parsed.active_capabilities).toEqual([]);
    expect(parsed.pending_event_summaries).toEqual([]);
  });

  it("rejects an empty user_message", () => {
    expect(() => triageInputSchema.parse({ user_message: "" })).toThrow();
  });
});

describe("classifyIntent", () => {
  it("parses a valid LLM response into a TriageResult", async () => {
    const llm = stub(
      JSON.stringify({
        kind: "capture",
        confidence: 0.9,
        reasoning: "money pattern",
      }),
    );
    const result = await classifyIntent(
      { user_message: "今天买了 ¥45 咖啡" },
      llm,
    );
    expect(result).toEqual({
      kind: "capture",
      confidence: 0.9,
      reasoning: "money pattern",
    });
  });

  it("rejects malformed JSON from the LLM", async () => {
    const llm = stub("not json");
    await expect(
      classifyIntent({ user_message: "x" }, llm),
    ).rejects.toThrow(/failed to parse/);
  });

  it("rejects a response that fails the result schema", async () => {
    const llm = stub(
      JSON.stringify({
        kind: "capture",
        confidence: 99,
        reasoning: "x",
      }),
    );
    await expect(
      classifyIntent({ user_message: "x" }, llm),
    ).rejects.toThrow();
  });
});
