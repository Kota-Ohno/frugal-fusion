import { BudgetExceededError } from "./errors.js";
import type {
  Budget,
  DeliberationMode,
  DeliberationRequest,
  ModelRoleConfig,
} from "./types.js";

export type DeliberationCallStage =
  | "direct"
  | "self_review_draft"
  | "self_review_final"
  | "repeated_sample"
  | "candidate"
  | "aggregator";

export type DeliberationCallShape = {
  stage: DeliberationCallStage;
  modelId: string;
  maxOutputTokens: number;
  promptCostEstimateScope:
    | "known_initial_request"
    | "depends_on_generated_output";
};

export function plannedCallsForMode(
  mode: DeliberationMode,
  models: ModelRoleConfig,
  budget: Budget,
): DeliberationCallShape[] {
  if (mode === "direct") {
    return [
      {
        stage: "direct",
        modelId: models.directModelId,
        maxOutputTokens: budget.maxCompletionTokens,
        promptCostEstimateScope: "known_initial_request",
      },
    ];
  }
  if (mode === "self_review") {
    if (budget.maxRepairRounds < 1) {
      throw new BudgetExceededError(
        "self_review requires maxRepairRounds of at least 1",
      );
    }
    const [draftTokens, reviewTokens] = splitTokens2(
      budget.maxCompletionTokens,
      [0.6, 0.4],
    );
    return [
      {
        stage: "self_review_draft",
        modelId: models.directModelId,
        maxOutputTokens: draftTokens,
        promptCostEstimateScope: "known_initial_request",
      },
      {
        stage: "self_review_final",
        modelId: models.selfReviewModelId,
        maxOutputTokens: reviewTokens,
        promptCostEstimateScope: "depends_on_generated_output",
      },
    ];
  }
  if (mode === "repeated") {
    requireCandidateBudget(budget, 2, "Repeated sampling");
    const [sampleTokensA, sampleTokensB, aggregatorTokens] = splitTokens3(
      budget.maxCompletionTokens,
      [0.38, 0.38, 0.24],
    );
    return [
      {
        stage: "repeated_sample",
        modelId: models.repeatedModelId,
        maxOutputTokens: sampleTokensA,
        promptCostEstimateScope: "known_initial_request",
      },
      {
        stage: "repeated_sample",
        modelId: models.repeatedModelId,
        maxOutputTokens: sampleTokensB,
        promptCostEstimateScope: "known_initial_request",
      },
      {
        stage: "aggregator",
        modelId: models.aggregatorModelId,
        maxOutputTokens: aggregatorTokens,
        promptCostEstimateScope: "depends_on_generated_output",
      },
    ];
  }

  requireCandidateBudget(budget, 2, "Fusion");
  const [candidateTokensA, candidateTokensB, aggregatorTokens] = splitTokens3(
    budget.maxCompletionTokens,
    [0.38, 0.38, 0.24],
  );
  const [modelA, modelB] = models.candidateModels;
  return [
    {
      stage: "candidate",
      modelId: modelA,
      maxOutputTokens: candidateTokensA,
      promptCostEstimateScope: "known_initial_request",
    },
    {
      stage: "candidate",
      modelId: modelB,
      maxOutputTokens: candidateTokensB,
      promptCostEstimateScope: "known_initial_request",
    },
    {
      stage: "aggregator",
      modelId: models.aggregatorModelId,
      maxOutputTokens: aggregatorTokens,
      promptCostEstimateScope: "depends_on_generated_output",
    },
  ];
}

export function modelIdsForMode(
  mode: DeliberationMode,
  models: ModelRoleConfig,
): string[] {
  return plannedCallsForMode(mode, models, {
    maxCostUsd: 1,
    maxLatencyMs: 1,
    maxCandidates: 2,
    maxCompletionTokens: 3,
    maxRepairRounds: 1,
  }).map((plan) => plan.modelId);
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function requestInputObject(request: DeliberationRequest): {
  task: string;
  constraints: string[];
  verification: "none" | "schema" | "code" | "source" | "math";
} {
  return {
    task: request.task,
    constraints: request.constraints ?? [],
    verification: request.verification ?? "none",
  };
}

export function requestInput(request: DeliberationRequest): string {
  return JSON.stringify(requestInputObject(request));
}

function requireCandidateBudget(
  budget: Budget,
  required: number,
  label: string,
): void {
  if (budget.maxCandidates < required) {
    throw new BudgetExceededError(
      `${label} requires a budget for ${required} candidates`,
    );
  }
}

function splitTokens2(
  total: number,
  weights: [number, number],
): [number, number] {
  const values = splitTokens(total, weights);
  return [values[0] ?? 1, values[1] ?? 1];
}

function splitTokens3(
  total: number,
  weights: [number, number, number],
): [number, number, number] {
  const values = splitTokens(total, weights);
  return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
}

function splitTokens(total: number, weights: number[]): number[] {
  if (total < weights.length) {
    throw new BudgetExceededError(
      `Completion token budget ${total} cannot fund ${weights.length} planned calls`,
    );
  }
  const raw = weights.map((weight) => Math.max(1, Math.floor(total * weight)));
  const used = raw.reduce((sum, value) => sum + value, 0);
  raw[raw.length - 1] = (raw[raw.length - 1] ?? 1) + total - used;
  return raw;
}
