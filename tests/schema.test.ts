import { describe, expect, it } from "vitest";
import { assertValid, matchesSchema } from "../src/schema.js";
import type { JsonSchema } from "../src/types.js";

describe("schema validation", () => {
  const closedObjectSchema: JsonSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };

  it("rejects inherited fields for closed object schemas", () => {
    const value = Object.create({ extra: "inherited" }) as Record<
      string,
      unknown
    >;
    value.ok = true;

    expect(matchesSchema(value, closedObjectSchema)).toBe(false);
    expect(() => assertValid(value, closedObjectSchema)).toThrow(
      /must be object/,
    );
  });
});
