import { FrugalFusionError } from "./errors.js";
import type { AggregatorOutput, JsonSchema } from "./types.js";

export const answerSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
  additionalProperties: false,
} satisfies JsonSchema;

export const candidateSchema = {
  type: "object",
  properties: {
    candidateId: { type: "string" },
    conclusion: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claimId: { type: "string" },
          text: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["claimId", "text", "evidenceIds", "confidence"],
        additionalProperties: false,
      },
    },
    reasoningOutline: { type: "array", items: { type: "string" } },
    alternatives: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  },
  required: [
    "candidateId",
    "conclusion",
    "claims",
    "reasoningOutline",
    "alternatives",
    "risks",
    "unresolved",
  ],
  additionalProperties: false,
} satisfies JsonSchema;

export const aggregatorSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    ledger: {
      type: "object",
      properties: {
        consensusClaimIds: { type: "array", items: { type: "string" } },
        adoptedClaimIds: { type: "array", items: { type: "string" } },
        uniqueAdoptedClaimIds: {
          type: "array",
          items: { type: "string" },
        },
        rejectedClaims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claimId: { type: "string" },
              reason: {
                type: "string",
                enum: [
                  "unsupported",
                  "contradicted",
                  "irrelevant",
                  "duplicate",
                ],
              },
            },
            required: ["claimId", "reason"],
            additionalProperties: false,
          },
        },
        conflicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              topic: { type: "string" },
              claimIds: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: ["resolved", "unresolved"] },
              resolution: { type: "string" },
            },
            required: ["topic", "claimIds", "status"],
            additionalProperties: false,
          },
        },
        coverageGaps: { type: "array", items: { type: "string" } },
        blindSpots: { type: "array", items: { type: "string" } },
        requiredChecks: { type: "array", items: { type: "string" } },
      },
      required: [
        "consensusClaimIds",
        "adoptedClaimIds",
        "uniqueAdoptedClaimIds",
        "rejectedClaims",
        "conflicts",
        "coverageGaps",
        "blindSpots",
        "requiredChecks",
      ],
      additionalProperties: false,
    },
  },
  required: ["answer", "ledger"],
  additionalProperties: false,
} satisfies JsonSchema;

export function assertValid<T>(value: unknown, schema: JsonSchema): T {
  const errors: string[] = [];
  validate(value, schema, "$", errors);
  if (errors.length > 0) {
    throw new FrugalFusionError(
      `Invalid structured output: ${errors.join("; ")}`,
      "invalid_output",
    );
  }
  return value as T;
}

export function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  const errors: string[] = [];
  validate(value, schema, "$", errors);
  return errors.length === 0;
}

function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (schema.type === "object") {
    if (!isPlainRecord(value)) {
      errors.push(`${path} must be object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, nested] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key))
        validate(value[key], nested, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key))
          errors.push(`${path}.${key} is not allowed`);
      }
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be array`);
      return;
    }
    value.forEach((item, index) =>
      validate(item, schema.items, `${path}[${index}]`, errors),
    );
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path} must be string`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value))
      errors.push(`${path} must be one of ${schema.enum.join(",")}`);
    return;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${path} must be number`);
      return;
    }
    if (schema.type === "integer" && !Number.isInteger(value))
      errors.push(`${path} must be integer`);
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} above maximum`);
    return;
  }

  if (typeof value !== "boolean") errors.push(`${path} must be boolean`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function emptyLedger(): AggregatorOutput["ledger"] {
  return {
    consensusClaimIds: [],
    adoptedClaimIds: [],
    uniqueAdoptedClaimIds: [],
    rejectedClaims: [],
    conflicts: [],
    coverageGaps: [],
    blindSpots: [],
    requiredChecks: [],
  };
}
