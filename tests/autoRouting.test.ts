import { describe, expect, it } from "vitest";
import { selectAutoMode } from "../src/autoRouting.js";
import type {
  Budget,
  ModelRoleConfig,
  PriceSnapshotEntry,
} from "../src/types.js";

const models: ModelRoleConfig = {
  directModelId: "m/direct",
  selfReviewModelId: "m/direct",
  repeatedModelId: "m/repeated",
  candidateModels: ["m/cand-a", "m/cand-b"],
  aggregatorModelId: "m/aggregator",
};

const ALL_IDS = [
  "m/direct",
  "m/repeated",
  "m/cand-a",
  "m/cand-b",
  "m/aggregator",
];

const base: Budget = {
  maxCostUsd: 99,
  maxLatencyMs: 1_000,
  maxCandidates: 2,
  maxCompletionTokens: 100,
  maxRepairRounds: 1,
};

function mkPrices(
  ids: string[],
  promptPrice = 1e-7,
): ReadonlyMap<string, PriceSnapshotEntry> {
  return new Map(
    ids.map((id) => [
      id,
      {
        modelId: id,
        promptPriceUsdPerToken: promptPrice,
        completionPriceUsdPerToken: promptPrice * 2,
        fetchedAt: "2025-01-01T00:00:00Z",
        source: "config" as const,
      },
    ]),
  );
}

const allPrices = mkPrices(ALL_IDS);

describe("selectAutoMode", () => {
  it("selects fusion when budget is generous", () => {
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 1 },
      allPrices,
      10,
    );
    expect(result.mode).toBe("fusion");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        requestedMode: "auto",
        selectedMode: "fusion",
        strategy: "budget_aware_v1",
        reason: "selected_richest_within_budget",
        budgetCeilingUsd: 1,
      }),
    );
    expect(result.metadata.selectedModeEstimatedCostUsd).toBeGreaterThan(0);
  });

  it("falls back to direct with fell_back reason when no mode fits budget", () => {
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 0 },
      allPrices,
      10,
    );
    expect(result.mode).toBe("direct");
    expect(result.metadata.reason).toBe("fell_back_to_direct_over_budget");
    expect(result.metadata.selectedMode).toBe("direct");
    expect(result.metadata.selectedModeEstimatedCostUsd).toBe(0);
  });

  it("falls back to direct with unavailable reason when prices are missing", () => {
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 1 },
      new Map(),
      10,
    );
    expect(result.mode).toBe("direct");
    expect(result.metadata.reason).toBe(
      "estimate_unavailable_defaulted_to_direct",
    );
    expect(result.metadata.selectedModeEstimatedCostUsd).toBe(0);
  });

  it("skips fusion and repeated when maxCandidates is below threshold, selects self_review", () => {
    // fusion and repeated require maxCandidates >= 2
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 1, maxCandidates: 1 },
      allPrices,
      10,
    );
    expect(result.mode).toBe("self_review");
    expect(result.metadata.reason).toBe("selected_richest_within_budget");
  });

  it("skips self_review when maxRepairRounds is 0, selects direct", () => {
    // maxCandidates: 1 → fusion/repeated ineligible
    // maxRepairRounds: 0 → self_review ineligible
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 1, maxCandidates: 1, maxRepairRounds: 0 },
      allPrices,
      10,
    );
    expect(result.mode).toBe("direct");
    expect(result.metadata.reason).toBe("selected_richest_within_budget");
  });

  it("reports the budget ceiling in metadata", () => {
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 0.42 },
      allPrices,
      10,
    );
    expect(result.metadata.budgetCeilingUsd).toBe(0.42);
  });

  it("excludes depends_on_generated_output calls from the prompt cost estimate", () => {
    // self_review: draft (known_initial_request) + review (depends_on_generated_output)
    // With maxCompletionTokens:100 → tokens split [60, 40]
    // completionCost = 100 × 2e-7 = 2e-5
    // promptCost (correct) = 10 × 1e-7 (draft only) = 1e-6 → total = 2.1e-5
    // promptCost (wrong, both counted) = 2 × 10 × 1e-7 = 2e-6 → total = 2.2e-5
    // Budget 2.15e-5: correct impl selects self_review; wrong impl would reject it
    const result = selectAutoMode(
      models,
      { ...base, maxCostUsd: 2.15e-5, maxCandidates: 1 },
      allPrices,
      10,
    );
    expect(result.mode).toBe("self_review");
  });
});
