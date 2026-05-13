import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toJsonSchema } from "./zod_to_json_schema.js";

describe("toJsonSchema", () => {
  it("converts a Zod object schema to draft-2020-12 JSON Schema", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number().int().optional(),
    });
    const json = toJsonSchema(schema) as Record<string, unknown>;
    expect(json.type).toBe("object");
    expect((json.properties as Record<string, unknown>).name).toBeDefined();
    expect((json.properties as Record<string, unknown>).count).toBeDefined();
    expect(json.required).toEqual(["name"]);
  });

  it("includes descriptions when provided", () => {
    const schema = z.object({
      label: z.string().describe("Human-readable label"),
    });
    const json = toJsonSchema(schema) as Record<string, unknown>;
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.label?.description).toBe("Human-readable label");
  });
});
