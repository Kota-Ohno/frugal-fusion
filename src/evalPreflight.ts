import {
  estimateTokens,
  plannedCallsForMode,
  requestInput,
} from "./callPlanning.js";
import type { FrugalFusionConfig } from "./config.js";
import type {
  EvalCase,
  EvalCaseSetManifestBinding,
  EvalCaseValidationSummary,
  EvalClaimGateAssessment,
} from "./evaluation.js";
import type { ModelRegistry } from "./modelRegistry.js";
import type { DeliberationMode } from "./types.js";

export type EvalPreflightGuardOptions = {
  maxPlannedCallAttempts?: number;
  maxPlannedCompletionCostUsd?: number;
};

export type EvalPreflightPlan = {
  schemaVersion: "frugal-fusion-eval-preflight-v1";
  scope: "local_no_spend_eval_preflight";
  privacy: {
    classification: "private_local_aggregate_only";
    omitted: [
      "case_ids",
      "category_labels",
      "task_text",
      "case_set_hashes",
      "manifest_digests",
      "manifest_paths",
      "model_ids",
      "price_rows",
    ];
  };
  configs: DeliberationMode[];
  evaluationDesign: {
    schedule: "case-trial-rotation-v1";
    caseCount: number;
    scoredCaseCount: number;
    smokeOnlyCaseCount: number;
    trialsPerCase: number;
    caseTrialCount: number;
    configCaseTrialCount: number;
  };
  plannedCallAttempts: {
    maximumIfPrerequisitesSucceed: number;
    byConfig: Record<DeliberationMode, number>;
    byStage: Record<string, number>;
    disclosure: "maximum_planned_attempts_not_guaranteed_billed_calls";
  };
  completionTokenCeiling: {
    maxTokensPerCaseTrialByConfig: Record<DeliberationMode, number>;
    totalMaxTokensByConfig: Record<DeliberationMode, number>;
    totalMaxTokens: number;
  };
  cost: {
    currency: "USD";
    configuredPerRequestBudgetUsd: number;
    configuredRunBudgetCeilingUsd: number;
    completionCostUpperBoundUsd: number;
    knownInitialPromptCostEstimateUsd: number;
    estimatedKnownInitialPromptPlusCompletionUsd: number;
    byConfig: Record<
      DeliberationMode,
      {
        configuredBudgetCeilingUsd: number;
        completionCostUpperBoundUsd: number;
        knownInitialPromptCostEstimateUsd: number;
        estimatedKnownInitialPromptPlusCompletionUsd: number;
      }
    >;
    promptEstimate: {
      method: "ceil_characters_div_4";
      scope: "known_initial_request_prompts_only";
      unestimatedPromptCosts: "self_review_final_and_aggregator_prompts_depend_on_generated_outputs";
      authoritativeCostSource: "post_call_provider_usage_validated_against_price_snapshot";
    };
  };
  modelPriceSnapshot: {
    source: "models_file";
    effectiveModelCount: number;
    freshnessChecked: true;
    modelIdentifierDisclosure: "omitted";
    priceRowDisclosure: "omitted";
  };
  caseSetManifestBinding: null | {
    status: "verified";
    intendedUse: EvalCaseSetManifestBinding["intendedUse"];
    hashAlgorithm: EvalCaseSetManifestBinding["hashAlgorithm"];
    privacyClass: EvalCaseSetManifestBinding["privacyClass"];
    digestDisclosure: "omitted";
  };
  caseSetClaimGate: null | {
    status: EvalClaimGateAssessment["status"];
    overallClaimStatus: EvalClaimGateAssessment["overallClaimStatus"];
    blockerCodes: string[];
    warningCodes: string[];
  };
  guards: {
    status: "passed";
    maxPlannedCallAttempts: number | null;
    maxPlannedCompletionCostUsd: number | null;
  };
  warnings: Array<{ code: string; message: string }>;
};

type BuildEvalPreflightPlanInput = {
  cases: EvalCase[];
  summary: EvalCaseValidationSummary;
  config: FrugalFusionConfig;
  registry: ModelRegistry;
  configs: DeliberationMode[];
  trialsPerCase: number;
  caseSetManifestBinding?: EvalCaseSetManifestBinding;
  caseSetClaimGate?: EvalClaimGateAssessment;
  guards?: EvalPreflightGuardOptions;
};

export function buildEvalPreflightPlan(
  input: BuildEvalPreflightPlanInput,
): EvalPreflightPlan {
  const caseTrialCount = input.cases.length * input.trialsPerCase;
  const configCaseTrialCount = caseTrialCount * input.configs.length;
  const byConfigAttempts = emptyNumberRecord(input.configs);
  const maxTokensPerCaseTrialByConfig = emptyNumberRecord(input.configs);
  const totalMaxTokensByConfig = emptyNumberRecord(input.configs);
  const completionCostByConfig = emptyNumberRecord(input.configs);
  const knownInitialPromptCostByConfig = emptyNumberRecord(input.configs);
  const byStage: Record<string, number> = {};
  const effectiveModelIds = new Set<string>();

  for (const config of input.configs) {
    const shapes = plannedCallsForMode(
      config,
      input.config.models,
      input.config.budget,
    );
    byConfigAttempts[config] = shapes.length * caseTrialCount;
    maxTokensPerCaseTrialByConfig[config] = shapes.reduce(
      (sum, shape) => sum + shape.maxOutputTokens,
      0,
    );
    totalMaxTokensByConfig[config] =
      maxTokensPerCaseTrialByConfig[config] * caseTrialCount;
    completionCostByConfig[config] = roundUsd(
      shapes.reduce(
        (sum, shape) =>
          sum +
          input.registry.costFor(shape.modelId, 0, shape.maxOutputTokens) *
            caseTrialCount,
        0,
      ),
    );

    for (const shape of shapes) {
      effectiveModelIds.add(shape.modelId);
      byStage[shape.stage] = (byStage[shape.stage] ?? 0) + caseTrialCount;
      if (shape.promptCostEstimateScope === "known_initial_request") {
        knownInitialPromptCostByConfig[config] += knownInitialPromptCost(
          input.cases,
          input.trialsPerCase,
          config,
          shape.modelId,
          input.registry,
          input.config.budget,
        );
      }
    }
    knownInitialPromptCostByConfig[config] = roundUsd(
      knownInitialPromptCostByConfig[config],
    );
  }

  const completionCostUpperBoundUsd = roundUsd(
    sumRecord(completionCostByConfig),
  );
  const knownInitialPromptCostEstimateUsd = roundUsd(
    sumRecord(knownInitialPromptCostByConfig),
  );
  const plannedCallAttempts = sumRecord(byConfigAttempts);
  const plan: EvalPreflightPlan = {
    schemaVersion: "frugal-fusion-eval-preflight-v1",
    scope: "local_no_spend_eval_preflight",
    privacy: {
      classification: "private_local_aggregate_only",
      omitted: [
        "case_ids",
        "category_labels",
        "task_text",
        "case_set_hashes",
        "manifest_digests",
        "manifest_paths",
        "model_ids",
        "price_rows",
      ],
    },
    configs: input.configs,
    evaluationDesign: {
      schedule: "case-trial-rotation-v1",
      caseCount: input.summary.caseCount,
      scoredCaseCount: input.summary.scoredCaseCount,
      smokeOnlyCaseCount: input.summary.smokeOnlyCaseCount,
      trialsPerCase: input.trialsPerCase,
      caseTrialCount,
      configCaseTrialCount,
    },
    plannedCallAttempts: {
      maximumIfPrerequisitesSucceed: plannedCallAttempts,
      byConfig: byConfigAttempts,
      byStage,
      disclosure: "maximum_planned_attempts_not_guaranteed_billed_calls",
    },
    completionTokenCeiling: {
      maxTokensPerCaseTrialByConfig,
      totalMaxTokensByConfig,
      totalMaxTokens: sumRecord(totalMaxTokensByConfig),
    },
    cost: {
      currency: "USD",
      configuredPerRequestBudgetUsd: roundUsd(input.config.budget.maxCostUsd),
      configuredRunBudgetCeilingUsd: roundUsd(
        input.config.budget.maxCostUsd * configCaseTrialCount,
      ),
      completionCostUpperBoundUsd,
      knownInitialPromptCostEstimateUsd,
      estimatedKnownInitialPromptPlusCompletionUsd: roundUsd(
        knownInitialPromptCostEstimateUsd + completionCostUpperBoundUsd,
      ),
      byConfig: Object.fromEntries(
        input.configs.map((config) => [
          config,
          {
            configuredBudgetCeilingUsd: roundUsd(
              input.config.budget.maxCostUsd * caseTrialCount,
            ),
            completionCostUpperBoundUsd: completionCostByConfig[config],
            knownInitialPromptCostEstimateUsd:
              knownInitialPromptCostByConfig[config],
            estimatedKnownInitialPromptPlusCompletionUsd: roundUsd(
              completionCostByConfig[config] +
                knownInitialPromptCostByConfig[config],
            ),
          },
        ]),
      ) as EvalPreflightPlan["cost"]["byConfig"],
      promptEstimate: {
        method: "ceil_characters_div_4",
        scope: "known_initial_request_prompts_only",
        unestimatedPromptCosts:
          "self_review_final_and_aggregator_prompts_depend_on_generated_outputs",
        authoritativeCostSource:
          "post_call_provider_usage_validated_against_price_snapshot",
      },
    },
    modelPriceSnapshot: {
      source: "models_file",
      effectiveModelCount: effectiveModelIds.size,
      freshnessChecked: true,
      modelIdentifierDisclosure: "omitted",
      priceRowDisclosure: "omitted",
    },
    caseSetManifestBinding: input.caseSetManifestBinding
      ? {
          status: "verified",
          intendedUse: input.caseSetManifestBinding.intendedUse,
          hashAlgorithm: input.caseSetManifestBinding.hashAlgorithm,
          privacyClass: input.caseSetManifestBinding.privacyClass,
          digestDisclosure: "omitted",
        }
      : null,
    caseSetClaimGate: input.caseSetClaimGate
      ? {
          status: input.caseSetClaimGate.status,
          overallClaimStatus: input.caseSetClaimGate.overallClaimStatus,
          blockerCodes: input.caseSetClaimGate.blockers.map(
            (blocker) => blocker.code,
          ),
          warningCodes: input.caseSetClaimGate.warnings.map(
            (warning) => warning.code,
          ),
        }
      : null,
    guards: {
      status: "passed",
      maxPlannedCallAttempts: input.guards?.maxPlannedCallAttempts ?? null,
      maxPlannedCompletionCostUsd:
        input.guards?.maxPlannedCompletionCostUsd ?? null,
    },
    warnings: [
      {
        code: "no_spend_preflight_only",
        message:
          "This preflight plan does not call models and does not prove provider billing, model availability, or output quality.",
      },
      {
        code: "prompt_cost_is_partial_estimate",
        message:
          "Prompt cost includes only known initial request prompts; self-review final and aggregator prompts depend on generated outputs.",
      },
      {
        code: "completion_cost_uses_snapshot_prices",
        message:
          "Completion cost upper bound is derived from configured max output tokens and the loaded price snapshot; post-call validated usage remains authoritative.",
      },
      {
        code: "configured_budget_ceiling_is_not_a_spend_prediction",
        message:
          "The configured run budget ceiling multiplies the per-request budget by case-trials and configs; it is a safety envelope, not an estimate.",
      },
    ],
  };

  assertPreflightGuards(plan, input.guards);
  return plan;
}

function knownInitialPromptCost(
  cases: EvalCase[],
  trialsPerCase: number,
  mode: DeliberationMode,
  modelId: string,
  registry: ModelRegistry,
  budget: FrugalFusionConfig["budget"],
): number {
  let total = 0;
  for (const evalCase of cases) {
    const text = requestInput({
      task: evalCase.task,
      mode,
      verification: "none",
      budget,
      ...(evalCase.constraints ? { constraints: evalCase.constraints } : {}),
    });
    total += registry.costFor(modelId, estimateTokens(text), 0) * trialsPerCase;
  }
  return total;
}

function assertPreflightGuards(
  plan: EvalPreflightPlan,
  guards: EvalPreflightGuardOptions | undefined,
): void {
  if (
    guards?.maxPlannedCallAttempts !== undefined &&
    plan.plannedCallAttempts.maximumIfPrerequisitesSucceed >
      guards.maxPlannedCallAttempts
  ) {
    throw new Error(
      `Preflight guard failed: planned call attempts ${plan.plannedCallAttempts.maximumIfPrerequisitesSucceed} > ${guards.maxPlannedCallAttempts}`,
    );
  }
  if (
    guards?.maxPlannedCompletionCostUsd !== undefined &&
    plan.cost.completionCostUpperBoundUsd > guards.maxPlannedCompletionCostUsd
  ) {
    throw new Error(
      `Preflight guard failed: planned completion cost $${plan.cost.completionCostUpperBoundUsd.toFixed(6)} > $${guards.maxPlannedCompletionCostUsd.toFixed(6)}`,
    );
  }
}

function emptyNumberRecord(
  configs: DeliberationMode[],
): Record<DeliberationMode, number> {
  return Object.fromEntries(configs.map((config) => [config, 0])) as Record<
    DeliberationMode,
    number
  >;
}

function sumRecord(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + value, 0);
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}
