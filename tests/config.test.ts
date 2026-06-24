import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

describe("validateConfig", () => {
  it("rejects string booleans that could enable raw retention", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        retainRawPrompt: "false",
      } as unknown as typeof DEFAULT_CONFIG),
    ).toThrow(/retainRawPrompt/);
  });

  it("rejects invalid sampling ranges", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        sampling: {
          ...DEFAULT_CONFIG.sampling,
          repeatedSample: { temperature: 3 },
        },
      }),
    ).toThrow(/temperature/);
  });

  it("rejects stale prompt contract versions", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        promptVersion: "frugal-fusion-prompts-v1",
      }),
    ).toThrow(/promptVersion/);
  });

  it("keeps self-review and repeated baselines tied to the direct model", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: {
          ...DEFAULT_CONFIG.models,
          selfReviewModelId: "other/model",
        },
      }),
    ).toThrow(/self_review/);
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: {
          ...DEFAULT_CONFIG.models,
          repeatedModelId: "other/model",
        },
      }),
    ).toThrow(/repeated/);
  });

  it("rejects duplicate fusion candidate model ids", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: {
          ...DEFAULT_CONFIG.models,
          candidateModels: ["same/model", "same/model"],
        },
      }),
    ).toThrow(/two distinct model ids/);
  });

  it("allows cheap-panel reuse outside the two fusion candidate slots", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: {
          ...DEFAULT_CONFIG.models,
          directModelId: "cheap/a",
          selfReviewModelId: "cheap/a",
          repeatedModelId: "cheap/a",
          candidateModels: ["cheap/a", "cheap/b"],
          aggregatorModelId: "cheap/a",
        },
      }),
    ).not.toThrow();
  });

  it("rejects router, latest, and variant model aliases in fixed baselines", () => {
    const cases = [
      { path: "directModelId", modelId: "openrouter/fusion" },
      { path: "selfReviewModelId", modelId: "openrouter/auto" },
      { path: "repeatedModelId", modelId: "openrouter/free" },
      { path: "candidateModels[0]", modelId: "openrouter/pareto-code" },
      { path: "candidateModels[1]", modelId: "openrouter/bodybuilder" },
      { path: "aggregatorModelId", modelId: "~openai/gpt-latest" },
      { path: "directModelId", modelId: "openai/gpt-5.2:online" },
      { path: "candidateModels[1]", modelId: "Google/Gemini:NITRO" },
      { path: "aggregatorModelId", modelId: "moonshotai/kimi-k2:exacto" },
    ] as const;

    const baseModels: typeof DEFAULT_CONFIG.models = {
      directModelId: "cheap/a",
      selfReviewModelId: "cheap/a",
      repeatedModelId: "cheap/a",
      candidateModels: ["cheap/a", "cheap/b"],
      aggregatorModelId: "cheap/a",
    };

    for (const item of cases) {
      let models: typeof DEFAULT_CONFIG.models;
      if (item.path === "candidateModels[0]") {
        models = { ...baseModels, candidateModels: [item.modelId, "cheap/b"] };
      } else if (item.path === "candidateModels[1]") {
        models = { ...baseModels, candidateModels: ["cheap/a", item.modelId] };
      } else {
        models = { ...baseModels, [item.path]: item.modelId };
      }

      expect(() =>
        validateConfig({
          ...DEFAULT_CONFIG,
          models,
        }),
      ).toThrow(/concrete model id/);
    }
  });

  it("allows concrete OpenRouter-owned model ids in fixed baselines", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: {
          directModelId: "openrouter/example-concrete-model",
          selfReviewModelId: "openrouter/example-concrete-model",
          repeatedModelId: "openrouter/example-concrete-model",
          candidateModels: ["openrouter/example-concrete-model", "cheap/b"],
          aggregatorModelId: "openrouter/example-concrete-model",
        },
      }),
    ).not.toThrow();
  });

  it("validates provider routing order slugs", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        provider: {
          ...DEFAULT_CONFIG.provider,
          order: ["deepinfra/turbo"],
        },
      }),
    ).not.toThrow();

    const badOrders = [
      { order: [], message: /non-empty/ },
      { order: [" deepinfra/turbo"], message: /space/ },
      { order: ["deepinfra/turbo", "deepinfra/turbo"], message: /duplicate/ },
      { order: ["DeepInfra/turbo"], message: /lowercase/ },
      { order: ["deepinfra/../turbo"], message: /provider slug/ },
    ];

    for (const { order, message } of badOrders) {
      expect(() =>
        validateConfig({
          ...DEFAULT_CONFIG,
          provider: {
            ...DEFAULT_CONFIG.provider,
            order,
          },
        }),
      ).toThrow(message);
    }
  });

  it("rejects malformed nested config sections instead of silently using defaults", async () => {
    const { loadConfig } = await import("../src/config.js");
    await expect(
      loadConfig("tests/fixtures/bad-provider-config.json"),
    ).rejects.toThrow(/provider/);
  });
});
