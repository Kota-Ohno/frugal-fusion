import { BudgetExceededError } from "./errors.js";
import { plannedCallsForMode } from "./callPlanning.js";
import type {
  AutoRoutingMetadata,
  Budget,
  DeliberationMode,
  ModelRoleConfig,
  PriceSnapshotEntry,
} from "./types.js";

const LADDER: ReadonlyArray<DeliberationMode> = [
  "fusion",
  "repeated",
  "self_review",
  "direct",
];

/**
 * Selects the richest DeliberationMode whose pre-spend worst-case cost estimate
 * fits within budget.maxCostUsd. Pure function — no model calls, no I/O.
 *
 * Pre-spend estimate:
 *   completionCost = Σ (call.maxOutputTokens × completionPriceUsdPerToken) for all planned calls
 *   promptCost     = Σ (knownInitialPromptTokens × promptPriceUsdPerToken)
 *                    only for calls with promptCostEstimateScope "known_initial_request"
 *
 * Calls scoped "depends_on_generated_output" are excluded from the prompt cost estimate
 * because the prompt size is unknowable before the previous call's output is produced.
 *
 * A mode is ineligible if plannedCallsForMode throws BudgetExceededError (insufficient
 * candidate/repair budget) or if any involved model's price is missing from priceByModel.
 *
 * Falls back to "direct" if no mode fits or prices are unavailable.
 */
export function selectAutoMode(
  models: ModelRoleConfig,
  budget: Budget,
  priceByModel: ReadonlyMap<string, PriceSnapshotEntry>,
  knownInitialPromptTokens: number,
): { mode: DeliberationMode; metadata: AutoRoutingMetadata } {
  let hadMissingPrices = false;

  for (const mode of LADDER) {
    let calls: ReturnType<typeof plannedCallsForMode>;
    try {
      calls = plannedCallsForMode(mode, models, budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) continue;
      throw err;
    }

    const uniqueModelIds = [...new Set(calls.map((c) => c.modelId))];
    if (uniqueModelIds.some((id) => !priceByModel.has(id))) {
      hadMissingPrices = true;
      continue;
    }

    let completionCost = 0;
    let promptCost = 0;
    for (const call of calls) {
      const entry = priceByModel.get(call.modelId) as PriceSnapshotEntry;
      completionCost += call.maxOutputTokens * entry.completionPriceUsdPerToken;
      if (call.promptCostEstimateScope === "known_initial_request") {
        promptCost += knownInitialPromptTokens * entry.promptPriceUsdPerToken;
      }
    }
    const totalEstimate = completionCost + promptCost;

    if (totalEstimate <= budget.maxCostUsd) {
      return {
        mode,
        metadata: {
          requestedMode: "auto",
          selectedMode: mode,
          strategy: "budget_aware_v1",
          reason: "selected_richest_within_budget",
          budgetCeilingUsd: budget.maxCostUsd,
          selectedModeEstimatedCostUsd: totalEstimate,
        },
      };
    }
  }

  return {
    mode: "direct",
    metadata: {
      requestedMode: "auto",
      selectedMode: "direct",
      strategy: "budget_aware_v1",
      reason: hadMissingPrices
        ? "estimate_unavailable_defaulted_to_direct"
        : "fell_back_to_direct_over_budget",
      budgetCeilingUsd: budget.maxCostUsd,
      selectedModeEstimatedCostUsd: 0,
    },
  };
}
