import { describe, expect, it } from "vitest";
import { FrugalFusionError } from "../src/errors.js";
import { ModelRegistry } from "../src/modelRegistry.js";

const SNAPSHOT_FETCHED_AT = new Date().toISOString();

describe("ModelRegistry", () => {
  it("rejects zero prices instead of treating unknown cost as free", () => {
    expect(
      () =>
        new ModelRegistry([
          {
            modelId: "free-or-unknown/model",
            promptPriceUsdPerToken: 0,
            completionPriceUsdPerToken: 0.0000002,
            fetchedAt: new Date().toISOString(),
            source: "config",
          },
        ]),
    ).toThrow(FrugalFusionError);
  });

  it("rejects duplicate model ids in price snapshots instead of overwriting", () => {
    expectDuplicatePriceSnapshotError(
      () =>
        new ModelRegistry([
          snapshot("duplicate/model", {
            promptPriceUsdPerToken: 0.0000001,
          }),
          snapshot("duplicate/model", {
            promptPriceUsdPerToken: 0.0000009,
          }),
        ]),
      "duplicate/model",
    );
  });

  it("rejects duplicate model ids loaded from JSON snapshots", () => {
    expectDuplicatePriceSnapshotError(
      () =>
        ModelRegistry.fromJson(
          JSON.stringify([
            snapshot("duplicate-json/model"),
            snapshot("duplicate-json/model"),
          ]),
        ),
      "duplicate-json/model",
    );
  });

  it("rejects duplicate valid model ids from OpenRouter model snapshots", async () => {
    await expectDuplicatePriceSnapshotRejection(
      ModelRegistry.fromOpenRouter("sk-or-v1-test", async () =>
        Response.json({
          data: [
            openRouterModel("duplicate-openrouter/model"),
            openRouterModel("duplicate-openrouter/model"),
          ],
        }),
      ),
      "duplicate-openrouter/model",
    );
  });

  it("allows repeated requested ids when taking a role-specific snapshot", () => {
    const registry = new ModelRegistry([snapshot("same/model")]);

    expect(registry.snapshot(["same/model", "same/model"])).toEqual([
      snapshot("same/model"),
      snapshot("same/model"),
    ]);
  });
});

function expectDuplicatePriceSnapshotError(
  action: () => unknown,
  modelId: string,
): void {
  try {
    action();
    throw new Error("Expected duplicate price snapshot error");
  } catch (error) {
    expect(error).toBeInstanceOf(FrugalFusionError);
    expect(error).toMatchObject({
      status: "invalid_output",
      modelId,
      message: expect.stringContaining("Duplicate price snapshot entry"),
    });
  }
}

async function expectDuplicatePriceSnapshotRejection(
  promise: Promise<unknown>,
  modelId: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected duplicate price snapshot rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(FrugalFusionError);
    expect(error).toMatchObject({
      status: "invalid_output",
      modelId,
      message: expect.stringContaining("Duplicate price snapshot entry"),
    });
  }
}

function snapshot(
  modelId: string,
  overrides: Partial<ReturnType<typeof snapshotBase>> = {},
): ReturnType<typeof snapshotBase> {
  return {
    ...snapshotBase(modelId),
    ...overrides,
  };
}

function snapshotBase(modelId: string) {
  return {
    modelId,
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: SNAPSHOT_FETCHED_AT,
    source: "config" as const,
  };
}

function openRouterModel(modelId: string) {
  return {
    id: modelId,
    pricing: {
      prompt: "0.0000001",
      completion: "0.0000002",
    },
  };
}
