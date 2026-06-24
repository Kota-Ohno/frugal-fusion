import type {
  ConfidenceInterval,
  EvalConfigOutcome,
  EvalClaimGateAssessment,
  EvalReport,
  EvalCaseSetManifestBinding,
  GraderEvidenceTier,
  GraderEvidenceTierCounts,
  GraderResult,
  PositionCounts,
} from "./evaluation.js";
import {
  emptyGraderEvidenceTierCounts,
  GRADER_EVIDENCE_TIERS,
  GRADER_EVIDENCE_TIER_VERSION,
  passRateDeltaVsDirectBootstrapIntervals,
  taskPassRateBootstrapIntervals,
} from "./evaluation.js";
import type { ProviderEndpointPinningStatus } from "./runProvenance.js";
import type { DeliberationMode, ModelStatus } from "./types.js";

export const PUBLIC_EVAL_REPORT_SCHEMA_VERSION =
  "frugal-fusion-public-eval-v11" as const;
export const PUBLIC_REPORT_VERIFICATION_SCHEMA_VERSION =
  "frugal-fusion-public-report-verification-v1" as const;

export type PublicEvalReport = {
  schemaVersion: typeof PUBLIC_EVAL_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  disclosure: {
    modelDisclosure: "redacted";
    priceDisclosure: "redacted";
    promptDisclosure: "redacted";
    caseIdentity: "generated-row-labels";
    traceDisclosure: "omitted";
    reproducibilityLevel: "private-audit-only";
    caseSetManifestBinding: PublicCaseSetManifestBindingDisclosure;
    caseSetClaimGate: PublicCaseSetClaimGateDisclosure;
    runProvenance: PublicRunProvenanceDisclosure;
    notes: string[];
  };
  evaluationDesign: EvalReport["evaluationDesign"];
  configs: DeliberationMode[];
  claimReadiness: {
    status: "not_benchmark";
    warnings: string[];
  };
  claimGate: PublicReportClaimGateAssessment;
  metrics: PublicEvalMetrics;
  cases: PublicEvalCase[];
};

export type PublicEvalMetrics = {
  n: number;
  scored_n: number;
  trials_per_case: number;
  scored_trial_n: number;
  scored_attempt_n: Record<DeliberationMode, number>;
  scored_attempt_coverage: Record<
    DeliberationMode,
    PublicScoredAttemptCoverage
  >;
  task_pass_rate: Record<DeliberationMode, number | null>;
  fusion_harm_rate: number | null;
  paired_vs_direct: Record<DeliberationMode, PublicPairedComparison>;
  position_counts: Record<DeliberationMode, PositionCounts>;
  confidence_intervals: {
    method: EvalReport["metrics"]["confidence_intervals"]["method"] | null;
    level: EvalReport["metrics"]["confidence_intervals"]["level"] | null;
    resamples: number | null;
    warnings: string[];
    task_pass_rate: EvalReport["metrics"]["confidence_intervals"]["task_pass_rate"];
    pass_rate_delta_vs_direct: EvalReport["metrics"]["confidence_intervals"]["pass_rate_delta_vs_direct"];
  };
  grader_evidence: PublicGraderEvidenceSummary;
  by_category: PublicCategoryBreakdown;
  failure_rates: {
    invalid_output_rate: Record<DeliberationMode, number>;
    timeout_rate: Record<DeliberationMode, number>;
    provider_error_rate: Record<DeliberationMode, number>;
    budget_exhaustion_rate: Record<DeliberationMode, number>;
    partial_failure_rate: Record<DeliberationMode, number>;
    verification_failure_rate: Record<DeliberationMode, number>;
    smoke_completion_rate: Record<DeliberationMode, number>;
  };
  cost_latency:
    | {
        available: true;
        precision: {
          costUsdDecimals: number;
          latencyMsBucket: number;
        };
        cost_per_pass_usd: Record<DeliberationMode, number | null>;
        cost_per_pass_interval_usd: Record<
          DeliberationMode,
          PublicCostPerPassInterval
        >;
        mean_cost_per_scored_attempt_usd: Record<
          DeliberationMode,
          number | null
        >;
        total_cost_usd: Record<DeliberationMode, number>;
        p50_latency_ms: Record<DeliberationMode, number>;
        p95_latency_ms: Record<DeliberationMode, number>;
      }
    | {
        available: false;
        suppressedReason: "small_scored_case_count";
        minimumScoredCases: number;
      };
};

export type PublicPairedComparison = {
  paired_n: number;
  unpaired_n: number;
  wins: number;
  losses: number;
  ties: number;
  pass_rate_delta: number | null;
  harm_rate: number | null;
};

export type PublicScoredAttemptCoverage = {
  expected_scored_case_trial_n: number;
  observed_scored_attempt_n: number;
  incomplete_scored_case_trial_n: number;
  complete: boolean;
};

export type PublicCostPerPassInterval = {
  low: number | null;
  high: number | null;
  available: boolean;
  undefinedRate: number;
};

export type PublicReportClaimGateTarget = "public_cost_performance";

export type PublicReportClaimGateEvidenceValue =
  | number
  | boolean
  | null
  | DeliberationMode
  | PublicCaseSetManifestBindingDisclosure["status"]
  | Extract<
      PublicCaseSetManifestBindingDisclosure,
      { status: "private_report_bound" }
    >["intendedUse"]
  | Extract<
      PublicCaseSetManifestBindingDisclosure,
      { status: "private_report_bound" }
    >["hashAlgorithm"]
  | Extract<
      PublicCaseSetManifestBindingDisclosure,
      { status: "private_report_bound" }
    >["privacyClass"]
  | PublicCategoryBreakdown["categoryIdentity"]
  | Extract<PublicCategoryBreakdown, { available: false }>["suppressedReason"]
  | Extract<
      PublicEvalMetrics["cost_latency"],
      { available: false }
    >["suppressedReason"]
  | PublicReportDirectionalComparison["status"]
  | PublicEvalReport["disclosure"]["reproducibilityLevel"]
  | PublicRunProvenanceDisclosure["status"]
  | PublicCaseSetClaimGateDisclosure["status"]
  | Extract<
      PublicRunProvenanceDisclosure,
      { status: "private_report_fields_present" }
    >["config"]["status"]
  | Extract<
      PublicRunProvenanceDisclosure,
      { status: "private_report_fields_present" }
    >["modelPriceSnapshot"]["status"]
  | Extract<
      PublicRunProvenanceDisclosure,
      { status: "private_report_fields_present" }
    >["openRouterRequestPolicy"]["status"]
  | Extract<
      PublicRunProvenanceDisclosure,
      { status: "private_report_fields_present" }
    >["providerRouting"]["status"]
  | ProviderEndpointPinningStatus;

export type PublicReportClaimGateEvidenceKey =
  | "requiredConfig"
  | "scoredCaseCount"
  | "requiredScoredCases"
  | "categoryBreakdownAvailable"
  | "suppressedReason"
  | "requiredScoredCasesPerCategory"
  | "categoryCount"
  | "underpoweredCategoryCount"
  | "inconsistentCategoryCount"
  | "minScoredCasesPerCategory"
  | "scoredTrialCount"
  | "scoredAttemptCount"
  | "incompleteScoredCaseTrialCount"
  | "pairedCaseTrialCount"
  | "unpairedCaseTrialCount"
  | "minimumScoredCases"
  | "config"
  | "surfaceTextCaseCount"
  | "mixedCaseCount"
  | "structuredOrExactCaseCount"
  | "nonSurfaceGraderEvidenceCaseCount"
  | "requiredNonSurfaceGraderEvidenceCases"
  | "affectedCategoryCount"
  | "minNonSurfaceGraderEvidenceCasesPerCategory"
  | "requiredNonSurfaceGraderEvidenceCasesPerCategory"
  | "fusionHarmRate"
  | "directMaxRuntimeFailureRate"
  | "fusionMaxRuntimeFailureRate"
  | "directPartialFailureRate"
  | "fusionPartialFailureRate"
  | "warningCount"
  | "reproducibilityLevel"
  | "directionalComparison"
  | "caseSetManifestBindingStatus"
  | "caseSetClaimGateStatus"
  | "manifestIntendedUse"
  | "manifestHashAlgorithm"
  | "manifestPrivacyClass"
  | "runProvenanceStatus"
  | "publicReportSchemaVersionKnown"
  | "configProvenanceStatus"
  | "modelPriceProvenanceStatus"
  | "openRouterRequestPolicyStatus"
  | "providerRoutingStatus"
  | "providerEndpointPinning"
  | "runProvenanceEvaluatedConfigCount"
  | "publicReportConfigCount"
  | "requiredConfigCount"
  | "modelDisclosureRedacted"
  | "priceDisclosureRedacted"
  | "promptDisclosureRedacted"
  | "publicDisclosureRootShapeStrict"
  | "caseIdentityGeneratedRowLabels"
  | "traceDisclosureOmitted"
  | "reproducibilityPrivateAuditOnly"
  | "caseManifestDigestOmitted"
  | "caseManifestNotProvidedShapeStrict"
  | "caseSetManifestBindingPresentShapeStrict"
  | "caseManifestSchemaVersionKnown"
  | "caseManifestFingerprintVersionKnown"
  | "caseManifestCanonicalizationKnown"
  | "caseManifestContentKnown"
  | "caseSetClaimGateNotProvidedShapeStrict"
  | "caseSetClaimGatePresentShapeStrict"
  | "caseSetClaimGateDetailOmitted"
  | "runProvenanceNotProvidedShapeStrict"
  | "runProvenancePresentShapeStrict"
  | "runProvenanceSchemaVersionKnown"
  | "runProvenanceFingerprintVersionKnown"
  | "runProvenanceCanonicalizationKnown"
  | "runConfigPresentShapeStrict"
  | "runConfigContentKnown"
  | "runConfigDigestOmitted"
  | "runConfigPathOmitted"
  | "runModelPricePresentShapeStrict"
  | "runModelPriceContentKnown"
  | "runModelPriceDigestOmitted"
  | "runModelPricePathOmitted"
  | "openRouterRequestPolicyDigestOmitted"
  | "openRouterRequestPolicyContentKnown"
  | "openRouterRequestPolicyNotProvidedShapeStrict"
  | "openRouterRequestPolicyPresentShapeStrict"
  | "providerRoutingDetailOmitted"
  | "providerRoutingContentKnown"
  | "providerRoutingNotProvidedShapeStrict"
  | "providerRoutingPresentShapeStrict"
  | "publicConfigsArray"
  | "publicConfigsRecognized"
  | "publicConfigsDistinct"
  | "publicConfigCount"
  | "confidenceIntervalMethodCaseClusterBootstrap"
  | "confidenceIntervalLevel95"
  | "confidenceIntervalResamplesPositiveInteger"
  | "confidenceIntervalResamplesAtLeastMinimum"
  | "confidenceIntervalResampleCount"
  | "minimumConfidenceIntervalResamples";

export type PublicReportClaimGateFinding = {
  code: string;
  message: string;
  evidence?: Partial<
    Record<PublicReportClaimGateEvidenceKey, PublicReportClaimGateEvidenceValue>
  >;
};

export type PublicReportClaimGateExternalEvidence = {
  code: string;
  message: string;
};

export type PublicReportDirectionalComparison = {
  status:
    | "fusion_directionally_better"
    | "direct_directionally_better"
    | "no_clear_difference"
    | "indeterminate";
  basis: "fusion_pass_rate_delta_ci" | "missing_or_unavailable_interval";
  passRateDeltaVsDirect: ConfidenceInterval | null;
  notes: string[];
};

export type PublicReportClaimGateAssessment = {
  target: PublicReportClaimGateTarget;
  scope: "public_projection_with_private_attestations";
  status: "public_report_blocked" | "public_report_constraints_met";
  overallClaimStatus: "external_evidence_required";
  minimums: {
    scoredCases: number;
    scoredCasesPerCategory: number;
    nonSurfaceGraderEvidenceCases: number;
    nonSurfaceGraderEvidenceCasesPerCategory: number;
  };
  directionalComparison: PublicReportDirectionalComparison;
  blockers: PublicReportClaimGateFinding[];
  warnings: PublicReportClaimGateFinding[];
  externalEvidenceRequired: PublicReportClaimGateExternalEvidence[];
};

export type PublicReportClaimGateInput = Pick<
  PublicEvalReport,
  "schemaVersion" | "configs" | "disclosure" | "metrics"
>;

export type PublicReportVerificationEvidenceValue =
  | PublicReportClaimGateEvidenceValue
  | PublicReportClaimGateAssessment["status"];

export type PublicReportVerificationFinding = {
  code: string;
  message: string;
  evidence?: Record<string, PublicReportVerificationEvidenceValue>;
};

export type PublicEvalReportVerification = {
  schemaVersion: typeof PUBLIC_REPORT_VERIFICATION_SCHEMA_VERSION;
  target: "public_eval_report";
  status: "public_report_verified" | "public_report_blocked";
  overallClaimStatus: "external_evidence_required";
  artifact: {
    rootObject: boolean;
    rootShapeStrict: boolean;
    publicFieldsShapeStrict: boolean;
    claimGateInputShapeStrict: boolean;
    claimGateInputAvailable: boolean;
    embeddedClaimGatePresent: boolean;
    embeddedClaimGateMatchesRecomputed: boolean;
  };
  claimGate: PublicReportClaimGateAssessment | null;
  blockers: PublicReportVerificationFinding[];
  warnings: PublicReportVerificationFinding[];
};

export type PublicCaseSetManifestBindingDisclosure =
  | {
      status: "not_provided";
    }
  | {
      status: "private_report_bound";
      schemaVersion: EvalCaseSetManifestBinding["schemaVersion"];
      fingerprintVersion: EvalCaseSetManifestBinding["fingerprintVersion"];
      canonicalization: EvalCaseSetManifestBinding["canonicalization"];
      content: EvalCaseSetManifestBinding["content"];
      intendedUse: EvalCaseSetManifestBinding["intendedUse"];
      hashAlgorithm: EvalCaseSetManifestBinding["hashAlgorithm"];
      privacyClass: EvalCaseSetManifestBinding["privacyClass"];
      digestDisclosure: "omitted";
    };

export type PublicCaseSetClaimGateDisclosure =
  | {
      status: "not_provided";
    }
  | {
      status: "private_report_constraints_met" | "private_report_blocked";
      target: EvalClaimGateAssessment["target"];
      scope: EvalClaimGateAssessment["scope"];
      overallClaimStatus: EvalClaimGateAssessment["overallClaimStatus"];
      detailDisclosure: "omitted";
    };

export type PublicRunProvenanceDisclosure =
  | {
      status: "not_provided";
    }
  | {
      status: "private_report_fields_present";
      schemaVersion: "frugal-fusion-run-provenance-v2";
      fingerprintVersion: "run-provenance-v2";
      canonicalization: "json-sorted-v1";
      evaluatedConfigCount: number;
      config: {
        status: "private_report_fields_present";
        content: "resolved-frugal-fusion-config-v2";
        digestDisclosure: "omitted";
        pathDisclosure: "omitted";
      };
      modelPriceSnapshot: {
        status: "private_report_fields_present";
        content: "effective-model-price-snapshot-v1";
        digestDisclosure: "omitted";
        pathDisclosure: "omitted";
      };
      openRouterRequestPolicy: PublicOpenRouterRequestPolicyDisclosure;
      providerRouting: PublicProviderRoutingDisclosure;
    };

export type PublicOpenRouterRequestPolicyDisclosure =
  | {
      status: "not_provided";
    }
  | {
      status: "private_report_fields_present";
      content: "openrouter-fixed-baseline-request-policy-v1";
      digestDisclosure: "omitted";
    };

export type PublicProviderRoutingDisclosure =
  | {
      status: "not_provided";
    }
  | {
      status: "private_report_fields_present";
      content: "openrouter-provider-routing-policy-v1";
      providerEndpointPinning: ProviderEndpointPinningStatus;
      detailDisclosure: "omitted";
    };

export type PublicGraderEvidenceSummary = {
  version: typeof GRADER_EVIDENCE_TIER_VERSION;
  tier_counts: GraderEvidenceTierCounts;
  scored_tier_counts: GraderEvidenceTierCounts;
  smoke_only_case_n: number;
  dominant_tier: GraderEvidenceTier | null;
  dominant_tier_case_share: number | null;
  profile_mix: "single_tier" | "mixed_tiers" | "no_scored_cases";
  small_profile_cell_warning: boolean;
  minimum_profile_cell_size: number;
  notes: string[];
};

export type PublicCategoryBreakdown =
  | {
      available: false;
      suppressedReason:
        | "no_scored_categories"
        | "uncategorized_scored_cases"
        | "small_scored_case_count_per_category";
      minimumScoredCasesPerCategory: number;
      recommendedScoredCasesPerCategoryForClaims: number;
      categoryIdentity: "generated-order-labels-not-anonymous";
    }
  | {
      available: true;
      categoryIdentity: "generated-order-labels-not-anonymous";
      minimumScoredCasesPerCategory: number;
      recommendedScoredCasesPerCategoryForClaims: number;
      confidence_intervals: {
        method: EvalReport["metrics"]["confidence_intervals"]["method"] | null;
        level: EvalReport["metrics"]["confidence_intervals"]["level"] | null;
        resamples: number | null;
        metrics: Array<"task_pass_rate" | "pass_rate_delta_vs_direct">;
        scope: "within_category";
      };
      notes: string[];
      categories: PublicCategoryMetric[];
    };

export type PublicCategoryMetric = {
  publicCategoryId: string;
  scored_case_n: number;
  scored_trial_n: number;
  scored_attempt_n_by_config: Record<DeliberationMode, number>;
  passed_attempt_n_by_config: Record<DeliberationMode, number>;
  passRateDenominator: "scored_attempts";
  task_pass_rate: Record<DeliberationMode, number | null>;
  task_pass_rate_interval: Record<DeliberationMode, ConfidenceInterval | null>;
  pass_rate_delta_interval_vs_direct: Record<
    DeliberationMode,
    ConfidenceInterval | null
  >;
  fusion_harm_rate: number | null;
  pairedDenominator: "case_trials";
  paired_vs_direct: Record<DeliberationMode, PublicPairedComparison>;
  belowRecommendedScoredCases: boolean;
  claimReadiness: "descriptive_only" | "exploratory_underpowered";
  grader_evidence: PublicCategoryGraderEvidence;
  observed_runtime_check_kind_case_counts: Record<string, number>;
};

export type PublicCategoryGraderEvidence = {
  version: typeof GRADER_EVIDENCE_TIER_VERSION;
  tier_counts: GraderEvidenceTierCounts;
  dominant_tier: GraderEvidenceTier | null;
  dominant_tier_case_share: number | null;
  profile_mix: "single_tier" | "mixed_tiers" | "no_scored_cases";
  small_profile_cell_warning: boolean;
  minimum_profile_cell_size: number;
};

export type PublicEvalCase = {
  publicId: string;
  smokeOnly: boolean;
  trials: Array<{
    trialIndex: number;
    fusionHarm: boolean;
    outcomes: PublicEvalOutcome[];
  }>;
};

export type PublicEvalOutcome = {
  configId: DeliberationMode;
  status: "completed" | "failed";
  passed: boolean;
  degraded?: boolean;
  failureStatus?: ModelStatus;
  grader: PublicGraderSummary;
};

export type PublicGraderSummary = {
  passed: boolean;
  smokeOnly: boolean;
  checkCounts: {
    total: number;
    passed: number;
    failed: number;
  };
  checks: Array<{
    checkIndex: number;
    kind: string;
    passed: boolean;
  }>;
};

const MIN_PUBLIC_COST_LATENCY_CASES = 30;
const MIN_PUBLIC_REPORT_CLAIM_SCORED_CASES = 100;
const MIN_PUBLIC_CATEGORY_CASES = 5;
const MIN_PUBLIC_PROFILE_CELL_CASES = 5;
const MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES =
  MIN_PUBLIC_PROFILE_CELL_CASES;
const MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY =
  MIN_PUBLIC_PROFILE_CELL_CASES;
const MIN_PUBLIC_CONFIDENCE_INTERVAL_RESAMPLES = 500;
const RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS = 30;
const COST_DECIMALS = 4;
const LATENCY_BUCKET_MS = 100;
const PUBLIC_CONFIDENCE_INTERVAL_METHOD = "case_cluster_bootstrap";
const PUBLIC_CONFIDENCE_INTERVAL_LEVEL = 0.95;
const PUBLIC_CONFIDENCE_INTERVAL_WARNINGS = [
  "No scored cases; confidence intervals are degenerate.",
  "Fewer than 30 scored cases; bootstrap intervals are exploratory.",
] as const;
const PUBLIC_CONFIGS = new Set<DeliberationMode>([
  "direct",
  "self_review",
  "repeated",
  "fusion",
]);
const PUBLIC_CLAIM_REQUIRED_CONFIGS = [
  "direct",
  "self_review",
  "repeated",
  "fusion",
] as const;
const PUBLIC_EVAL_REPORT_ROOT_KEYS = [
  "schemaVersion",
  "generatedAt",
  "disclosure",
  "evaluationDesign",
  "configs",
  "claimReadiness",
  "claimGate",
  "metrics",
  "cases",
] as const;
const PUBLIC_DISCLOSURE_NOTES = [
  "This public report is an allowlisted projection of a private evaluation report.",
  "Model identities, provider identities, price snapshots, prompts, answers, traces, usage rows, and raw case identifiers are omitted.",
  "Per-case generated row labels preserve report order; when the evaluated case file is public, row-level outcomes can be linked back to that public file.",
  "The private report is required to reproduce model/provider provenance, run-provenance fingerprints, case-manifest binding, and exact cost accounting; no private report hash, case-set digest, config digest, model digest, path, or command is included in this public artifact.",
] as const;
const PUBLIC_CLAIM_READINESS_WARNINGS = [
  "This public report is not evidence that the evaluated case set is a locked holdout or public benchmark.",
  "Interpret pass-rate, harm, and cost metrics together with a separate case-set manifest and private audit evidence.",
  "Category breakdowns are descriptive stratification only; generated category labels are pseudonymous and may be linkable through public case manifests.",
] as const;
const PUBLIC_CATEGORY_BREAKDOWN_NOTES = [
  "Generated category IDs preserve first appearance order and are not anonymous.",
  "Trials are repeated attempts over the same cases; do not interpret trial counts as independent case counts.",
  "Category differences can be confounded by grader mix, difficulty, and prompt tuning.",
  "Grader evidence tiers are heuristic case-definition metadata, not task difficulty or semantic-grading strength.",
  "Rows below the recommended scored-case count are published only as exploratory stratification.",
  "Category-level task pass-rate and pass-rate-delta intervals resample cases within each category; category-level cost intervals are not included in the public projection.",
] as const;
const PUBLIC_GRADER_EVIDENCE_NOTES = [
  "Tiers are derived from configured deterministic grader families before model calls.",
  "They describe mechanical evidence shape, not task difficulty, holdout status, or semantic grading strength.",
] as const;
const PUBLIC_CHECK_KINDS = new Set([
  "exact",
  "exact_normalized",
  "must_include",
  "contains_any",
  "must_not_include",
  "regex",
  "min_length",
  "max_length",
  "choice_valid",
  "choice_expected",
  "json_valid",
  "json_required_path",
  "json_equals",
  "json_includes",
  "json_array_min_length",
  "json_schema_subset",
  "json_check",
  "number_found",
  "number_expected",
  "number_min",
  "number_max",
  "citation_allowed_sources",
  "citation_required_source",
  "citation_min_sources",
  "citation_required_claim",
  "answer_size",
  "grader_configured",
  "smoke_only",
  "run_completed",
  "other_check",
]);

export function buildPublicEvalReport(report: EvalReport): PublicEvalReport {
  const configs = publicConfigs(report.configs);
  const disclosure: PublicEvalReport["disclosure"] = {
    modelDisclosure: "redacted",
    priceDisclosure: "redacted",
    promptDisclosure: "redacted",
    caseIdentity: "generated-row-labels",
    traceDisclosure: "omitted",
    reproducibilityLevel: "private-audit-only",
    caseSetManifestBinding: publicCaseSetManifestBinding(
      report.caseSetManifestBinding,
    ),
    caseSetClaimGate: publicCaseSetClaimGate(report.caseSetClaimGate),
    runProvenance: publicRunProvenance(report.runProvenance),
    notes: [...PUBLIC_DISCLOSURE_NOTES],
  };
  const metrics = publicMetrics(report);
  return {
    schemaVersion: PUBLIC_EVAL_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    disclosure,
    claimReadiness: {
      status: "not_benchmark",
      warnings: [...PUBLIC_CLAIM_READINESS_WARNINGS],
    },
    claimGate: assessPublicReportClaimGate({
      schemaVersion: PUBLIC_EVAL_REPORT_SCHEMA_VERSION,
      configs,
      disclosure,
      metrics,
    }),
    evaluationDesign: {
      trialsPerCase: report.evaluationDesign.trialsPerCase,
      schedule: report.evaluationDesign.schedule,
      bootstrapSamples: report.evaluationDesign.bootstrapSamples,
      confidenceLevel: report.evaluationDesign.confidenceLevel,
    },
    configs,
    metrics,
    cases: report.cases.map((evalCase) => ({
      publicId: `case_${String(evalCase.caseIndex + 1).padStart(4, "0")}`,
      smokeOnly: evalCase.smokeOnly,
      trials: evalCase.trials.map((trial) => ({
        trialIndex: trial.trialIndex,
        fusionHarm: trial.fusionHarm,
        outcomes: trial.outcomes.map(publicOutcome),
      })),
    })),
  };
}

function publicRunProvenance(
  provenance: EvalReport["runProvenance"],
): PublicRunProvenanceDisclosure {
  if (provenance === undefined) return { status: "not_provided" };
  return {
    status: "private_report_fields_present",
    schemaVersion: provenance.schemaVersion,
    fingerprintVersion: provenance.fingerprintVersion,
    canonicalization: provenance.canonicalization,
    evaluatedConfigCount: provenance.evaluatedConfigs.length,
    config: {
      status: "private_report_fields_present",
      content: provenance.config.content,
      digestDisclosure: "omitted",
      pathDisclosure: "omitted",
    },
    modelPriceSnapshot: {
      status: "private_report_fields_present",
      content: provenance.modelPriceSnapshot.content,
      digestDisclosure: "omitted",
      pathDisclosure: "omitted",
    },
    openRouterRequestPolicy: publicOpenRouterRequestPolicy(
      provenance.openRouterRequestPolicy,
    ),
    providerRouting: publicProviderRouting(provenance.providerRouting),
  };
}

function publicOpenRouterRequestPolicy(
  policy: NonNullable<EvalReport["runProvenance"]>["openRouterRequestPolicy"],
): PublicOpenRouterRequestPolicyDisclosure {
  if (policy === undefined) return { status: "not_provided" };
  return {
    status: "private_report_fields_present",
    content: "openrouter-fixed-baseline-request-policy-v1",
    digestDisclosure: "omitted",
  };
}

function publicProviderRouting(
  routing: NonNullable<EvalReport["runProvenance"]>["providerRouting"],
): PublicProviderRoutingDisclosure {
  if (routing === undefined) return { status: "not_provided" };
  return {
    status: "private_report_fields_present",
    content: "openrouter-provider-routing-policy-v1",
    providerEndpointPinning: routing.providerEndpointPinning,
    detailDisclosure: "omitted",
  };
}

function publicCaseSetManifestBinding(
  binding: EvalReport["caseSetManifestBinding"],
): PublicCaseSetManifestBindingDisclosure {
  if (binding === undefined) return { status: "not_provided" };
  return {
    status: "private_report_bound",
    schemaVersion: binding.schemaVersion,
    fingerprintVersion: binding.fingerprintVersion,
    canonicalization: binding.canonicalization,
    content: binding.content,
    intendedUse: binding.intendedUse,
    hashAlgorithm: binding.hashAlgorithm,
    privacyClass: binding.privacyClass,
    digestDisclosure: "omitted",
  };
}

function publicCaseSetClaimGate(
  claimGate: EvalReport["caseSetClaimGate"],
): PublicCaseSetClaimGateDisclosure {
  if (claimGate === undefined) return { status: "not_provided" };
  return {
    status:
      claimGate.status === "case_set_constraints_met"
        ? "private_report_constraints_met"
        : "private_report_blocked",
    target: claimGate.target,
    scope: claimGate.scope,
    overallClaimStatus: claimGate.overallClaimStatus,
    detailDisclosure: "omitted",
  };
}

export function assessPublicReportClaimGate(
  input: PublicReportClaimGateInput,
): PublicReportClaimGateAssessment {
  const blockers: PublicReportClaimGateFinding[] = [];
  const warnings: PublicReportClaimGateFinding[] = [
    {
      code: "public_projection_with_private_attestations",
      message:
        "This gate checks only the public report evidence shape and no-digest private-report disclosures; it cannot independently prove holdout isolation, model provenance, price provenance, or auditor access.",
    },
  ];
  const publicConfigContract = addPublicConfigContractClaimGateFindings(
    input.configs as unknown,
    blockers,
  );
  const safeConfigs = publicConfigContract.safeConfigs;
  const evaluatedConfigs = new Set<DeliberationMode>(safeConfigs);
  const hasDirect = evaluatedConfigs.has("direct");
  const hasFusion = evaluatedConfigs.has("fusion");
  const presentRequiredConfigs = PUBLIC_CLAIM_REQUIRED_CONFIGS.filter(
    (config) => evaluatedConfigs.has(config),
  );
  const disclosureRecord = asPublicRecord(input.disclosure);
  addPublicReportSchemaVersionClaimGateFindings(
    input.schemaVersion as unknown,
    blockers,
  );
  addPublicDisclosureContractClaimGateFindings(input.disclosure, blockers);
  addCaseManifestBindingClaimGateFindings(
    publicDisclosureChild<PublicCaseSetManifestBindingDisclosure>(
      disclosureRecord?.caseSetManifestBinding,
    ),
    blockers,
  );
  addCaseSetClaimGateDisclosureFindings(
    publicDisclosureChild<PublicCaseSetClaimGateDisclosure>(
      disclosureRecord?.caseSetClaimGate,
    ),
    blockers,
  );
  addRunProvenanceClaimGateFindings(
    publicDisclosureChild<PublicRunProvenanceDisclosure>(
      disclosureRecord?.runProvenance,
    ),
    publicConfigContract.configCount,
    blockers,
  );
  addConfidenceIntervalContractClaimGateFindings(
    input.metrics.confidence_intervals,
    blockers,
  );

  for (const config of PUBLIC_CLAIM_REQUIRED_CONFIGS) {
    if (!evaluatedConfigs.has(config)) {
      blockers.push({
        code: `missing_${config}_config`,
        message:
          "Public cost-performance claims need the fixed MVP evaluation matrix in the public report.",
        evidence: { requiredConfig: config },
      });
    }
  }
  if (input.metrics.scored_n < MIN_PUBLIC_REPORT_CLAIM_SCORED_CASES) {
    blockers.push({
      code: "too_few_scored_cases",
      message:
        "The public report has too few scored cases for cost-performance claims from this harness.",
      evidence: {
        scoredCaseCount: input.metrics.scored_n,
        requiredScoredCases: MIN_PUBLIC_REPORT_CLAIM_SCORED_CASES,
      },
    });
  }

  addCategoryClaimGateFindings(input.metrics.by_category, blockers);
  addGraderEvidenceClaimGateFindings(input.metrics, blockers);
  addRequiredConfigMetricClaimGateFindings(
    input.metrics,
    presentRequiredConfigs,
    blockers,
  );
  if (hasDirect && hasFusion) {
    addPairingClaimGateFindings(input.metrics, blockers);
    addIntervalClaimGateFindings(input.metrics, blockers);
  }
  addCostClaimGateFindings(input.metrics, presentRequiredConfigs, blockers);
  addPublicReportClaimGateWarnings(input, warnings);

  const directionalComparison = publicReportDirectionalComparison(
    input.metrics,
  );

  if (
    directionalComparison.status !== "fusion_directionally_better" &&
    hasFusion
  ) {
    warnings.push({
      code: "fusion_advantage_not_established",
      message:
        "The public report should not be described as proving that fusion is better than direct.",
      evidence: {
        directionalComparison: directionalComparison.status,
      },
    });
  }

  return {
    target: "public_cost_performance",
    scope: "public_projection_with_private_attestations",
    status:
      blockers.length === 0
        ? "public_report_constraints_met"
        : "public_report_blocked",
    overallClaimStatus: "external_evidence_required",
    minimums: {
      scoredCases: MIN_PUBLIC_REPORT_CLAIM_SCORED_CASES,
      scoredCasesPerCategory: RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
      nonSurfaceGraderEvidenceCases:
        MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES,
      nonSurfaceGraderEvidenceCasesPerCategory:
        MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY,
    },
    directionalComparison,
    blockers,
    warnings,
    externalEvidenceRequired: [
      {
        code: "frozen_manifest_bound_to_report",
        message:
          "Archive a frozen case manifest and bind it to this public report through private audit records.",
      },
      {
        code: "holdout_process_record",
        message:
          "Document that prompts, models, graders, and thresholds were not tuned against the holdout.",
      },
      {
        code: "private_reproduction_package",
        message:
          "Retain the private report, exact config, model/provider provenance, provider endpoint routing evidence, price snapshot, OpenRouter request-policy provenance, and evaluation command.",
      },
      {
        code: "provider_endpoint_custody",
        message:
          "Retain private evidence that each OpenRouter run used the intended exact provider endpoint and account/BYOK routing settings.",
      },
    ],
  };
}

export function verifyPublicEvalReportArtifact(
  input: unknown,
): PublicEvalReportVerification {
  const blockers: PublicReportVerificationFinding[] = [];
  const warnings: PublicReportVerificationFinding[] = [
    {
      code: "public_report_verifier_public_evidence_only",
      message:
        "This verifier checks only the public report artifact shape, public row-vs-metric consistency, and embedded claim-gate consistency; it does not read private reports, manifests, model snapshots, configs, case files, or provider accounts.",
    },
    {
      code: "public_report_external_evidence_still_required",
      message:
        "A verified public report still requires private reproduction artifacts and external holdout-process evidence before public cost-performance claims.",
    },
  ];
  const root = asPublicRecord(input);
  const rootObject = root !== undefined;
  const rootShapeStrict = hasExactPublicKeys(
    root,
    PUBLIC_EVAL_REPORT_ROOT_KEYS,
  );
  const shape = publicReportShapeCheck(root);
  const consistency = publicReportCaseMetricConsistencyCheck(root);
  const embeddedClaimGatePresent =
    asPublicRecord(root?.claimGate) !== undefined;
  const claimGateInputAvailable =
    rootObject &&
    root?.schemaVersion !== undefined &&
    root.configs !== undefined &&
    asPublicRecord(root.disclosure) !== undefined &&
    asPublicRecord(root.metrics) !== undefined &&
    shape.claimGateInputShapeStrict;

  if (!rootObject || !rootShapeStrict) {
    blockers.push({
      code: "public_report_root_shape_malformed",
      message:
        "The public report root must use the current exact allowlisted public artifact shape.",
      evidence: {
        publicReportRootObject: rootObject,
        publicReportRootShapeStrict: rootShapeStrict,
        publicReportRootKeyCount: root ? Object.keys(root).length : 0,
        publicReportRootExpectedKeyCount: PUBLIC_EVAL_REPORT_ROOT_KEYS.length,
      },
    });
  }
  if (!claimGateInputAvailable) {
    blockers.push({
      code: "public_report_claim_gate_input_unavailable",
      message:
        "The public report does not contain the minimum public fields needed to recompute the public claim gate.",
      evidence: {
        claimGateInputAvailable: false,
      },
    });
  }
  if (!shape.publicFieldsShapeStrict) {
    blockers.push({
      code: "public_report_public_fields_malformed",
      message:
        "The public report contains malformed or non-allowlisted public artifact fields.",
      evidence: {
        publicReportPublicFieldsShapeStrict: shape.publicFieldsShapeStrict,
        publicReportDisclosureShapeStrict: shape.disclosureShapeStrict,
        publicReportEvaluationDesignShapeStrict:
          shape.evaluationDesignShapeStrict,
        publicReportClaimReadinessShapeStrict: shape.claimReadinessShapeStrict,
        publicReportMetricsShapeStrict: shape.metricsShapeStrict,
        publicReportCasesShapeStrict: shape.casesShapeStrict,
      },
    });
  }
  if (!consistency.caseMetricsConsistent) {
    blockers.push({
      code: "public_report_case_metrics_mismatch",
      message:
        "The public report row-level public outcomes do not match the published aggregate public metrics.",
      evidence: {
        publicReportCaseCountMatches: consistency.caseCountMatches,
        publicReportScoredCaseCountMatches: consistency.scoredCaseCountMatches,
        publicReportScoredTrialCountMatches:
          consistency.scoredTrialCountMatches,
        publicReportScoredAttemptCountsMatch:
          consistency.scoredAttemptCountsMatch,
        publicReportScoredAttemptCoverageMatches:
          consistency.scoredAttemptCoverageMatches,
        publicReportTaskPassRatesMatch: consistency.taskPassRatesMatch,
        publicReportFusionPairingMatches: consistency.fusionPairingMatches,
        publicReportFusionHarmMatches: consistency.fusionHarmMatches,
      },
    });
  }
  if (!embeddedClaimGatePresent) {
    blockers.push({
      code: "public_report_claim_gate_missing",
      message:
        "The public report must include an embedded claimGate for verification.",
      evidence: {
        embeddedClaimGatePresent: false,
      },
    });
  }

  let claimGate: PublicReportClaimGateAssessment | null = null;
  if (claimGateInputAvailable && root) {
    try {
      claimGate = assessPublicReportClaimGate({
        schemaVersion: root.schemaVersion as PublicEvalReport["schemaVersion"],
        configs: root.configs as PublicEvalReport["configs"],
        disclosure: root.disclosure as PublicEvalReport["disclosure"],
        metrics: root.metrics as PublicEvalReport["metrics"],
      });
    } catch {
      blockers.push({
        code: "public_report_claim_gate_input_unavailable",
        message:
          "The public report claim-gate input could not be safely recomputed.",
        evidence: {
          claimGateInputAvailable: false,
        },
      });
    }
  }

  const embeddedClaimGateMatchesRecomputed =
    claimGate !== null &&
    embeddedClaimGatePresent &&
    canonicalPublicJson(root?.claimGate) === canonicalPublicJson(claimGate);
  if (
    claimGate !== null &&
    embeddedClaimGatePresent &&
    !embeddedClaimGateMatchesRecomputed
  ) {
    blockers.push({
      code: "public_report_claim_gate_mismatch",
      message:
        "The embedded public report claimGate does not match the current recomputed public claim gate.",
      evidence: {
        embeddedClaimGateMatchesRecomputed: false,
        embeddedClaimGateBlockerCount: publicClaimGateBlockerCount(
          root?.claimGate,
        ),
        recomputedClaimGateBlockerCount: claimGate.blockers.length,
        embeddedClaimGateConstraintsMet:
          publicClaimGateStatus(root?.claimGate) ===
          "public_report_constraints_met",
        recomputedClaimGateStatus: claimGate.status,
      },
    });
  }

  if (claimGate !== null) {
    warnings.push(...claimGate.warnings);
  }
  const status =
    blockers.length === 0 &&
    claimGate !== null &&
    claimGate.blockers.length === 0 &&
    embeddedClaimGateMatchesRecomputed
      ? "public_report_verified"
      : "public_report_blocked";

  return {
    schemaVersion: PUBLIC_REPORT_VERIFICATION_SCHEMA_VERSION,
    target: "public_eval_report",
    status,
    overallClaimStatus: "external_evidence_required",
    artifact: {
      rootObject,
      rootShapeStrict,
      publicFieldsShapeStrict: shape.publicFieldsShapeStrict,
      claimGateInputShapeStrict: shape.claimGateInputShapeStrict,
      claimGateInputAvailable: claimGate !== null,
      embeddedClaimGatePresent,
      embeddedClaimGateMatchesRecomputed,
    },
    claimGate,
    blockers,
    warnings,
  };
}

export function publicReportJsonParseFailureVerification(): PublicEvalReportVerification {
  return {
    schemaVersion: PUBLIC_REPORT_VERIFICATION_SCHEMA_VERSION,
    target: "public_eval_report",
    status: "public_report_blocked",
    overallClaimStatus: "external_evidence_required",
    artifact: {
      rootObject: false,
      rootShapeStrict: false,
      publicFieldsShapeStrict: false,
      claimGateInputShapeStrict: false,
      claimGateInputAvailable: false,
      embeddedClaimGatePresent: false,
      embeddedClaimGateMatchesRecomputed: false,
    },
    claimGate: null,
    blockers: [
      {
        code: "public_report_json_parse_failed",
        message:
          "The public report JSON could not be parsed. Details are omitted to keep verifier output public-safe.",
        evidence: { publicReportJsonParseable: false },
      },
    ],
    warnings: [
      {
        code: "public_report_verifier_public_evidence_only",
        message:
          "This verifier checks only public report artifact shape, public row-vs-metric consistency, and embedded claim-gate consistency.",
      },
    ],
  };
}

export function publicReportJsonReadFailureVerification(): PublicEvalReportVerification {
  return {
    schemaVersion: PUBLIC_REPORT_VERIFICATION_SCHEMA_VERSION,
    target: "public_eval_report",
    status: "public_report_blocked",
    overallClaimStatus: "external_evidence_required",
    artifact: {
      rootObject: false,
      rootShapeStrict: false,
      publicFieldsShapeStrict: false,
      claimGateInputShapeStrict: false,
      claimGateInputAvailable: false,
      embeddedClaimGatePresent: false,
      embeddedClaimGateMatchesRecomputed: false,
    },
    claimGate: null,
    blockers: [
      {
        code: "public_report_json_read_failed",
        message:
          "The public report JSON could not be read. Details are omitted to keep verifier output public-safe.",
        evidence: { publicReportJsonReadable: false },
      },
    ],
    warnings: [
      {
        code: "public_report_verifier_public_evidence_only",
        message:
          "This verifier checks only public report artifact shape, public row-vs-metric consistency, and embedded claim-gate consistency.",
      },
    ],
  };
}

type PublicReportShapeCheck = {
  publicFieldsShapeStrict: boolean;
  claimGateInputShapeStrict: boolean;
  disclosureShapeStrict: boolean;
  evaluationDesignShapeStrict: boolean;
  claimReadinessShapeStrict: boolean;
  metricsShapeStrict: boolean;
  casesShapeStrict: boolean;
};

function publicReportShapeCheck(
  root: Record<string, unknown> | undefined,
): PublicReportShapeCheck {
  const configs = publicConfigArray(root?.configs);
  const disclosureShapeStrict = isPublicDisclosureShape(root?.disclosure);
  const metricsShapeStrict =
    configs !== null && isPublicMetricsShape(root?.metrics, configs);
  const evaluationDesignShapeStrict = isPublicEvaluationDesignShape(
    root?.evaluationDesign,
  );
  const claimReadinessShapeStrict = isPublicClaimReadinessShape(
    root?.claimReadiness,
  );
  const casesShapeStrict =
    configs !== null && isPublicCasesShape(root?.cases, configs);
  const claimGateInputShapeStrict =
    typeof root?.schemaVersion === "string" &&
    configs !== null &&
    disclosureShapeStrict &&
    metricsShapeStrict;
  return {
    publicFieldsShapeStrict:
      typeof root?.schemaVersion === "string" &&
      isPublicGeneratedAt(root?.generatedAt) &&
      claimGateInputShapeStrict &&
      evaluationDesignShapeStrict &&
      claimReadinessShapeStrict &&
      casesShapeStrict,
    claimGateInputShapeStrict,
    disclosureShapeStrict,
    evaluationDesignShapeStrict,
    claimReadinessShapeStrict,
    metricsShapeStrict,
    casesShapeStrict,
  };
}

type PublicReportCaseMetricConsistencyCheck = {
  caseMetricsConsistent: boolean;
  caseCountMatches: boolean;
  scoredCaseCountMatches: boolean;
  scoredTrialCountMatches: boolean;
  scoredAttemptCountsMatch: boolean;
  scoredAttemptCoverageMatches: boolean;
  taskPassRatesMatch: boolean;
  fusionPairingMatches: boolean;
  fusionHarmMatches: boolean;
};

function publicReportCaseMetricConsistencyCheck(
  root: Record<string, unknown> | undefined,
): PublicReportCaseMetricConsistencyCheck {
  const failed: PublicReportCaseMetricConsistencyCheck = {
    caseMetricsConsistent: false,
    caseCountMatches: false,
    scoredCaseCountMatches: false,
    scoredTrialCountMatches: false,
    scoredAttemptCountsMatch: false,
    scoredAttemptCoverageMatches: false,
    taskPassRatesMatch: false,
    fusionPairingMatches: false,
    fusionHarmMatches: false,
  };
  const configs = publicConfigArray(root?.configs);
  if (
    root === undefined ||
    configs === null ||
    !isPublicMetricsShape(root.metrics, configs) ||
    !isPublicCasesShape(root.cases, configs)
  ) {
    return failed;
  }
  const metrics = root.metrics as PublicEvalMetrics;
  const cases = root.cases as PublicEvalCase[];
  const scoredCases = cases.filter((evalCase) => !evalCase.smokeOnly);
  const scoredTrialCount = scoredCases.reduce(
    (count, evalCase) => count + evalCase.trials.length,
    0,
  );
  const scoredAttemptCounts = Object.fromEntries(
    configs.map((config) => [config, 0]),
  ) as Record<DeliberationMode, number>;
  const passedAttemptCounts = Object.fromEntries(
    configs.map((config) => [config, 0]),
  ) as Record<DeliberationMode, number>;
  const incompleteCoverageCounts = Object.fromEntries(
    configs.map((config) => [config, 0]),
  ) as Record<DeliberationMode, number>;
  const fusionPair = {
    paired_n: 0,
    unpaired_n: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    pass_rate_delta: null as number | null,
    harm_rate: null as number | null,
  };
  let fusionPassDelta = 0;
  let fusionHarmTrialCount = 0;

  for (const evalCase of scoredCases) {
    for (const trial of evalCase.trials) {
      let directOutcome: PublicEvalOutcome | undefined;
      let fusionOutcome: PublicEvalOutcome | undefined;
      for (const config of configs) {
        const outcomes = trial.outcomes.filter(
          (outcome) => outcome.configId === config && !outcome.grader.smokeOnly,
        );
        scoredAttemptCounts[config] += outcomes.length;
        passedAttemptCounts[config] += outcomes.filter(
          (outcome) => outcome.passed,
        ).length;
        if (outcomes.length !== 1) incompleteCoverageCounts[config] += 1;
        if (config === "direct") directOutcome = outcomes[0];
        if (config === "fusion") fusionOutcome = outcomes[0];
      }
      if (!directOutcome || !fusionOutcome) {
        fusionPair.unpaired_n += 1;
      } else {
        fusionPair.paired_n += 1;
        if (fusionOutcome.passed && !directOutcome.passed) {
          fusionPair.wins += 1;
        } else if (!fusionOutcome.passed && directOutcome.passed) {
          fusionPair.losses += 1;
        } else {
          fusionPair.ties += 1;
        }
        fusionPassDelta +=
          Number(fusionOutcome.passed) - Number(directOutcome.passed);
        if (directOutcome.passed && !fusionOutcome.passed) {
          fusionHarmTrialCount += 1;
        }
      }
    }
  }
  if (fusionPair.paired_n > 0) {
    fusionPair.pass_rate_delta = roundNumber(
      fusionPassDelta / fusionPair.paired_n,
      4,
    );
    fusionPair.harm_rate = roundNumber(
      fusionPair.losses / fusionPair.paired_n,
      4,
    );
  }

  const caseCountMatches = cases.length === metrics.n;
  const scoredCaseCountMatches = scoredCases.length === metrics.scored_n;
  const scoredTrialCountMatches = scoredTrialCount === metrics.scored_trial_n;
  const scoredAttemptCountsMatch = configs.every(
    (config) =>
      metrics.scored_attempt_n[config] === scoredAttemptCounts[config],
  );
  const scoredAttemptCoverageMatches = configs.every((config) => {
    const coverage = metrics.scored_attempt_coverage[config];
    return (
      coverage.expected_scored_case_trial_n === scoredTrialCount &&
      coverage.observed_scored_attempt_n === scoredAttemptCounts[config] &&
      coverage.incomplete_scored_case_trial_n ===
        incompleteCoverageCounts[config] &&
      coverage.complete ===
        (scoredTrialCount > 0 && incompleteCoverageCounts[config] === 0)
    );
  });
  const taskPassRatesMatch = configs.every((config) => {
    const expected =
      scoredAttemptCounts[config] === 0
        ? null
        : roundNumber(
            passedAttemptCounts[config] / scoredAttemptCounts[config],
            4,
          );
    return metrics.task_pass_rate[config] === expected;
  });
  const hasDirectFusionPair =
    configs.includes("direct") && configs.includes("fusion");
  const publishedFusionPair = metrics.paired_vs_direct.fusion;
  const fusionPairingMatches =
    !hasDirectFusionPair ||
    (publishedFusionPair !== undefined &&
      publishedFusionPair.paired_n === fusionPair.paired_n &&
      publishedFusionPair.unpaired_n === fusionPair.unpaired_n &&
      publishedFusionPair.wins === fusionPair.wins &&
      publishedFusionPair.losses === fusionPair.losses &&
      publishedFusionPair.ties === fusionPair.ties &&
      publishedFusionPair.pass_rate_delta === fusionPair.pass_rate_delta &&
      publishedFusionPair.harm_rate === fusionPair.harm_rate);
  const expectedFusionHarmRate =
    fusionPair.paired_n === 0
      ? null
      : roundNumber(fusionHarmTrialCount / fusionPair.paired_n, 4);
  const fusionHarmMatches =
    !hasDirectFusionPair ||
    (metrics.fusion_harm_rate === expectedFusionHarmRate &&
      cases.every((evalCase) =>
        evalCase.smokeOnly
          ? true
          : evalCase.trials.every((trial) => {
              const directOutcome = trial.outcomes.find(
                (outcome) =>
                  outcome.configId === "direct" && !outcome.grader.smokeOnly,
              );
              const fusionOutcome = trial.outcomes.find(
                (outcome) =>
                  outcome.configId === "fusion" && !outcome.grader.smokeOnly,
              );
              return (
                trial.fusionHarm ===
                Boolean(directOutcome?.passed && !fusionOutcome?.passed)
              );
            }),
      ));
  const caseMetricsConsistent =
    caseCountMatches &&
    scoredCaseCountMatches &&
    scoredTrialCountMatches &&
    scoredAttemptCountsMatch &&
    scoredAttemptCoverageMatches &&
    taskPassRatesMatch &&
    fusionPairingMatches &&
    fusionHarmMatches;

  return {
    caseMetricsConsistent,
    caseCountMatches,
    scoredCaseCountMatches,
    scoredTrialCountMatches,
    scoredAttemptCountsMatch,
    scoredAttemptCoverageMatches,
    taskPassRatesMatch,
    fusionPairingMatches,
    fusionHarmMatches,
  };
}

function publicConfigArray(value: unknown): DeliberationMode[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isPublicConfig) ? [...value] : null;
}

function isPublicGeneratedAt(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPublicDisclosureShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (
    !hasExactPublicKeys(record, [
      "modelDisclosure",
      "priceDisclosure",
      "promptDisclosure",
      "caseIdentity",
      "traceDisclosure",
      "reproducibilityLevel",
      "caseSetManifestBinding",
      "caseSetClaimGate",
      "runProvenance",
      "notes",
    ])
  ) {
    return false;
  }
  return (
    record?.modelDisclosure === "redacted" &&
    record.priceDisclosure === "redacted" &&
    record.promptDisclosure === "redacted" &&
    record.caseIdentity === "generated-row-labels" &&
    record.traceDisclosure === "omitted" &&
    record.reproducibilityLevel === "private-audit-only" &&
    isExactStringArray(record.notes, PUBLIC_DISCLOSURE_NOTES) &&
    isPublicCaseSetManifestDisclosureShape(record.caseSetManifestBinding) &&
    isPublicCaseSetClaimGateDisclosureShape(record.caseSetClaimGate) &&
    isPublicRunProvenanceDisclosureShape(record.runProvenance)
  );
}

function isPublicCaseSetManifestDisclosureShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (record?.status === "not_provided") {
    return hasOnlyKeys(record, ["status"]);
  }
  return (
    hasExactPublicKeys(record, [
      "status",
      "schemaVersion",
      "fingerprintVersion",
      "canonicalization",
      "content",
      "intendedUse",
      "hashAlgorithm",
      "privacyClass",
      "digestDisclosure",
    ]) &&
    record?.status === "private_report_bound" &&
    record.schemaVersion === "frugal-fusion-case-set-manifest-v4" &&
    record.fingerprintVersion === "case-set-canonical-v3" &&
    record.canonicalization === "json-sorted-v1" &&
    record.content ===
      "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1" &&
    knownString(record.intendedUse, [
      "dev",
      "public_sample",
      "holdout",
    ] as const) !== null &&
    knownString(record.hashAlgorithm, ["sha256", "hmac-sha256"] as const) !==
      null &&
    knownString(record.privacyClass, [
      "public_or_frozen_sha256",
      "private_audit_hmac_sha256",
    ] as const) !== null &&
    record.digestDisclosure === "omitted"
  );
}

function isPublicCaseSetClaimGateDisclosureShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (record?.status === "not_provided") {
    return hasOnlyKeys(record, ["status"]);
  }
  if (
    !hasExactPublicKeys(record, [
      "status",
      "target",
      "scope",
      "overallClaimStatus",
      "detailDisclosure",
    ])
  ) {
    return false;
  }
  return (
    knownString(record.status, [
      "private_report_constraints_met",
      "private_report_blocked",
    ] as const) !== null &&
    record.target === "public_cost_performance" &&
    record.scope === "case_set_only" &&
    record.overallClaimStatus === "external_evidence_required" &&
    record.detailDisclosure === "omitted"
  );
}

function isPublicRunProvenanceDisclosureShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (record?.status === "not_provided") {
    return hasOnlyKeys(record, ["status"]);
  }
  return (
    hasExactPublicKeys(record, [
      "status",
      "schemaVersion",
      "fingerprintVersion",
      "canonicalization",
      "evaluatedConfigCount",
      "config",
      "modelPriceSnapshot",
      "openRouterRequestPolicy",
      "providerRouting",
    ]) &&
    record?.status === "private_report_fields_present" &&
    record.schemaVersion === "frugal-fusion-run-provenance-v2" &&
    record.fingerprintVersion === "run-provenance-v2" &&
    record.canonicalization === "json-sorted-v1" &&
    isNonNegativeInteger(record.evaluatedConfigCount) &&
    isPublicPrivateFieldDisclosureShape(record.config, [
      "status",
      "content",
      "digestDisclosure",
      "pathDisclosure",
    ]) &&
    asPublicRecord(record.config)?.content ===
      "resolved-frugal-fusion-config-v2" &&
    isPublicPrivateFieldDisclosureShape(record.modelPriceSnapshot, [
      "status",
      "content",
      "digestDisclosure",
      "pathDisclosure",
    ]) &&
    asPublicRecord(record.modelPriceSnapshot)?.content ===
      "effective-model-price-snapshot-v1" &&
    isPublicOpenRouterRequestPolicyShape(record.openRouterRequestPolicy) &&
    isPublicProviderRoutingShape(record.providerRouting)
  );
}

function isPublicPrivateFieldDisclosureShape(
  value: unknown,
  expectedKeys: readonly string[],
): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, expectedKeys) &&
    record?.status === "private_report_fields_present" &&
    record.digestDisclosure === "omitted" &&
    record.pathDisclosure === "omitted"
  );
}

function isPublicOpenRouterRequestPolicyShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (record?.status === "not_provided") {
    return hasOnlyKeys(record, ["status"]);
  }
  return (
    hasExactPublicKeys(record, ["status", "content", "digestDisclosure"]) &&
    record?.status === "private_report_fields_present" &&
    record.content === "openrouter-fixed-baseline-request-policy-v1" &&
    record.digestDisclosure === "omitted"
  );
}

function isPublicProviderRoutingShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (record?.status === "not_provided") {
    return hasOnlyKeys(record, ["status"]);
  }
  return (
    hasExactPublicKeys(record, [
      "status",
      "content",
      "providerEndpointPinning",
      "detailDisclosure",
    ]) &&
    record?.status === "private_report_fields_present" &&
    record.content === "openrouter-provider-routing-policy-v1" &&
    knownString(record.providerEndpointPinning, [
      "single_provider_endpoint_pinned",
      "not_configured",
      "fallbacks_allowed",
      "multiple_provider_endpoints_allowed",
      "base_provider_slug_only",
    ] as const) !== null &&
    record.detailDisclosure === "omitted"
  );
}

function isPublicEvaluationDesignShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "trialsPerCase",
      "schedule",
      "bootstrapSamples",
      "confidenceLevel",
    ]) &&
    isPositiveInteger(record?.trialsPerCase) &&
    record.schedule === "case-trial-rotation-v1" &&
    isNonNegativeInteger(record.bootstrapSamples) &&
    record.confidenceLevel === 0.95
  );
}

function isPublicClaimReadinessShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, ["status", "warnings"]) &&
    record?.status === "not_benchmark" &&
    isExactStringArray(record.warnings, PUBLIC_CLAIM_READINESS_WARNINGS)
  );
}

function isPublicMetricsShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "n",
      "scored_n",
      "trials_per_case",
      "scored_trial_n",
      "scored_attempt_n",
      "scored_attempt_coverage",
      "task_pass_rate",
      "fusion_harm_rate",
      "paired_vs_direct",
      "position_counts",
      "confidence_intervals",
      "grader_evidence",
      "by_category",
      "failure_rates",
      "cost_latency",
    ]) &&
    isNonNegativeInteger(record?.n) &&
    isNonNegativeInteger(record.scored_n) &&
    isPositiveInteger(record.trials_per_case) &&
    isNonNegativeInteger(record.scored_trial_n) &&
    isRecordForConfigs(
      record.scored_attempt_n,
      configs,
      isNonNegativeInteger,
    ) &&
    isRecordForConfigs(
      record.scored_attempt_coverage,
      configs,
      isPublicScoredAttemptCoverageShape,
    ) &&
    isRecordForConfigs(
      record.task_pass_rate,
      configs,
      isNullableFiniteNumber,
    ) &&
    isNullableFiniteNumber(record.fusion_harm_rate) &&
    isRecordForConfigs(
      record.paired_vs_direct,
      configs,
      isPublicPairedComparisonShape,
    ) &&
    isRecordForConfigs(
      record.position_counts,
      configs,
      isPositionCountsShape,
    ) &&
    isPublicConfidenceIntervalsShape(record.confidence_intervals, configs) &&
    isPublicGraderEvidenceSummaryShape(record.grader_evidence) &&
    isPublicCategoryBreakdownShape(record.by_category, configs) &&
    isPublicFailureRatesShape(record.failure_rates, configs) &&
    isPublicCostLatencyShape(record.cost_latency, configs)
  );
}

function isPublicScoredAttemptCoverageShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "expected_scored_case_trial_n",
      "observed_scored_attempt_n",
      "incomplete_scored_case_trial_n",
      "complete",
    ]) &&
    isNonNegativeInteger(record?.expected_scored_case_trial_n) &&
    isNonNegativeInteger(record.observed_scored_attempt_n) &&
    isNonNegativeInteger(record.incomplete_scored_case_trial_n) &&
    typeof record.complete === "boolean"
  );
}

function isPublicPairedComparisonShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "paired_n",
      "unpaired_n",
      "wins",
      "losses",
      "ties",
      "pass_rate_delta",
      "harm_rate",
    ]) &&
    isNonNegativeInteger(record?.paired_n) &&
    isNonNegativeInteger(record.unpaired_n) &&
    isNonNegativeInteger(record.wins) &&
    isNonNegativeInteger(record.losses) &&
    isNonNegativeInteger(record.ties) &&
    isNullableFiniteNumber(record.pass_rate_delta) &&
    isNullableFiniteNumber(record.harm_rate)
  );
}

function isPositionCountsShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (!hasExactPublicKeys(record, ["all", "scored"])) return false;
  return (
    isNonNegativeIntegerArray(record.all) &&
    isNonNegativeIntegerArray(record.scored)
  );
}

function isPublicConfidenceIntervalsShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  if (
    !hasExactPublicKeys(record, [
      "method",
      "level",
      "resamples",
      "warnings",
      "task_pass_rate",
      "pass_rate_delta_vs_direct",
    ])
  ) {
    return false;
  }
  return (
    (record.method === PUBLIC_CONFIDENCE_INTERVAL_METHOD ||
      record.method === null) &&
    (record.level === PUBLIC_CONFIDENCE_INTERVAL_LEVEL ||
      record.level === null) &&
    (isNonNegativeInteger(record.resamples) || record.resamples === null) &&
    isStringArrayFromSet(
      record.warnings,
      PUBLIC_CONFIDENCE_INTERVAL_WARNINGS,
    ) &&
    isRecordForConfigs(
      record.task_pass_rate,
      configs,
      isNullableIntervalShape,
    ) &&
    isRecordForConfigs(
      record.pass_rate_delta_vs_direct,
      configs,
      isNullableIntervalShape,
    )
  );
}

function isPublicGraderEvidenceSummaryShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "version",
      "tier_counts",
      "scored_tier_counts",
      "smoke_only_case_n",
      "dominant_tier",
      "dominant_tier_case_share",
      "profile_mix",
      "small_profile_cell_warning",
      "minimum_profile_cell_size",
      "notes",
    ]) &&
    record?.version === GRADER_EVIDENCE_TIER_VERSION &&
    isGraderEvidenceTierCountsShape(record.tier_counts) &&
    isGraderEvidenceTierCountsShape(record.scored_tier_counts) &&
    isNonNegativeInteger(record.smoke_only_case_n) &&
    isNullableGraderEvidenceTier(record.dominant_tier) &&
    isNullableFiniteNumber(record.dominant_tier_case_share) &&
    isPublicProfileMix(record.profile_mix) &&
    typeof record.small_profile_cell_warning === "boolean" &&
    isNonNegativeInteger(record.minimum_profile_cell_size) &&
    isExactStringArray(record.notes, PUBLIC_GRADER_EVIDENCE_NOTES)
  );
}

function isPublicCategoryBreakdownShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  if (record?.available === false) {
    return (
      hasExactPublicKeys(record, [
        "available",
        "suppressedReason",
        "minimumScoredCasesPerCategory",
        "recommendedScoredCasesPerCategoryForClaims",
        "categoryIdentity",
      ]) &&
      knownString(record.suppressedReason, [
        "no_scored_categories",
        "uncategorized_scored_cases",
        "small_scored_case_count_per_category",
      ] as const) !== null &&
      isNonNegativeInteger(record.minimumScoredCasesPerCategory) &&
      isNonNegativeInteger(record.recommendedScoredCasesPerCategoryForClaims) &&
      record.categoryIdentity === "generated-order-labels-not-anonymous"
    );
  }
  return (
    hasExactPublicKeys(record, [
      "available",
      "categoryIdentity",
      "minimumScoredCasesPerCategory",
      "recommendedScoredCasesPerCategoryForClaims",
      "confidence_intervals",
      "notes",
      "categories",
    ]) &&
    record?.available === true &&
    record.categoryIdentity === "generated-order-labels-not-anonymous" &&
    isNonNegativeInteger(record.minimumScoredCasesPerCategory) &&
    isNonNegativeInteger(record.recommendedScoredCasesPerCategoryForClaims) &&
    isPublicCategoryConfidenceIntervalsShape(record.confidence_intervals) &&
    isExactStringArray(record.notes, PUBLIC_CATEGORY_BREAKDOWN_NOTES) &&
    Array.isArray(record.categories) &&
    record.categories.every((category) =>
      isPublicCategoryMetricShape(category, configs),
    )
  );
}

function isPublicCategoryConfidenceIntervalsShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "method",
      "level",
      "resamples",
      "metrics",
      "scope",
    ]) &&
    (record?.method === PUBLIC_CONFIDENCE_INTERVAL_METHOD ||
      record?.method === null) &&
    (record.level === PUBLIC_CONFIDENCE_INTERVAL_LEVEL ||
      record.level === null) &&
    (isNonNegativeInteger(record.resamples) || record.resamples === null) &&
    isExactStringArray(record.metrics, [
      "task_pass_rate",
      "pass_rate_delta_vs_direct",
    ] as const) &&
    record.scope === "within_category"
  );
}

function isPublicCategoryMetricShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "publicCategoryId",
      "scored_case_n",
      "scored_trial_n",
      "scored_attempt_n_by_config",
      "passed_attempt_n_by_config",
      "passRateDenominator",
      "task_pass_rate",
      "task_pass_rate_interval",
      "pass_rate_delta_interval_vs_direct",
      "fusion_harm_rate",
      "pairedDenominator",
      "paired_vs_direct",
      "belowRecommendedScoredCases",
      "claimReadiness",
      "grader_evidence",
      "observed_runtime_check_kind_case_counts",
    ]) &&
    typeof record?.publicCategoryId === "string" &&
    /^category_\d{4}$/.test(record.publicCategoryId) &&
    isNonNegativeInteger(record.scored_case_n) &&
    isNonNegativeInteger(record.scored_trial_n) &&
    isRecordForConfigs(
      record.scored_attempt_n_by_config,
      configs,
      isNonNegativeInteger,
    ) &&
    isRecordForConfigs(
      record.passed_attempt_n_by_config,
      configs,
      isNonNegativeInteger,
    ) &&
    record.passRateDenominator === "scored_attempts" &&
    isRecordForConfigs(
      record.task_pass_rate,
      configs,
      isNullableFiniteNumber,
    ) &&
    isRecordForConfigs(
      record.task_pass_rate_interval,
      configs,
      isNullableIntervalShape,
    ) &&
    isRecordForConfigs(
      record.pass_rate_delta_interval_vs_direct,
      configs,
      isNullableIntervalShape,
    ) &&
    isNullableFiniteNumber(record.fusion_harm_rate) &&
    record.pairedDenominator === "case_trials" &&
    isRecordForConfigs(
      record.paired_vs_direct,
      configs,
      isPublicPairedComparisonShape,
    ) &&
    typeof record.belowRecommendedScoredCases === "boolean" &&
    knownString(record.claimReadiness, [
      "descriptive_only",
      "exploratory_underpowered",
    ] as const) !== null &&
    isPublicCategoryGraderEvidenceShape(record.grader_evidence) &&
    isObservedCheckKindCountsShape(
      record.observed_runtime_check_kind_case_counts,
    )
  );
}

function isPublicCategoryGraderEvidenceShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, [
      "version",
      "tier_counts",
      "dominant_tier",
      "dominant_tier_case_share",
      "profile_mix",
      "small_profile_cell_warning",
      "minimum_profile_cell_size",
    ]) &&
    record?.version === GRADER_EVIDENCE_TIER_VERSION &&
    isGraderEvidenceTierCountsShape(record.tier_counts) &&
    isNullableGraderEvidenceTier(record.dominant_tier) &&
    isNullableFiniteNumber(record.dominant_tier_case_share) &&
    isPublicProfileMix(record.profile_mix) &&
    typeof record.small_profile_cell_warning === "boolean" &&
    isNonNegativeInteger(record.minimum_profile_cell_size)
  );
}

function isPublicFailureRatesShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  if (
    !hasExactPublicKeys(record, [
      "invalid_output_rate",
      "timeout_rate",
      "provider_error_rate",
      "budget_exhaustion_rate",
      "partial_failure_rate",
      "verification_failure_rate",
      "smoke_completion_rate",
    ])
  ) {
    return false;
  }
  return (
    isRecordForConfigs(record.invalid_output_rate, configs, isFiniteNumber) &&
    isRecordForConfigs(record.timeout_rate, configs, isFiniteNumber) &&
    isRecordForConfigs(record.provider_error_rate, configs, isFiniteNumber) &&
    isRecordForConfigs(
      record.budget_exhaustion_rate,
      configs,
      isFiniteNumber,
    ) &&
    isRecordForConfigs(record.partial_failure_rate, configs, isFiniteNumber) &&
    isRecordForConfigs(
      record.verification_failure_rate,
      configs,
      isFiniteNumber,
    ) &&
    isRecordForConfigs(record.smoke_completion_rate, configs, isFiniteNumber)
  );
}

function isPublicCostLatencyShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  if (record?.available === false) {
    return (
      hasExactPublicKeys(record, [
        "available",
        "suppressedReason",
        "minimumScoredCases",
      ]) &&
      record.suppressedReason === "small_scored_case_count" &&
      isNonNegativeInteger(record.minimumScoredCases)
    );
  }
  return (
    hasExactPublicKeys(record, [
      "available",
      "precision",
      "cost_per_pass_usd",
      "cost_per_pass_interval_usd",
      "mean_cost_per_scored_attempt_usd",
      "total_cost_usd",
      "p50_latency_ms",
      "p95_latency_ms",
    ]) &&
    record?.available === true &&
    isPublicCostLatencyPrecisionShape(record.precision) &&
    isRecordForConfigs(
      record.cost_per_pass_usd,
      configs,
      isNullableFiniteNumber,
    ) &&
    isRecordForConfigs(
      record.cost_per_pass_interval_usd,
      configs,
      isPublicCostPerPassIntervalShape,
    ) &&
    isRecordForConfigs(
      record.mean_cost_per_scored_attempt_usd,
      configs,
      isNullableFiniteNumber,
    ) &&
    isRecordForConfigs(record.total_cost_usd, configs, isFiniteNumber) &&
    isRecordForConfigs(record.p50_latency_ms, configs, isFiniteNumber) &&
    isRecordForConfigs(record.p95_latency_ms, configs, isFiniteNumber)
  );
}

function isPublicCostLatencyPrecisionShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, ["costUsdDecimals", "latencyMsBucket"]) &&
    isNonNegativeInteger(record?.costUsdDecimals) &&
    isPositiveInteger(record.latencyMsBucket)
  );
}

function isPublicCostPerPassIntervalShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, ["low", "high", "available", "undefinedRate"]) &&
    isNullableFiniteNumber(record?.low) &&
    isNullableFiniteNumber(record.high) &&
    typeof record.available === "boolean" &&
    isFiniteNumber(record.undefinedRate)
  );
}

function isPublicCasesShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  return (
    Array.isArray(value) &&
    value.every((evalCase) => isPublicCaseShape(evalCase, configs))
  );
}

function isPublicCaseShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, ["publicId", "smokeOnly", "trials"]) &&
    typeof record?.publicId === "string" &&
    /^case_\d{4}$/.test(record.publicId) &&
    typeof record.smokeOnly === "boolean" &&
    Array.isArray(record.trials) &&
    record.trials.every((trial) => isPublicTrialShape(trial, configs))
  );
}

function isPublicTrialShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, ["trialIndex", "fusionHarm", "outcomes"]) &&
    isNonNegativeInteger(record?.trialIndex) &&
    typeof record.fusionHarm === "boolean" &&
    Array.isArray(record.outcomes) &&
    record.outcomes.every((outcome) => isPublicOutcomeShape(outcome, configs))
  );
}

function isPublicOutcomeShape(
  value: unknown,
  configs: readonly DeliberationMode[],
): boolean {
  const record = asPublicRecord(value);
  if (
    !hasOnlyKeys(record, [
      "configId",
      "status",
      "passed",
      "degraded",
      "failureStatus",
      "grader",
    ]) ||
    !hasRequiredPublicKeys(record, ["configId", "status", "passed", "grader"])
  ) {
    return false;
  }
  const status = knownString(record.status, ["completed", "failed"] as const);
  const failureStatus =
    record.failureStatus === undefined
      ? undefined
      : knownString(record.failureStatus, [
          "ok",
          "timeout",
          "provider_error",
          "invalid_output",
          "budget_exhausted",
        ] as const);
  const grader = asPublicRecord(record.grader);
  return (
    configs.includes(record.configId as DeliberationMode) &&
    status !== null &&
    typeof record.passed === "boolean" &&
    (record.degraded === undefined || typeof record.degraded === "boolean") &&
    (record.failureStatus === undefined || failureStatus !== null) &&
    isPublicGraderShape(record.grader) &&
    (record.passed === false ||
      (status === "completed" &&
        record.failureStatus === undefined &&
        grader?.passed === true)) &&
    (status !== "failed" ||
      (record.passed === false &&
        failureStatus !== undefined &&
        grader?.passed === false)) &&
    (record.failureStatus === undefined ||
      (status === "failed" && record.passed === false))
  );
}

function isPublicGraderShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  const passedCheckCount = checks.filter(
    (check) => asPublicRecord(check)?.passed === true,
  ).length;
  const checkCounts = asPublicRecord(record?.checkCounts);
  return (
    hasExactPublicKeys(record, [
      "passed",
      "smokeOnly",
      "checkCounts",
      "checks",
    ]) &&
    typeof record?.passed === "boolean" &&
    typeof record.smokeOnly === "boolean" &&
    isPublicCheckCountsShape(record.checkCounts) &&
    Array.isArray(record.checks) &&
    record.checks.length > 0 &&
    record.checks.every(isPublicCheckShape) &&
    checkCounts?.total === record.checks.length &&
    checkCounts.passed === passedCheckCount &&
    checkCounts.failed === record.checks.length - passedCheckCount &&
    record.passed === record.checks.every((check) => check.passed)
  );
}

function isPublicCheckCountsShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (!hasExactPublicKeys(record, ["total", "passed", "failed"])) {
    return false;
  }
  return (
    isNonNegativeInteger(record.total) &&
    isNonNegativeInteger(record.passed) &&
    isNonNegativeInteger(record.failed)
  );
}

function isPublicCheckShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  if (!hasExactPublicKeys(record, ["checkIndex", "kind", "passed"])) {
    return false;
  }
  return (
    isNonNegativeInteger(record.checkIndex) &&
    typeof record.kind === "string" &&
    PUBLIC_CHECK_KINDS.has(record.kind) &&
    typeof record.passed === "boolean"
  );
}

function isRecordForConfigs(
  value: unknown,
  configs: readonly DeliberationMode[],
  validate: (value: unknown) => boolean,
): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, configs) &&
    configs.every((config) => validate(record?.[config]))
  );
}

function isNullableIntervalShape(value: unknown): boolean {
  if (value === null) return true;
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, ["low", "high"]) &&
    isFiniteNumber(record?.low) &&
    isFiniteNumber(record.high)
  );
}

function isGraderEvidenceTierCountsShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    hasExactPublicKeys(record, GRADER_EVIDENCE_TIERS) &&
    GRADER_EVIDENCE_TIERS.every((tier) => isNonNegativeInteger(record?.[tier]))
  );
}

function isObservedCheckKindCountsShape(value: unknown): boolean {
  const record = asPublicRecord(value);
  return (
    record !== undefined &&
    Object.entries(record).every(
      ([key, count]) =>
        PUBLIC_CHECK_KINDS.has(key) && isNonNegativeInteger(count),
    )
  );
}

function isPublicProfileMix(value: unknown): boolean {
  return (
    knownString(value, [
      "single_tier",
      "mixed_tiers",
      "no_scored_cases",
    ] as const) !== null
  );
}

function isNullableGraderEvidenceTier(value: unknown): boolean {
  return value === null || GRADER_EVIDENCE_TIERS.includes(value as never);
}

function isExactStringArray(
  value: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isStringArrayFromSet(
  value: unknown,
  allowedValues: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "string" && allowedValues.includes(item),
    )
  );
}

function hasRequiredPublicKeys(
  record: Record<string, unknown> | undefined,
  requiredKeys: readonly string[],
): record is Record<string, unknown> {
  return (
    record !== undefined &&
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(record, key),
    )
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeIntegerArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNonNegativeInteger);
}

function addPublicReportSchemaVersionClaimGateFindings(
  schemaVersion: unknown,
  blockers: PublicReportClaimGateFinding[],
): void {
  if (schemaVersion !== PUBLIC_EVAL_REPORT_SCHEMA_VERSION) {
    blockers.push({
      code: "public_report_schema_version_unsupported",
      message:
        "Public cost-performance claims need the current public report schema contract.",
      evidence: { publicReportSchemaVersionKnown: false },
    });
  }
}

function addPublicDisclosureContractClaimGateFindings(
  disclosure: unknown,
  blockers: PublicReportClaimGateFinding[],
): void {
  const disclosureRecord = asPublicRecord(disclosure);
  const caseSetManifestBinding = asPublicRecord(
    disclosureRecord?.caseSetManifestBinding,
  );
  const runProvenance = asPublicRecord(disclosureRecord?.runProvenance);
  const caseSetClaimGate = asPublicRecord(disclosureRecord?.caseSetClaimGate);
  const runConfig = asPublicRecord(runProvenance?.config);
  const runModelPrice = asPublicRecord(runProvenance?.modelPriceSnapshot);
  const openRouterRequestPolicy = asPublicRecord(
    runProvenance?.openRouterRequestPolicy,
  );
  const providerRouting = asPublicRecord(runProvenance?.providerRouting);

  const evidence = {
    publicDisclosureRootShapeStrict: hasExactPublicKeys(disclosureRecord, [
      "modelDisclosure",
      "priceDisclosure",
      "promptDisclosure",
      "caseIdentity",
      "traceDisclosure",
      "reproducibilityLevel",
      "caseSetManifestBinding",
      "caseSetClaimGate",
      "runProvenance",
      "notes",
    ]),
    modelDisclosureRedacted: disclosureRecord?.modelDisclosure === "redacted",
    priceDisclosureRedacted: disclosureRecord?.priceDisclosure === "redacted",
    promptDisclosureRedacted: disclosureRecord?.promptDisclosure === "redacted",
    caseIdentityGeneratedRowLabels:
      disclosureRecord?.caseIdentity === "generated-row-labels",
    traceDisclosureOmitted: disclosureRecord?.traceDisclosure === "omitted",
    reproducibilityPrivateAuditOnly:
      disclosureRecord?.reproducibilityLevel === "private-audit-only",
    caseManifestDigestOmitted:
      (caseSetManifestBinding?.status !== "private_report_bound" &&
        caseSetManifestBinding?.digestDisclosure === undefined) ||
      caseSetManifestBinding.digestDisclosure === "omitted",
    caseManifestNotProvidedShapeStrict:
      caseSetManifestBinding?.status !== "not_provided" ||
      hasOnlyKeys(caseSetManifestBinding, ["status"]),
    caseSetManifestBindingPresentShapeStrict:
      caseSetManifestBinding?.status !== "private_report_bound" ||
      hasExactPublicKeys(caseSetManifestBinding, [
        "status",
        "schemaVersion",
        "fingerprintVersion",
        "canonicalization",
        "content",
        "intendedUse",
        "hashAlgorithm",
        "privacyClass",
        "digestDisclosure",
      ]),
    caseManifestSchemaVersionKnown:
      caseSetManifestBinding?.status !== "private_report_bound" ||
      caseSetManifestBinding?.schemaVersion ===
        "frugal-fusion-case-set-manifest-v4",
    caseManifestFingerprintVersionKnown:
      caseSetManifestBinding?.status !== "private_report_bound" ||
      caseSetManifestBinding?.fingerprintVersion === "case-set-canonical-v3",
    caseManifestCanonicalizationKnown:
      caseSetManifestBinding?.status !== "private_report_bound" ||
      caseSetManifestBinding?.canonicalization === "json-sorted-v1",
    caseManifestContentKnown:
      caseSetManifestBinding?.status !== "private_report_bound" ||
      caseSetManifestBinding?.content ===
        "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1",
    caseSetClaimGateNotProvidedShapeStrict:
      caseSetClaimGate?.status !== "not_provided" ||
      hasOnlyKeys(caseSetClaimGate, ["status"]),
    caseSetClaimGatePresentShapeStrict:
      (caseSetClaimGate?.status !== "private_report_constraints_met" &&
        caseSetClaimGate?.status !== "private_report_blocked") ||
      hasExactPublicKeys(caseSetClaimGate, [
        "status",
        "target",
        "scope",
        "overallClaimStatus",
        "detailDisclosure",
      ]),
    caseSetClaimGateDetailOmitted:
      caseSetClaimGate?.detailDisclosure === undefined ||
      caseSetClaimGate.detailDisclosure === "omitted",
    runProvenanceNotProvidedShapeStrict:
      runProvenance?.status !== "not_provided" ||
      hasOnlyKeys(runProvenance, ["status"]),
    runProvenancePresentShapeStrict:
      runProvenance?.status !== "private_report_fields_present" ||
      hasExactPublicKeys(runProvenance, [
        "status",
        "schemaVersion",
        "fingerprintVersion",
        "canonicalization",
        "evaluatedConfigCount",
        "config",
        "modelPriceSnapshot",
        "openRouterRequestPolicy",
        "providerRouting",
      ]),
    runProvenanceSchemaVersionKnown:
      runProvenance?.status !== "private_report_fields_present" ||
      runProvenance?.schemaVersion === "frugal-fusion-run-provenance-v2",
    runProvenanceFingerprintVersionKnown:
      runProvenance?.status !== "private_report_fields_present" ||
      runProvenance?.fingerprintVersion === "run-provenance-v2",
    runProvenanceCanonicalizationKnown:
      runProvenance?.status !== "private_report_fields_present" ||
      runProvenance?.canonicalization === "json-sorted-v1",
    runConfigPresentShapeStrict:
      runProvenance?.status !== "private_report_fields_present" ||
      hasExactPublicKeys(runConfig, [
        "status",
        "content",
        "digestDisclosure",
        "pathDisclosure",
      ]),
    runConfigContentKnown:
      runProvenance?.status !== "private_report_fields_present" ||
      runConfig?.status !== "private_report_fields_present" ||
      runConfig?.content === "resolved-frugal-fusion-config-v2",
    runConfigDigestOmitted:
      (runProvenance?.status !== "private_report_fields_present" &&
        runConfig?.digestDisclosure === undefined) ||
      runConfig?.digestDisclosure === "omitted",
    runConfigPathOmitted:
      (runProvenance?.status !== "private_report_fields_present" &&
        runConfig?.pathDisclosure === undefined) ||
      runConfig?.pathDisclosure === "omitted",
    runModelPricePresentShapeStrict:
      runProvenance?.status !== "private_report_fields_present" ||
      hasExactPublicKeys(runModelPrice, [
        "status",
        "content",
        "digestDisclosure",
        "pathDisclosure",
      ]),
    runModelPriceContentKnown:
      runProvenance?.status !== "private_report_fields_present" ||
      runModelPrice?.status !== "private_report_fields_present" ||
      runModelPrice?.content === "effective-model-price-snapshot-v1",
    runModelPriceDigestOmitted:
      (runProvenance?.status !== "private_report_fields_present" &&
        runModelPrice?.digestDisclosure === undefined) ||
      runModelPrice?.digestDisclosure === "omitted",
    runModelPricePathOmitted:
      (runProvenance?.status !== "private_report_fields_present" &&
        runModelPrice?.pathDisclosure === undefined) ||
      runModelPrice?.pathDisclosure === "omitted",
    openRouterRequestPolicyDigestOmitted:
      (runProvenance?.status !== "private_report_fields_present" &&
        openRouterRequestPolicy?.digestDisclosure === undefined) ||
      openRouterRequestPolicy?.digestDisclosure === "omitted",
    openRouterRequestPolicyContentKnown:
      openRouterRequestPolicy?.status !== "private_report_fields_present" ||
      openRouterRequestPolicy?.content ===
        "openrouter-fixed-baseline-request-policy-v1",
    openRouterRequestPolicyNotProvidedShapeStrict:
      openRouterRequestPolicy?.status !== "not_provided" ||
      hasOnlyKeys(openRouterRequestPolicy, ["status"]),
    openRouterRequestPolicyPresentShapeStrict:
      openRouterRequestPolicy?.status !== "private_report_fields_present" ||
      hasExactPublicKeys(openRouterRequestPolicy, [
        "status",
        "content",
        "digestDisclosure",
      ]),
    providerRoutingDetailOmitted:
      (runProvenance?.status !== "private_report_fields_present" &&
        providerRouting?.detailDisclosure === undefined) ||
      providerRouting?.detailDisclosure === "omitted",
    providerRoutingContentKnown:
      providerRouting?.status !== "private_report_fields_present" ||
      providerRouting?.content === "openrouter-provider-routing-policy-v1",
    providerRoutingNotProvidedShapeStrict:
      providerRouting?.status !== "not_provided" ||
      hasOnlyKeys(providerRouting, ["status"]),
    providerRoutingPresentShapeStrict:
      providerRouting?.status !== "private_report_fields_present" ||
      hasExactPublicKeys(providerRouting, [
        "status",
        "content",
        "providerEndpointPinning",
        "detailDisclosure",
      ]),
  };

  if (Object.values(evidence).some((value) => !value)) {
    blockers.push({
      code: "public_disclosure_contract_malformed",
      message:
        "Public cost-performance claims need the public report disclosure contract to keep private fields redacted or omitted.",
      evidence,
    });
  }
}

function addPublicConfigContractClaimGateFindings(
  rawConfigs: unknown,
  blockers: PublicReportClaimGateFinding[],
): { safeConfigs: DeliberationMode[]; configCount: number } {
  const publicConfigsArray = Array.isArray(rawConfigs);
  const configValues = publicConfigsArray ? rawConfigs : [];
  const safeConfigs = configValues.filter(isPublicConfig);
  const publicConfigsRecognized = safeConfigs.length === configValues.length;
  const publicConfigsDistinct =
    new Set(configValues).size === configValues.length;
  const publicConfigCount = configValues.length;
  const hasRequiredConfigs = PUBLIC_CLAIM_REQUIRED_CONFIGS.every((config) =>
    safeConfigs.includes(config),
  );
  const evidence = {
    publicConfigsArray,
    publicConfigsRecognized,
    publicConfigsDistinct,
    publicConfigCount,
    requiredConfigCount: PUBLIC_CLAIM_REQUIRED_CONFIGS.length,
  };
  if (
    !publicConfigsArray ||
    !publicConfigsRecognized ||
    !publicConfigsDistinct ||
    publicConfigCount !== PUBLIC_CLAIM_REQUIRED_CONFIGS.length ||
    !hasRequiredConfigs
  ) {
    blockers.push({
      code: "public_config_contract_malformed",
      message:
        "Public cost-performance claims need exactly the fixed MVP public configuration matrix, with no unknown or duplicate config IDs.",
      evidence,
    });
  }
  return {
    safeConfigs,
    configCount: publicConfigCount,
  };
}

function isPublicConfig(value: unknown): value is DeliberationMode {
  return (
    typeof value === "string" && PUBLIC_CONFIGS.has(value as DeliberationMode)
  );
}

function asPublicRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicDisclosureChild<T>(value: unknown): T {
  return (asPublicRecord(value) ?? {
    status: "__malformed_public_disclosure_child",
  }) as T;
}

function hasOnlyKeys(
  record: Record<string, unknown> | undefined,
  allowedKeys: readonly string[],
): record is Record<string, unknown> {
  if (record === undefined) return false;
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function hasExactPublicKeys(
  record: Record<string, unknown> | undefined,
  expectedKeys: readonly string[],
): record is Record<string, unknown> {
  if (record === undefined) return false;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function knownString<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): T | null {
  return typeof value === "string" &&
    (allowedValues as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function canonicalPublicJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalPublicJson(item)).join(",")}]`;
  }
  const record = asPublicRecord(value);
  if (record !== undefined) {
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalPublicJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicClaimGateBlockerCount(value: unknown): number {
  const blockers = asPublicRecord(value)?.blockers;
  return Array.isArray(blockers) ? blockers.length : 0;
}

function publicClaimGateStatus(
  value: unknown,
): PublicReportClaimGateAssessment["status"] | null {
  return knownString(asPublicRecord(value)?.status, [
    "public_report_blocked",
    "public_report_constraints_met",
  ] as const);
}

function addGraderEvidenceClaimGateFindings(
  metrics: PublicEvalMetrics,
  blockers: PublicReportClaimGateFinding[],
): void {
  const scoredTierCounts = metrics.grader_evidence.scored_tier_counts;
  const nonSurfaceGraderEvidenceCaseCount =
    scoredTierCounts.structured_or_exact + scoredTierCounts.mixed;
  if (
    metrics.scored_n > 0 &&
    nonSurfaceGraderEvidenceCaseCount <
      MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES
  ) {
    blockers.push({
      code: "insufficient_non_surface_grader_evidence",
      message:
        "Public cost-performance claims need a minimum scored evidence cell beyond surface-text-only grader checks.",
      evidence: {
        scoredCaseCount: metrics.scored_n,
        surfaceTextCaseCount: scoredTierCounts.surface_text,
        mixedCaseCount: scoredTierCounts.mixed,
        structuredOrExactCaseCount: scoredTierCounts.structured_or_exact,
        nonSurfaceGraderEvidenceCaseCount,
        requiredNonSurfaceGraderEvidenceCases:
          MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES,
      },
    });
  }
}

function addConfidenceIntervalContractClaimGateFindings(
  intervals: PublicEvalMetrics["confidence_intervals"],
  blockers: PublicReportClaimGateFinding[],
): void {
  const intervalRecord = intervals as unknown as Record<string, unknown>;
  const resamples = publicNonNegativeIntegerCount(intervalRecord.resamples);
  const evidence = {
    confidenceIntervalMethodCaseClusterBootstrap:
      intervalRecord.method === PUBLIC_CONFIDENCE_INTERVAL_METHOD,
    confidenceIntervalLevel95:
      intervalRecord.level === PUBLIC_CONFIDENCE_INTERVAL_LEVEL,
    confidenceIntervalResamplesPositiveInteger:
      resamples !== null && resamples > 0,
    confidenceIntervalResamplesAtLeastMinimum:
      resamples !== null &&
      resamples >= MIN_PUBLIC_CONFIDENCE_INTERVAL_RESAMPLES,
    confidenceIntervalResampleCount: resamples,
    minimumConfidenceIntervalResamples:
      MIN_PUBLIC_CONFIDENCE_INTERVAL_RESAMPLES,
  };
  if (
    !evidence.confidenceIntervalMethodCaseClusterBootstrap ||
    !evidence.confidenceIntervalLevel95 ||
    !evidence.confidenceIntervalResamplesPositiveInteger ||
    !evidence.confidenceIntervalResamplesAtLeastMinimum
  ) {
    blockers.push({
      code: "confidence_interval_contract_malformed",
      message:
        "Public cost-performance claims need case-cluster bootstrap confidence intervals at the required level and resample floor.",
      evidence,
    });
  }
}

function publicNonNegativeIntegerCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function addRunProvenanceClaimGateFindings(
  provenance: PublicRunProvenanceDisclosure,
  publicReportConfigCount: number,
  blockers: PublicReportClaimGateFinding[],
): void {
  const provenanceStatus = knownString(provenance.status, [
    "not_provided",
    "private_report_fields_present",
  ] as const);
  if (provenance.status === "not_provided") {
    blockers.push({
      code: "run_provenance_missing",
      message:
        "Public cost-performance claims need private run-provenance fingerprints for the executed config and effective model price snapshot.",
      evidence: { runProvenanceStatus: provenanceStatus },
    });
    return;
  }
  if (provenanceStatus === null) {
    blockers.push({
      code: "run_provenance_malformed",
      message:
        "Public cost-performance claims need a supported no-digest run-provenance disclosure shape.",
      evidence: { runProvenanceStatus: null },
    });
    return;
  }
  const configProvenance =
    provenance.status === "private_report_fields_present"
      ? provenance.config
      : undefined;
  const modelPriceProvenance =
    provenance.status === "private_report_fields_present"
      ? provenance.modelPriceSnapshot
      : undefined;
  if (
    configProvenance?.status !== "private_report_fields_present" ||
    modelPriceProvenance?.status !== "private_report_fields_present"
  ) {
    blockers.push({
      code: "run_provenance_incomplete",
      message:
        "Public cost-performance claims need private run-provenance fields for both config and model price snapshot.",
      evidence: {
        runProvenanceStatus: provenanceStatus,
        configProvenanceStatus: knownString(configProvenance?.status, [
          "private_report_fields_present",
        ] as const),
        modelPriceProvenanceStatus: knownString(modelPriceProvenance?.status, [
          "private_report_fields_present",
        ] as const),
      },
    });
  }
  const openRouterRequestPolicy = provenance.openRouterRequestPolicy;
  const openRouterRequestPolicyStatus = knownString(
    openRouterRequestPolicy?.status,
    ["not_provided", "private_report_fields_present"] as const,
  );
  const openRouterRequestPolicyValid =
    openRouterRequestPolicyStatus === "private_report_fields_present" &&
    openRouterRequestPolicy?.status === "private_report_fields_present" &&
    openRouterRequestPolicy.content ===
      "openrouter-fixed-baseline-request-policy-v1" &&
    openRouterRequestPolicy.digestDisclosure === "omitted";
  if (!openRouterRequestPolicyValid) {
    blockers.push({
      code: "openrouter_request_policy_missing",
      message:
        "Public cost-performance claims need private run-provenance disclosure that fixed-baseline OpenRouter request policy was bound to the run.",
      evidence: {
        runProvenanceStatus: provenanceStatus,
        openRouterRequestPolicyStatus,
      },
    });
  }
  const providerRouting = provenance.providerRouting;
  const providerRoutingStatus = knownString(providerRouting?.status, [
    "not_provided",
    "private_report_fields_present",
  ] as const);
  const providerEndpointPinning = knownString(
    providerRouting?.status === "private_report_fields_present"
      ? providerRouting.providerEndpointPinning
      : undefined,
    [
      "single_provider_endpoint_pinned",
      "not_configured",
      "fallbacks_allowed",
      "multiple_provider_endpoints_allowed",
      "base_provider_slug_only",
    ] as const,
  );
  const providerRoutingValid =
    providerRoutingStatus === "private_report_fields_present" &&
    providerRouting?.status === "private_report_fields_present" &&
    providerRouting.content === "openrouter-provider-routing-policy-v1" &&
    providerRouting.detailDisclosure === "omitted" &&
    providerEndpointPinning !== null;
  if (
    !providerRoutingValid ||
    providerEndpointPinning !== "single_provider_endpoint_pinned"
  ) {
    blockers.push({
      code: "provider_endpoint_pinning_missing",
      message:
        "Public cost-performance claims need private run-provenance disclosure that OpenRouter provider routing was pinned to one exact endpoint with fallbacks disabled.",
      evidence: {
        runProvenanceStatus: provenanceStatus,
        providerRoutingStatus,
        providerEndpointPinning,
      },
    });
  }
  if (
    !Number.isInteger(provenance.evaluatedConfigCount) ||
    provenance.evaluatedConfigCount !== publicReportConfigCount ||
    provenance.evaluatedConfigCount !== PUBLIC_CLAIM_REQUIRED_CONFIGS.length
  ) {
    blockers.push({
      code: "run_provenance_config_count_mismatch",
      message:
        "Public cost-performance claims need no-digest run-provenance config counts that match the public report and fixed MVP matrix.",
      evidence: {
        runProvenanceEvaluatedConfigCount: Number.isFinite(
          provenance.evaluatedConfigCount,
        )
          ? provenance.evaluatedConfigCount
          : null,
        publicReportConfigCount,
        requiredConfigCount: PUBLIC_CLAIM_REQUIRED_CONFIGS.length,
      },
    });
  }
}

function addCategoryClaimGateFindings(
  byCategory: PublicCategoryBreakdown,
  blockers: PublicReportClaimGateFinding[],
): void {
  if (!byCategory.available) {
    blockers.push({
      code: "category_evidence_unavailable",
      message:
        "Public cost-performance claims need publishable category evidence.",
      evidence: {
        categoryBreakdownAvailable: false,
        suppressedReason: byCategory.suppressedReason,
        requiredScoredCasesPerCategory: RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
      },
    });
    return;
  }
  const categoryCounts = byCategory.categories.map(
    (category) => category.scored_case_n,
  );
  if (categoryCounts.length === 0) {
    blockers.push({
      code: "category_evidence_empty",
      message:
        "Public category evidence is marked available but has no category rows.",
      evidence: {
        categoryCount: 0,
        requiredScoredCasesPerCategory: RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
      },
    });
    return;
  }
  const underpoweredCategoryCount = byCategory.categories.filter(
    (category) =>
      category.scored_case_n < RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
  ).length;
  const inconsistentCategoryCount = byCategory.categories.filter(
    (category) =>
      category.belowRecommendedScoredCases !==
      category.scored_case_n < RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
  ).length;
  const claimEligibleCategories = byCategory.categories.filter(
    (category) =>
      category.scored_case_n >= RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
  );
  const claimEligibleCategoryNonSurfaceCounts = claimEligibleCategories.map(
    (category) =>
      category.grader_evidence.tier_counts.structured_or_exact +
      category.grader_evidence.tier_counts.mixed,
  );
  const underpoweredNonSurfaceGraderEvidenceCategoryCount =
    claimEligibleCategoryNonSurfaceCounts.filter(
      (count) =>
        count < MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY,
    ).length;
  const minNonSurfaceGraderEvidenceCasesPerCategory =
    claimEligibleCategoryNonSurfaceCounts.length > 0
      ? Math.min(...claimEligibleCategoryNonSurfaceCounts)
      : 0;
  if (underpoweredCategoryCount > 0) {
    blockers.push({
      code: "category_underpowered",
      message:
        "Every published category needs the recommended scored-case floor before public cost-performance claims.",
      evidence: {
        categoryCount: byCategory.categories.length,
        underpoweredCategoryCount,
        minScoredCasesPerCategory: Math.min(...categoryCounts),
        requiredScoredCasesPerCategory: RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
      },
    });
  }
  if (underpoweredNonSurfaceGraderEvidenceCategoryCount > 0) {
    blockers.push({
      code: "category_non_surface_grader_evidence_underpowered",
      message:
        "Every claim-eligible public category needs the minimum non-surface grader-evidence cell before category-level public cost-performance claims.",
      evidence: {
        categoryCount: claimEligibleCategories.length,
        affectedCategoryCount:
          underpoweredNonSurfaceGraderEvidenceCategoryCount,
        minNonSurfaceGraderEvidenceCasesPerCategory,
        requiredNonSurfaceGraderEvidenceCasesPerCategory:
          MIN_PUBLIC_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY,
      },
    });
  }
  if (inconsistentCategoryCount > 0) {
    blockers.push({
      code: "category_claim_floor_inconsistent",
      message:
        "Published category readiness flags do not match the scored-case floor.",
      evidence: {
        categoryCount: byCategory.categories.length,
        inconsistentCategoryCount,
        requiredScoredCasesPerCategory: RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
      },
    });
  }
}

function addRequiredConfigMetricClaimGateFindings(
  metrics: PublicEvalMetrics,
  configs: readonly DeliberationMode[],
  blockers: PublicReportClaimGateFinding[],
): void {
  for (const config of configs) {
    const scoredAttemptCount = publicMetricValue(
      metrics.scored_attempt_n,
      config,
    );
    if (scoredAttemptCount === undefined || scoredAttemptCount <= 0) {
      blockers.push({
        code: `${config}_scored_attempts_unavailable`,
        message:
          "Public cost-performance claims need scored attempts for every required public report configuration.",
        evidence: {
          config,
          scoredAttemptCount: scoredAttemptCount ?? null,
        },
      });
    }
    const coverageRecord = (metrics as Partial<PublicEvalMetrics>)
      .scored_attempt_coverage;
    const coverage = coverageRecord
      ? publicMetricValue(coverageRecord, config)
      : undefined;
    const coverageExpected = publicNonNegativeIntegerCount(
      coverage?.expected_scored_case_trial_n,
    );
    const coverageObserved = publicNonNegativeIntegerCount(
      coverage?.observed_scored_attempt_n,
    );
    const coverageIncomplete = publicNonNegativeIntegerCount(
      coverage?.incomplete_scored_case_trial_n,
    );
    if (
      !coverage ||
      coverageExpected !== metrics.scored_trial_n ||
      coverageObserved !== scoredAttemptCount ||
      coverageIncomplete !== 0 ||
      coverage.complete !==
        (coverageExpected !== null &&
          coverageExpected > 0 &&
          coverageIncomplete === 0)
    ) {
      blockers.push({
        code: `${config}_scored_attempt_coverage_incomplete`,
        message:
          "Public cost-performance claims need every required configuration to have exactly one scored attempt for every scored case-trial.",
        evidence: {
          config,
          scoredAttemptCount: coverageObserved ?? scoredAttemptCount ?? null,
          scoredTrialCount: coverageExpected ?? metrics.scored_trial_n,
          incompleteScoredCaseTrialCount: coverageIncomplete,
        },
      });
    }
    const taskPassRate = publicMetricValue(metrics.task_pass_rate, config);
    if (taskPassRate === undefined || taskPassRate === null) {
      blockers.push({
        code: `${config}_task_pass_rate_unavailable`,
        message:
          "Public cost-performance claims need task pass rates for every required public report configuration.",
        evidence: { config },
      });
    }
    const taskPassInterval = publicMetricValue(
      metrics.confidence_intervals.task_pass_rate,
      config,
    );
    if (taskPassInterval === undefined || taskPassInterval === null) {
      blockers.push({
        code: `${config}_task_pass_rate_interval_unavailable`,
        message:
          "Public cost-performance claims need task pass-rate intervals for every required public report configuration.",
        evidence: { config },
      });
    }
  }
}

function addPairingClaimGateFindings(
  metrics: PublicEvalMetrics,
  blockers: PublicReportClaimGateFinding[],
): void {
  const fusionPair = publicMetricValue(metrics.paired_vs_direct, "fusion");
  if (!fusionPair || fusionPair.paired_n === 0) {
    blockers.push({
      code: "fusion_pairing_unavailable",
      message:
        "Public cost-performance comparison needs paired direct-vs-fusion outcomes.",
      evidence: { scoredTrialCount: metrics.scored_trial_n },
    });
    return;
  }
  if (
    fusionPair.unpaired_n > 0 ||
    fusionPair.paired_n !== metrics.scored_trial_n
  ) {
    blockers.push({
      code: "fusion_pairing_incomplete",
      message:
        "Every scored case-trial needs both direct and fusion outcomes for public comparison.",
      evidence: {
        pairedCaseTrialCount: fusionPair.paired_n,
        unpairedCaseTrialCount: fusionPair.unpaired_n,
        scoredTrialCount: metrics.scored_trial_n,
      },
    });
  }
}

function addCaseManifestBindingClaimGateFindings(
  binding: PublicCaseSetManifestBindingDisclosure,
  blockers: PublicReportClaimGateFinding[],
): void {
  const bindingStatus = knownString(binding.status, [
    "not_provided",
    "private_report_bound",
  ] as const);
  if (binding.status === "not_provided") {
    blockers.push({
      code: "case_manifest_binding_missing",
      message:
        "Public cost-performance claims need a private report binding to the exact frozen case manifest.",
      evidence: { caseSetManifestBindingStatus: bindingStatus },
    });
    return;
  }
  if (bindingStatus === null) {
    blockers.push({
      code: "case_manifest_binding_malformed",
      message:
        "Public cost-performance claims need a supported no-digest case-manifest binding disclosure shape.",
      evidence: { caseSetManifestBindingStatus: null },
    });
    return;
  }
  if (binding.intendedUse !== "holdout") {
    blockers.push({
      code: "case_manifest_not_holdout",
      message:
        "Public cost-performance claims need a case manifest marked as an unused holdout.",
      evidence: {
        manifestIntendedUse: knownString(binding.intendedUse, [
          "dev",
          "public_sample",
          "holdout",
        ] as const),
      },
    });
  }
  if (
    binding.hashAlgorithm !== "hmac-sha256" ||
    binding.privacyClass !== "private_audit_hmac_sha256"
  ) {
    blockers.push({
      code: "case_manifest_not_private_audit_hmac",
      message: "Private holdout report binding must use an HMAC case manifest.",
      evidence: {
        manifestHashAlgorithm: knownString(binding.hashAlgorithm, [
          "sha256",
          "hmac-sha256",
        ] as const),
        manifestPrivacyClass: knownString(binding.privacyClass, [
          "public_or_frozen_sha256",
          "private_audit_hmac_sha256",
        ] as const),
      },
    });
  }
}

function addCaseSetClaimGateDisclosureFindings(
  claimGate: PublicCaseSetClaimGateDisclosure,
  blockers: PublicReportClaimGateFinding[],
): void {
  const claimGateStatus = knownString(claimGate.status, [
    "not_provided",
    "private_report_constraints_met",
    "private_report_blocked",
  ] as const);
  if (claimGate.status === "not_provided") {
    blockers.push({
      code: "case_set_claim_gate_missing",
      message:
        "Public cost-performance claims need a private report no-spend case-set claim-gate attestation.",
      evidence: { caseSetClaimGateStatus: claimGateStatus },
    });
    return;
  }
  if (
    claimGateStatus === null ||
    claimGate.target !== "public_cost_performance" ||
    claimGate.scope !== "case_set_only" ||
    claimGate.overallClaimStatus !== "external_evidence_required" ||
    claimGate.detailDisclosure !== "omitted"
  ) {
    blockers.push({
      code: "case_set_claim_gate_malformed",
      message:
        "The private report's no-spend case-set claim-gate disclosure has an unsupported shape.",
      evidence: { caseSetClaimGateStatus: claimGateStatus },
    });
    return;
  }
  if (claimGate.status !== "private_report_constraints_met") {
    blockers.push({
      code: "case_set_claim_gate_blocked",
      message:
        "The private report's no-spend case-set claim gate did not meet public cost-performance constraints.",
      evidence: { caseSetClaimGateStatus: claimGateStatus },
    });
  }
}

function addIntervalClaimGateFindings(
  metrics: PublicEvalMetrics,
  blockers: PublicReportClaimGateFinding[],
): void {
  const fusionDelta = publicMetricValue(
    metrics.confidence_intervals.pass_rate_delta_vs_direct,
    "fusion",
  );
  if (fusionDelta === undefined || fusionDelta === null) {
    blockers.push({
      code: "fusion_pass_rate_delta_interval_unavailable",
      message:
        "Public cost-performance comparison needs a direct-vs-fusion pass-rate delta interval.",
    });
  }
}

function addCostClaimGateFindings(
  metrics: PublicEvalMetrics,
  configs: readonly DeliberationMode[],
  blockers: PublicReportClaimGateFinding[],
): void {
  if (!metrics.cost_latency.available) {
    blockers.push({
      code: "cost_latency_suppressed",
      message:
        "Public cost-performance comparison needs publishable cost and latency metrics.",
      evidence: {
        suppressedReason: metrics.cost_latency.suppressedReason,
        scoredCaseCount: metrics.scored_n,
        minimumScoredCases: metrics.cost_latency.minimumScoredCases,
      },
    });
    return;
  }
  for (const config of configs) {
    const interval = publicMetricValue(
      metrics.cost_latency.cost_per_pass_interval_usd,
      config,
    );
    if (
      !interval ||
      !interval.available ||
      interval.low === null ||
      interval.high === null
    ) {
      blockers.push({
        code: `${config}_cost_per_pass_interval_unavailable`,
        message:
          "Public cost-performance claims need available cost-per-pass intervals for every required public report configuration.",
        evidence: { config },
      });
    }
  }
}

function addPublicReportClaimGateWarnings(
  input: PublicReportClaimGateInput,
  warnings: PublicReportClaimGateFinding[],
): void {
  const scoredTierCounts = input.metrics.grader_evidence.scored_tier_counts;
  if (scoredTierCounts.surface_text > 0 || scoredTierCounts.mixed > 0) {
    warnings.push({
      code: "surface_text_grader_evidence_present",
      message:
        "Surface-text and mixed graders are useful harness checks but can be gamed by token stuffing.",
      evidence: {
        surfaceTextCaseCount: scoredTierCounts.surface_text,
        mixedCaseCount: scoredTierCounts.mixed,
      },
    });
  }
  if (scoredTierCounts.structured_or_exact + scoredTierCounts.mixed > 0) {
    warnings.push({
      code: "mechanical_grader_evidence_present",
      message:
        "Closed-label choice, structured, schema-shape, numeric, citation, and exact graders are mechanical checks, not proof of broad semantic reasoning quality.",
      evidence: {
        structuredOrExactCaseCount: scoredTierCounts.structured_or_exact,
        mixedCaseCount: scoredTierCounts.mixed,
      },
    });
  }
  if (
    input.metrics.fusion_harm_rate !== null &&
    input.metrics.fusion_harm_rate > 0
  ) {
    warnings.push({
      code: "fusion_harm_observed",
      message:
        "Fusion harmed at least one paired scored case-trial and should be discussed with examples in the private audit.",
      evidence: { fusionHarmRate: input.metrics.fusion_harm_rate },
    });
  }
  const directRuntimeFailureRate = combinedRuntimeFailureRate(input, "direct");
  const fusionRuntimeFailureRate = combinedRuntimeFailureRate(input, "fusion");
  if (directRuntimeFailureRate > 0 || fusionRuntimeFailureRate > 0) {
    warnings.push({
      code: "runtime_failures_present",
      message:
        "Runtime failures are present; public claims should distinguish model quality from infrastructure reliability.",
      evidence: {
        directMaxRuntimeFailureRate: directRuntimeFailureRate,
        fusionMaxRuntimeFailureRate: fusionRuntimeFailureRate,
      },
    });
  }
  const directPartialFailureRate = publicMetricValue(
    input.metrics.failure_rates.partial_failure_rate,
    "direct",
  );
  const fusionPartialFailureRate = publicMetricValue(
    input.metrics.failure_rates.partial_failure_rate,
    "fusion",
  );
  if (
    (directPartialFailureRate ?? 0) > 0 ||
    (fusionPartialFailureRate ?? 0) > 0
  ) {
    warnings.push({
      code: "partial_failures_present",
      message:
        "Partial failures are present; degraded fusion results need private audit context.",
      evidence: {
        directPartialFailureRate: directPartialFailureRate ?? 0,
        fusionPartialFailureRate: fusionPartialFailureRate ?? 0,
      },
    });
  }
  if (input.metrics.confidence_intervals.warnings.length > 0) {
    warnings.push({
      code: "bootstrap_warnings_present",
      message:
        "The public report includes bootstrap caveats; do not collapse intervals to point estimates.",
      evidence: {
        warningCount: input.metrics.confidence_intervals.warnings.length,
      },
    });
  }
  const disclosureRecord = asPublicRecord(input.disclosure);
  const reproducibilityLevel = disclosureRecord?.reproducibilityLevel;
  if (reproducibilityLevel === "private-audit-only") {
    warnings.push({
      code: "private_audit_only",
      message:
        "The public report omits model/provider identity, price snapshots, and private reproduction details.",
      evidence: {
        reproducibilityLevel,
      },
    });
  }
  const runProvenance = asPublicRecord(disclosureRecord?.runProvenance);
  if (runProvenance?.status === "private_report_fields_present") {
    warnings.push({
      code: "run_provenance_private_audit_only",
      message:
        "Run provenance is disclosed only as private-report status; public output does not independently prove config or price provenance.",
      evidence: {
        runProvenanceStatus: runProvenance.status,
      },
    });
  }
}

function publicReportDirectionalComparison(
  metrics: PublicEvalMetrics,
): PublicReportDirectionalComparison {
  const fusionDelta = publicMetricValue(
    metrics.confidence_intervals.pass_rate_delta_vs_direct,
    "fusion",
  );
  if (!fusionDelta) {
    return {
      status: "indeterminate",
      basis: "missing_or_unavailable_interval",
      passRateDeltaVsDirect: null,
      notes: [
        "No public direct-vs-fusion pass-rate delta interval is available.",
      ],
    };
  }
  if (fusionDelta.low > 0) {
    return {
      status: "fusion_directionally_better",
      basis: "fusion_pass_rate_delta_ci",
      passRateDeltaVsDirect: fusionDelta,
      notes: [
        "The public pass-rate delta interval is entirely above zero; this is still not claim approval without external evidence.",
      ],
    };
  }
  if (fusionDelta.high < 0) {
    return {
      status: "direct_directionally_better",
      basis: "fusion_pass_rate_delta_ci",
      passRateDeltaVsDirect: fusionDelta,
      notes: [
        "The public pass-rate delta interval is entirely below zero for fusion versus direct.",
      ],
    };
  }
  return {
    status: "no_clear_difference",
    basis: "fusion_pass_rate_delta_ci",
    passRateDeltaVsDirect: fusionDelta,
    notes: [
      "The public pass-rate delta interval crosses zero; do not claim a clear winner.",
    ],
  };
}

function combinedRuntimeFailureRate(
  input: PublicReportClaimGateInput,
  config: DeliberationMode,
): number {
  return Math.max(
    publicMetricValue(
      input.metrics.failure_rates.invalid_output_rate,
      config,
    ) ?? 0,
    publicMetricValue(input.metrics.failure_rates.timeout_rate, config) ?? 0,
    publicMetricValue(
      input.metrics.failure_rates.provider_error_rate,
      config,
    ) ?? 0,
    publicMetricValue(
      input.metrics.failure_rates.budget_exhaustion_rate,
      config,
    ) ?? 0,
    publicMetricValue(
      input.metrics.failure_rates.verification_failure_rate,
      config,
    ) ?? 0,
  );
}

function publicMetricValue<T>(
  values: Partial<Record<DeliberationMode, T>>,
  config: DeliberationMode,
): T | undefined {
  return values[config];
}

function publicMetrics(report: EvalReport): PublicEvalMetrics {
  const configs = publicConfigs(report.configs);
  return {
    n: report.metrics.n,
    scored_n: report.metrics.scored_n,
    trials_per_case: report.metrics.trials_per_case,
    scored_trial_n: report.metrics.scored_trial_n,
    scored_attempt_n: roundRecordForConfigs(
      configs,
      report.metrics.scored_attempt_n,
      0,
    ),
    scored_attempt_coverage: publicScoredAttemptCoverage(report),
    task_pass_rate: roundNullableRecordForConfigs(
      configs,
      report.metrics.task_pass_rate,
      4,
    ),
    fusion_harm_rate: roundNullable(report.metrics.fusion_harm_rate, 4),
    paired_vs_direct: publicPaired(report),
    position_counts: publicPositionCounts(report),
    confidence_intervals: publicConfidenceIntervals(report),
    grader_evidence: publicGraderEvidenceSummary(report.cases),
    by_category: publicCategoryBreakdown(report),
    failure_rates: {
      invalid_output_rate: roundRecordForConfigs(
        configs,
        report.metrics.invalid_output_rate,
        4,
      ),
      timeout_rate: roundRecordForConfigs(
        configs,
        report.metrics.timeout_rate,
        4,
      ),
      provider_error_rate: roundRecordForConfigs(
        configs,
        report.metrics.provider_error_rate,
        4,
      ),
      budget_exhaustion_rate: roundRecordForConfigs(
        configs,
        report.metrics.budget_exhaustion_rate,
        4,
      ),
      partial_failure_rate: roundRecordForConfigs(
        configs,
        report.metrics.partial_failure_rate,
        4,
      ),
      verification_failure_rate: roundRecordForConfigs(
        configs,
        report.metrics.verification_failure_rate,
        4,
      ),
      smoke_completion_rate: roundRecordForConfigs(
        configs,
        report.metrics.smoke_completion_rate,
        4,
      ),
    },
    cost_latency: publicCostLatency(report),
  };
}

function publicScoredAttemptCoverage(
  report: EvalReport,
): PublicEvalMetrics["scored_attempt_coverage"] {
  const configs = publicConfigs(report.configs);
  const scoredCases = report.cases.filter((evalCase) => !evalCase.smokeOnly);
  return Object.fromEntries(
    configs.map((config) => {
      let expected = 0;
      let observed = 0;
      let incomplete = 0;
      for (const evalCase of scoredCases) {
        for (const trial of evalCase.trials) {
          expected += 1;
          const attemptCount = trial.outcomes.filter(
            (outcome) =>
              outcome.configId === config && !outcome.grader.smokeOnly,
          ).length;
          observed += attemptCount;
          if (attemptCount !== 1) incomplete += 1;
        }
      }
      return [
        config,
        {
          expected_scored_case_trial_n: expected,
          observed_scored_attempt_n: observed,
          incomplete_scored_case_trial_n: incomplete,
          complete: expected > 0 && incomplete === 0,
        },
      ];
    }),
  ) as PublicEvalMetrics["scored_attempt_coverage"];
}

function publicPaired(
  report: EvalReport,
): Record<DeliberationMode, PublicPairedComparison> {
  const configs = publicConfigs(report.configs);
  return Object.fromEntries(
    configs.map((config) => {
      const value = report.metrics.paired_vs_direct[config];
      return [
        config,
        {
          paired_n: value.paired_n,
          unpaired_n: value.unpaired_n,
          wins: value.wins,
          losses: value.losses,
          ties: value.ties,
          pass_rate_delta: roundNullable(value.pass_rate_delta, 4),
          harm_rate: roundNullable(value.harm_rate, 4),
        },
      ];
    }),
  ) as Record<DeliberationMode, PublicPairedComparison>;
}

function publicPositionCounts(
  report: EvalReport,
): Record<DeliberationMode, PositionCounts> {
  const configs = publicConfigs(report.configs);
  return Object.fromEntries(
    configs.map((config) => [
      config,
      {
        all: [...report.metrics.position_counts[config].all],
        scored: [...report.metrics.position_counts[config].scored],
      },
    ]),
  ) as Record<DeliberationMode, PositionCounts>;
}

function publicConfidenceIntervals(
  report: EvalReport,
): PublicEvalMetrics["confidence_intervals"] {
  const intervals = report.metrics.confidence_intervals as unknown as Record<
    string,
    unknown
  > &
    EvalReport["metrics"]["confidence_intervals"];
  const configs = publicConfigs(report.configs);
  return {
    method:
      intervals.method === PUBLIC_CONFIDENCE_INTERVAL_METHOD
        ? intervals.method
        : null,
    level:
      intervals.level === PUBLIC_CONFIDENCE_INTERVAL_LEVEL
        ? intervals.level
        : null,
    resamples: publicNonNegativeIntegerCount(intervals.resamples),
    warnings: publicConfidenceIntervalWarnings(intervals.warnings),
    task_pass_rate: roundIntervalRecordForConfigs(
      configs,
      intervals.task_pass_rate,
      4,
    ),
    pass_rate_delta_vs_direct: roundIntervalRecordForConfigs(
      configs,
      intervals.pass_rate_delta_vs_direct,
      4,
    ),
  };
}

function publicConfidenceIntervalWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings.filter(
    (
      warning,
    ): warning is (typeof PUBLIC_CONFIDENCE_INTERVAL_WARNINGS)[number] =>
      typeof warning === "string" &&
      PUBLIC_CONFIDENCE_INTERVAL_WARNINGS.includes(
        warning as (typeof PUBLIC_CONFIDENCE_INTERVAL_WARNINGS)[number],
      ),
  );
}

function publicCategoryBreakdown(report: EvalReport): PublicCategoryBreakdown {
  if (
    report.cases.some((evalCase) => !evalCase.smokeOnly && !evalCase.category)
  ) {
    return suppressedCategoryBreakdown("uncategorized_scored_cases");
  }
  const groups = categoryGroups(report);
  if (groups.length === 0) {
    return suppressedCategoryBreakdown("no_scored_categories");
  }
  if (
    groups.some(
      (group) => scoredCaseCount(group.cases) < MIN_PUBLIC_CATEGORY_CASES,
    )
  ) {
    return suppressedCategoryBreakdown("small_scored_case_count_per_category");
  }
  return {
    available: true,
    categoryIdentity: "generated-order-labels-not-anonymous",
    minimumScoredCasesPerCategory: MIN_PUBLIC_CATEGORY_CASES,
    recommendedScoredCasesPerCategoryForClaims:
      RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
    confidence_intervals: publicCategoryConfidenceIntervalMetadata(report),
    notes: [...PUBLIC_CATEGORY_BREAKDOWN_NOTES],
    categories: groups.map((group, index) =>
      publicCategoryMetric(
        `category_${String(index + 1).padStart(4, "0")}`,
        group.cases,
        report.configs,
        report.evaluationDesign.bootstrapSamples,
      ),
    ),
  };
}

function publicCategoryConfidenceIntervalMetadata(
  report: EvalReport,
): Extract<
  PublicCategoryBreakdown,
  { available: true }
>["confidence_intervals"] {
  const intervals = report.metrics.confidence_intervals as unknown as Record<
    string,
    unknown
  > &
    EvalReport["metrics"]["confidence_intervals"];
  return {
    method:
      intervals.method === PUBLIC_CONFIDENCE_INTERVAL_METHOD
        ? intervals.method
        : null,
    level:
      intervals.level === PUBLIC_CONFIDENCE_INTERVAL_LEVEL
        ? intervals.level
        : null,
    resamples: publicNonNegativeIntegerCount(intervals.resamples),
    metrics: ["task_pass_rate", "pass_rate_delta_vs_direct"],
    scope: "within_category",
  };
}

function suppressedCategoryBreakdown(
  suppressedReason: Extract<
    PublicCategoryBreakdown,
    { available: false }
  >["suppressedReason"],
): PublicCategoryBreakdown {
  return {
    available: false,
    suppressedReason,
    minimumScoredCasesPerCategory: MIN_PUBLIC_CATEGORY_CASES,
    recommendedScoredCasesPerCategoryForClaims:
      RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS,
    categoryIdentity: "generated-order-labels-not-anonymous",
  };
}

function categoryGroups(
  report: EvalReport,
): Array<{ key: string; cases: EvalReport["cases"] }> {
  const groups = new Map<string, EvalReport["cases"]>();
  for (const evalCase of report.cases) {
    if (evalCase.smokeOnly) continue;
    if (!evalCase.category) continue;
    const key = evalCase.category;
    const group = groups.get(key);
    if (group) {
      group.push(evalCase);
    } else {
      groups.set(key, [evalCase]);
    }
  }
  return [...groups.entries()].map(([key, cases]) => ({ key, cases }));
}

function publicCategoryMetric(
  publicCategoryId: string,
  cases: EvalReport["cases"],
  configs: DeliberationMode[],
  bootstrapSamples: number,
): PublicCategoryMetric {
  const scoredOutcomes = cases.flatMap((evalCase) =>
    evalCase.outcomes.filter((outcome) => !outcome.grader.smokeOnly),
  );
  const scoredAttemptN = Object.fromEntries(
    configs.map((config) => [
      config,
      scoredOutcomes.filter((outcome) => outcome.configId === config).length,
    ]),
  ) as Record<DeliberationMode, number>;
  const passedAttemptN = Object.fromEntries(
    configs.map((config) => [
      config,
      scoredOutcomes.filter(
        (outcome) => outcome.configId === config && outcome.passed,
      ).length,
    ]),
  ) as Record<DeliberationMode, number>;
  const taskPassRate = Object.fromEntries(
    configs.map((config) => [
      config,
      scoredAttemptN[config] === 0
        ? null
        : roundNumber(passedAttemptN[config] / scoredAttemptN[config], 4),
    ]),
  ) as Record<DeliberationMode, number | null>;
  const paired = publicCategoryPaired(cases, configs);
  const belowRecommended =
    scoredCaseCount(cases) < RECOMMENDED_CATEGORY_CASES_FOR_CLAIMS;
  return {
    publicCategoryId,
    scored_case_n: scoredCaseCount(cases),
    scored_trial_n: cases.reduce(
      (count, evalCase) => count + evalCase.trials.length,
      0,
    ),
    scored_attempt_n_by_config: scoredAttemptN,
    passed_attempt_n_by_config: passedAttemptN,
    passRateDenominator: "scored_attempts",
    task_pass_rate: taskPassRate,
    task_pass_rate_interval: roundIntervalRecordForConfigs(
      configs,
      taskPassRateBootstrapIntervals(cases, configs, bootstrapSamples),
      4,
    ),
    pass_rate_delta_interval_vs_direct: roundIntervalRecordForConfigs(
      configs,
      passRateDeltaVsDirectBootstrapIntervals(cases, configs, bootstrapSamples),
      4,
    ),
    fusion_harm_rate: paired.fusion?.harm_rate ?? null,
    pairedDenominator: "case_trials",
    paired_vs_direct: paired,
    belowRecommendedScoredCases: belowRecommended,
    claimReadiness: belowRecommended
      ? "exploratory_underpowered"
      : "descriptive_only",
    grader_evidence: publicCategoryGraderEvidence(cases),
    observed_runtime_check_kind_case_counts: observedCheckKindCounts(cases),
  };
}

function publicGraderEvidenceSummary(
  cases: EvalReport["cases"],
): PublicGraderEvidenceSummary {
  const scoredCases = cases.filter((evalCase) => !evalCase.smokeOnly);
  const profile = publicGraderEvidenceProfile(scoredCases);
  return {
    version: GRADER_EVIDENCE_TIER_VERSION,
    tier_counts: graderEvidenceTierCounts(cases),
    scored_tier_counts: profile.tier_counts,
    smoke_only_case_n: cases.length - scoredCases.length,
    dominant_tier: profile.dominant_tier,
    dominant_tier_case_share: profile.dominant_tier_case_share,
    profile_mix: profile.profile_mix,
    small_profile_cell_warning: profile.small_profile_cell_warning,
    minimum_profile_cell_size: profile.minimum_profile_cell_size,
    notes: [...PUBLIC_GRADER_EVIDENCE_NOTES],
  };
}

function publicCategoryGraderEvidence(
  cases: EvalReport["cases"],
): PublicCategoryGraderEvidence {
  return publicGraderEvidenceProfile(cases);
}

function publicGraderEvidenceProfile(
  cases: EvalReport["cases"],
): PublicCategoryGraderEvidence {
  const tierCounts = graderEvidenceTierCounts(cases);
  const caseCount = cases.length;
  const nonZeroCounts = GRADER_EVIDENCE_TIERS.map((tier) => ({
    tier,
    count: tierCounts[tier],
  })).filter(({ count }) => count > 0);
  const topCount = Math.max(0, ...nonZeroCounts.map(({ count }) => count));
  const topTiers = nonZeroCounts
    .filter(({ count }) => count === topCount)
    .map(({ tier }) => tier);

  return {
    version: GRADER_EVIDENCE_TIER_VERSION,
    tier_counts: tierCounts,
    dominant_tier: topTiers.length === 1 ? (topTiers[0] ?? null) : null,
    dominant_tier_case_share:
      caseCount === 0 ? null : roundNumber(topCount / caseCount, 4),
    profile_mix:
      caseCount === 0
        ? "no_scored_cases"
        : nonZeroCounts.length <= 1
          ? "single_tier"
          : "mixed_tiers",
    small_profile_cell_warning: nonZeroCounts.some(
      ({ count }) => count < MIN_PUBLIC_PROFILE_CELL_CASES,
    ),
    minimum_profile_cell_size: MIN_PUBLIC_PROFILE_CELL_CASES,
  };
}

function graderEvidenceTierCounts(
  cases: EvalReport["cases"],
): GraderEvidenceTierCounts {
  const counts = emptyGraderEvidenceTierCounts();
  for (const evalCase of cases) {
    counts[evalCase.graderEvidenceTier] += 1;
  }
  return counts;
}

function publicCategoryPaired(
  cases: EvalReport["cases"],
  configs: DeliberationMode[],
): Record<DeliberationMode, PublicPairedComparison> {
  return Object.fromEntries(
    configs.map((config) => [
      config,
      config === "direct"
        ? emptyPublicPaired()
        : publicCategoryPairedForConfig(cases, config),
    ]),
  ) as Record<DeliberationMode, PublicPairedComparison>;
}

function publicCategoryPairedForConfig(
  cases: EvalReport["cases"],
  config: DeliberationMode,
): PublicPairedComparison {
  let paired = 0;
  let unpaired = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let passDelta = 0;
  for (const evalCase of cases) {
    if (evalCase.smokeOnly) continue;
    for (const trial of evalCase.trials) {
      const direct = trial.outcomes.find(
        (outcome) => outcome.configId === "direct",
      );
      const target = trial.outcomes.find(
        (outcome) => outcome.configId === config,
      );
      if (!direct || !target) {
        unpaired += 1;
        continue;
      }
      paired += 1;
      if (target.passed && !direct.passed) wins += 1;
      else if (!target.passed && direct.passed) losses += 1;
      else ties += 1;
      passDelta += Number(target.passed) - Number(direct.passed);
    }
  }
  return {
    paired_n: paired,
    unpaired_n: unpaired,
    wins,
    losses,
    ties,
    pass_rate_delta: paired === 0 ? null : roundNumber(passDelta / paired, 4),
    harm_rate: paired === 0 ? null : roundNumber(losses / paired, 4),
  };
}

function emptyPublicPaired(): PublicPairedComparison {
  return {
    paired_n: 0,
    unpaired_n: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    pass_rate_delta: null,
    harm_rate: null,
  };
}

function observedCheckKindCounts(
  cases: EvalReport["cases"],
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const evalCase of cases) {
    if (evalCase.smokeOnly) continue;
    const kinds = new Set<string>();
    for (const outcome of evalCase.outcomes) {
      if (outcome.status !== "completed") continue;
      for (const check of outcome.grader.checks) {
        if (check.name === "run_completed") continue;
        kinds.add(publicCheckKind(check.name));
      }
    }
    for (const kind of kinds) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function scoredCaseCount(cases: EvalReport["cases"]): number {
  return cases.filter((evalCase) => !evalCase.smokeOnly).length;
}

function publicCostLatency(
  report: EvalReport,
): PublicEvalMetrics["cost_latency"] {
  if (report.metrics.scored_n < MIN_PUBLIC_COST_LATENCY_CASES) {
    return {
      available: false,
      suppressedReason: "small_scored_case_count",
      minimumScoredCases: MIN_PUBLIC_COST_LATENCY_CASES,
    };
  }
  const configs = publicConfigs(report.configs);
  return {
    available: true,
    precision: {
      costUsdDecimals: COST_DECIMALS,
      latencyMsBucket: LATENCY_BUCKET_MS,
    },
    cost_per_pass_usd: roundNullableRecordForConfigs(
      configs,
      report.metrics.cost_per_pass,
      COST_DECIMALS,
    ),
    cost_per_pass_interval_usd: publicCostPerPassIntervals(report),
    mean_cost_per_scored_attempt_usd: roundNullableRecordForConfigs(
      configs,
      report.metrics.mean_cost_per_scored_attempt,
      COST_DECIMALS,
    ),
    total_cost_usd: roundRecordForConfigs(
      configs,
      report.metrics.total_cost_usd,
      COST_DECIMALS,
    ),
    p50_latency_ms: bucketRecordForConfigs(
      configs,
      report.metrics.p50_latency_ms,
      LATENCY_BUCKET_MS,
    ),
    p95_latency_ms: bucketRecordForConfigs(
      configs,
      report.metrics.p95_latency_ms,
      LATENCY_BUCKET_MS,
    ),
  };
}

function publicCostPerPassIntervals(
  report: EvalReport,
): Record<DeliberationMode, PublicCostPerPassInterval> {
  const configs = publicConfigs(report.configs);
  return Object.fromEntries(
    configs.map((config) => {
      const value = report.metrics.confidence_intervals.cost_per_pass[config];
      return [
        config,
        {
          low: roundNullable(value.low, COST_DECIMALS),
          high: roundNullable(value.high, COST_DECIMALS),
          available: value.available,
          undefinedRate: roundNumber(value.undefinedRate, 4),
        },
      ];
    }),
  ) as Record<DeliberationMode, PublicCostPerPassInterval>;
}

function publicOutcome(outcome: EvalConfigOutcome): PublicEvalOutcome {
  const projected: PublicEvalOutcome = {
    configId: outcome.configId,
    status: outcome.status,
    passed: outcome.passed,
    grader: publicGrader(outcome.grader),
  };
  if (outcome.result?.degraded !== undefined)
    projected.degraded = outcome.result.degraded;
  if (outcome.failure?.status) projected.failureStatus = outcome.failure.status;
  return projected;
}

function publicGrader(grader: GraderResult): PublicGraderSummary {
  const passed = grader.checks.filter((check) => check.passed).length;
  return {
    passed: grader.passed,
    smokeOnly: grader.smokeOnly,
    checkCounts: {
      total: grader.checks.length,
      passed,
      failed: grader.checks.length - passed,
    },
    checks: grader.checks.map((check, index) => ({
      checkIndex: index,
      kind: publicCheckKind(check.name),
      passed: check.passed,
    })),
  };
}

function publicCheckKind(kind: string): string {
  return PUBLIC_CHECK_KINDS.has(kind) ? kind : "other_check";
}

function publicConfigs(configs: DeliberationMode[]): DeliberationMode[] {
  const seen = new Set<DeliberationMode>();
  for (const config of configs) {
    if (!PUBLIC_CONFIGS.has(config)) {
      throw new Error(`Unknown public evaluation config: ${String(config)}`);
    }
    if (seen.has(config)) {
      throw new Error(`Duplicate public evaluation config: ${config}`);
    }
    seen.add(config);
  }
  return [...configs];
}

function roundRecordForConfigs(
  configs: DeliberationMode[],
  values: Record<DeliberationMode, number>,
  decimals: number,
): Record<DeliberationMode, number> {
  return Object.fromEntries(
    configs.map((config) => [config, roundNumber(values[config], decimals)]),
  ) as Record<DeliberationMode, number>;
}

function roundNullableRecordForConfigs(
  configs: DeliberationMode[],
  values: Record<DeliberationMode, number | null>,
  decimals: number,
): Record<DeliberationMode, number | null> {
  return Object.fromEntries(
    configs.map((config) => [config, roundNullable(values[config], decimals)]),
  ) as Record<DeliberationMode, number | null>;
}

function bucketRecordForConfigs(
  configs: DeliberationMode[],
  values: Record<DeliberationMode, number>,
  bucket: number,
): Record<DeliberationMode, number> {
  return Object.fromEntries(
    configs.map((config) => [
      config,
      Math.round(values[config] / bucket) * bucket,
    ]),
  ) as Record<DeliberationMode, number>;
}

function roundNullable(value: number | null, decimals: number): number | null {
  return value === null ? null : roundNumber(value, decimals);
}

function roundIntervalRecordForConfigs(
  configs: DeliberationMode[],
  values: Record<DeliberationMode, ConfidenceInterval | null>,
  decimals: number,
): Record<DeliberationMode, ConfidenceInterval | null> {
  return Object.fromEntries(
    configs.map((config) => {
      const value = values[config];
      return [
        config,
        value === null
          ? null
          : {
              low: roundNumber(value.low, decimals),
              high: roundNumber(value.high, decimals),
            },
      ];
    }),
  ) as Record<DeliberationMode, ConfidenceInterval | null>;
}

function roundNumber(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
