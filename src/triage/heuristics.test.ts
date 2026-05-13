import { describe, expect, it } from "vitest";

import { classifyIntent } from "./index.js";
import { HeuristicLLMClient } from "./heuristics.js";

const llm = new HeuristicLLMClient();

async function classify(user_message: string) {
  return classifyIntent({ user_message }, llm);
}

describe("HeuristicLLMClient", () => {
  describe("capture rule fires on factual life data", () => {
    const cases = [
      "今天买了 Blue Bottle 拿铁 ¥45",
      "刚喝了一杯美式",
      "跑了 5km",
      "体重 72kg",
      "看了 30 分钟书",
      "心情有点低落",
      "吃了麻辣烫",
      "读完了《沉默的巡游》",
    ];
    it.each(cases)("%s → capture", async (msg) => {
      const r = await classify(msg);
      expect(r.kind).toBe("capture");
      expect(r.reasoning).toContain("capture:fact");
    });
  });

  describe("correction rule fires on correction phrases", () => {
    const cases = [
      "上周一咖啡其实是 ¥48",
      "不是 ¥45，而是 ¥48",
      "应该是周二不是周一",
      "/fix 上次的体重",
    ];
    it.each(cases)("%s → correction", async (msg) => {
      const r = await classify(msg);
      expect(r.kind).toBe("correction");
      expect(r.reasoning).toContain("correction:phrase");
    });
  });

  describe("query rule fires on aggregate questions", () => {
    const cases = [
      "上个月花了多少钱",
      "最近 3 笔消费是什么",
      "How much did I spend last month?",
      "本周跑了几次",
    ];
    it.each(cases)("%s → query", async (msg) => {
      const r = await classify(msg);
      expect(r.kind).toBe("query");
      expect(r.reasoning).toContain("query:keyword");
    });
  });

  describe("build_request rule fires on capability requests", () => {
    const cases = [
      "我想加个咖啡追踪",
      "/build add a sleep tracker",
      "能加个功能记录梦境吗",
      "Could you build a tracker for me?",
    ];
    it.each(cases)("%s → build_request", async (msg) => {
      const r = await classify(msg);
      expect(r.kind).toBe("build_request");
      expect(r.reasoning).toContain("build_request:explicit");
    });
  });

  describe("build_request takes priority over capture", () => {
    it("'我想加个咖啡追踪' fires build_request, not capture", async () => {
      const r = await classify("我想加个咖啡追踪");
      expect(r.kind).toBe("build_request");
    });
  });

  describe("vague inputs default to chitchat", () => {
    const cases = ["hi", "thanks", "好的", "hmm", "ok"];
    it.each(cases)("%s → chitchat", async (msg) => {
      const r = await classify(msg);
      expect(r.kind).toBe("chitchat");
      expect(r.confidence).toBe(0.5);
    });
  });
});
