import { createHash, createHmac } from "node:crypto";
import { FrugalFusionError, errorMessage, errorStatus } from "./errors.js";
import { redactSecrets, redactValue } from "./redact.js";
import { matchesSchema } from "./schema.js";
import type {
  DeliberationMode,
  DeliberationRequest,
  DeliberationResult,
  JsonSchemaSubset,
  ModelStatus,
  RetainedDeliberationResult,
  TraceRecord,
} from "./types.js";
import { FrugalFusionOrchestrator } from "./orchestrator.js";
import { normalizeEvalRunProvenance } from "./runProvenance.js";
import type { EvalRunProvenance } from "./runProvenance.js";

type JsonPrimitive = string | number | boolean | null;
type RetainedTextMetadata = NonNullable<
  NonNullable<RetainedDeliberationResult["retention"]>["answer"]
>;

export const GRADER_EVIDENCE_TIER_VERSION = "grader-evidence-tier-v2";
export const GRADER_EVIDENCE_TIERS = [
  "structured_or_exact",
  "surface_text",
  "mixed",
  "smoke_only",
  "ungraded",
] as const;

export type GraderEvidenceTier = (typeof GRADER_EVIDENCE_TIERS)[number];

export const EVAL_CASE_DIFFICULTIES = ["easy", "medium", "hard"] as const;

export type EvalCaseDifficulty = (typeof EVAL_CASE_DIFFICULTIES)[number];

export type EvalCaseDifficultyCounts = Record<EvalCaseDifficulty, number>;

export type GraderKindCounts = {
  exact: number;
  exactNormalized: number;
  mustInclude: number;
  containsAny: number;
  mustNotInclude: number;
  regex: number;
  length: number;
  choice: number;
  json: number;
  number: number;
  citations: number;
};

export type GraderEvidenceTierCounts = Record<GraderEvidenceTier, number>;

export type EvalCase = {
  id: string;
  task: string;
  constraints?: string[];
  category?: string;
  difficulty?: EvalCaseDifficulty;
  smokeOnly?: boolean;
  grader?: {
    exact?: string;
    exactNormalized?: string;
    mustInclude?: string[];
    containsAny?: string[];
    mustNotInclude?: string[];
    regex?: string[];
    minLength?: number;
    maxLength?: number;
    choice?: {
      expected: string;
      allowed: string[];
    };
    json?: {
      requireValid?: boolean;
      requiredPaths?: string[];
      equals?: Record<string, JsonPrimitive>;
      includes?: Record<string, string>;
      arrayMinLength?: Record<string, number>;
      schemaSubset?: JsonSchemaSubset;
    };
    number?: {
      expected?: number;
      tolerance?: number;
      min?: number;
      max?: number;
      extractionRegex?: string;
    };
    citations?: {
      allowedSourceIds: string[];
      requiredSourceIds?: string[];
      minCitedSources?: number;
      requiredClaims?: Array<{
        sourceId: string;
        text: string;
        citationPlacement?: "within_window" | "immediate";
      }>;
    };
  };
};

export type EvalCaseValidationSummary = {
  caseCount: number;
  scoredCaseCount: number;
  smokeOnlyCaseCount: number;
  categoryCounts: Record<string, number>;
  scoredCategoryCounts: Record<string, number>;
  scoredCategoryNonSurfaceGraderEvidenceCounts: Record<string, number>;
  scoredCategoryDifficultyCounts: Record<string, EvalCaseDifficultyCounts>;
  difficultyCounts: EvalCaseDifficultyCounts;
  scoredDifficultyCounts: EvalCaseDifficultyCounts;
  scoredDifficultyNonSurfaceGraderEvidenceCounts: EvalCaseDifficultyCounts;
  scoredCasesMissingDifficultyCount: number;
  smokeOnlyCasesMissingDifficultyCount: number;
  duplicateScoredCaseContentGroupCount: number;
  duplicateScoredCaseContentCaseCount: number;
  nearDuplicateScoredCaseContentPairCount: number;
  nearDuplicateScoredCaseContentCaseCount: number;
  nearDuplicateScoredCaseContentThreshold: number;
  nearDuplicateScoredCaseContentMinUsefulTokenCount: number;
  uncategorizedCaseCount: number;
  scoredUncategorizedCaseCount: number;
  graderKindCounts: GraderKindCounts;
  graderEvidenceTierVersion: typeof GRADER_EVIDENCE_TIER_VERSION;
  graderEvidenceTierCounts: GraderEvidenceTierCounts;
  smokeOnlyCasesWithConfiguredGraderCount: number;
  ignoredSmokeOnlyConfiguredGraderKindCounts: GraderKindCounts;
  ignoredSmokeOnlyConfiguredCheckCount: number;
  totalConfiguredChecks: number;
};

export type EvalCaseValidationOptions = {
  requireScored?: boolean;
};

export type EvalCaseManifestIntendedUse = "dev" | "public_sample" | "holdout";

export type EvalCaseManifestHashMode =
  | { kind: "sha256" }
  | { kind: "hmac-sha256"; key: string };

export type EvalClaimGateTarget = "public_cost_performance";

export type EvalClaimGateManifestHashAlgorithm = "sha256" | "hmac-sha256";

export type EvalClaimGateEvidenceValue =
  | number
  | boolean
  | null
  | EvalCaseManifestIntendedUse
  | EvalClaimGateManifestHashAlgorithm;

export type EvalClaimGateFinding = {
  code: string;
  message: string;
  evidence?: Record<string, EvalClaimGateEvidenceValue>;
};

export type EvalClaimGateExternalEvidence = {
  code: string;
  message: string;
};

export type EvalClaimGateAssessment = {
  target: EvalClaimGateTarget;
  scope: "case_set_only";
  status: "case_set_blocked" | "case_set_constraints_met";
  overallClaimStatus: "external_evidence_required";
  minimums: {
    scoredCases: number;
    scoredCasesPerCategory: number;
    scoredCasesPerDifficulty: number;
    nonSurfaceGraderEvidenceCases: number;
    nonSurfaceGraderEvidenceCasesPerDifficulty: number;
    nonSurfaceGraderEvidenceCasesPerCategory: number;
    scoredCasesPerCategoryDifficulty: number;
  };
  manifest: {
    required: true;
    requested: boolean;
    hashAlgorithm: EvalClaimGateManifestHashAlgorithm | null;
  };
  categoryEvidence: {
    scoredCategoryCount: number;
    minScoredCasesPerCategory: number;
    maxScoredCasesPerCategory: number;
    scoredUncategorizedCaseCount: number;
  };
  categoryGraderEvidence: {
    claimEligibleCategoryCount: number;
    minNonSurfaceGraderEvidenceCasesPerCategory: number;
    underpoweredClaimEligibleCategoryCount: number;
  };
  categoryDifficultyCoverage: {
    claimEligibleCategoryCount: number;
    minScoredCasesPerCategoryDifficulty: number;
    underpoweredCategoryDifficultyCellCount: number;
  };
  difficultyCoverage: {
    scoredCasesMissingDifficultyCount: number;
    minScoredCasesPerDifficulty: number;
    maxScoredCasesPerDifficulty: number;
    underpoweredDifficultyCount: number;
  };
  difficultyGraderEvidence: {
    minNonSurfaceGraderEvidenceCasesPerDifficulty: number;
    underpoweredDifficultyCount: number;
  };
  graderEvidenceProfile: {
    version: typeof GRADER_EVIDENCE_TIER_VERSION;
    tierCounts: GraderEvidenceTierCounts;
  };
  blockers: EvalClaimGateFinding[];
  warnings: EvalClaimGateFinding[];
  externalEvidenceRequired: EvalClaimGateExternalEvidence[];
};

export type EvalClaimGateAssessmentOptions = {
  target?: EvalClaimGateTarget;
  intendedUse: EvalCaseManifestIntendedUse;
} & (
  | {
      manifestRequested: true;
      manifestHashAlgorithm: EvalClaimGateManifestHashAlgorithm;
    }
  | {
      manifestRequested: false;
      manifestHashAlgorithm?: never;
    }
);

export type ParsedEvalCaseRow = {
  line: number;
  rawLine: string;
  case: EvalCase;
};

type EvalCaseSetManifestBase = {
  schemaVersion: "frugal-fusion-case-set-manifest-v4";
  fingerprintVersion: "case-set-canonical-v3";
  intendedUse: EvalCaseManifestIntendedUse;
  summary: {
    caseCount: number;
    scoredCaseCount: number;
    smokeOnlyCaseCount: number;
    categoryBalance: {
      categoryCount: number;
      minCasesPerCategory: number;
      maxCasesPerCategory: number;
      uncategorizedCaseCount: number;
    };
    scoredCategoryBalance: {
      categoryCount: number;
      minScoredCasesPerCategory: number;
      maxScoredCasesPerCategory: number;
      scoredUncategorizedCaseCount: number;
    };
    difficultyCoverage: {
      difficultyCounts: EvalCaseDifficultyCounts;
      scoredDifficultyCounts: EvalCaseDifficultyCounts;
      scoredCasesMissingDifficultyCount: number;
      smokeOnlyCasesMissingDifficultyCount: number;
    };
    categoryCounts?: Record<string, number>;
    scoredCategoryCounts?: Record<string, number>;
    scoredCategoryNonSurfaceGraderEvidenceCounts?: Record<string, number>;
    casesWithGraderKind: EvalCaseValidationSummary["graderKindCounts"];
    graderEvidence: {
      version: typeof GRADER_EVIDENCE_TIER_VERSION;
      tierCounts: GraderEvidenceTierCounts;
      smokeOnlyCasesWithConfiguredGraderCount: number;
      ignoredSmokeOnlyConfiguredGraderKindCounts: GraderKindCounts;
      ignoredSmokeOnlyConfiguredCheckCount: number;
    };
    totalConfiguredChecks: number;
  };
  claimReadiness: {
    status: "not_claim_ready" | "requires_private_audit";
    warnings: string[];
  };
};

type Sha256ManifestRow = {
  line: number;
  publicId: string;
  id?: string;
  category?: string;
  smokeOnly: boolean;
  graderKinds: string[];
  ignoredSmokeOnlyGraderKinds?: string[];
  graderEvidenceTier: GraderEvidenceTier;
  canonicalRowSha256: string;
  canonicalRowHmacSha256?: never;
  rawLineSha256?: string;
  rawLineHmacSha256?: never;
};

type HmacManifestRow = {
  line: number;
  publicId: string;
  id?: never;
  category?: never;
  smokeOnly: boolean;
  graderKinds: string[];
  ignoredSmokeOnlyGraderKinds?: string[];
  graderEvidenceTier: GraderEvidenceTier;
  canonicalRowSha256?: never;
  canonicalRowHmacSha256: string;
  rawLineSha256?: never;
  rawLineHmacSha256?: string;
};

export type Sha256EvalCaseSetManifest = EvalCaseSetManifestBase & {
  source: {
    path?: string;
    rawFileSha256?: string;
    rawFileHmacSha256?: never;
  };
  fingerprint: {
    algorithm: "sha256";
    canonicalization: "json-sorted-v1";
    content: "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1";
    canonicalSha256: string;
    canonicalHmacSha256?: never;
  };
  privacy: {
    includesCaseIds: boolean;
    includesCategoryLabels: boolean;
    rowHashesCanLinkPublicCases: boolean;
    rowHashesIncludeGraderValues: boolean;
    rowHashesAreUnsalted: true;
    rowHashesAreKeyed?: never;
    hashPrivacy?: never;
    structuralMetadataVisible?: never;
  };
  rows: Sha256ManifestRow[];
};

export type HmacEvalCaseSetManifest = EvalCaseSetManifestBase & {
  source: {
    path?: never;
    rawFileSha256?: never;
    rawFileHmacSha256?: string;
  };
  fingerprint: {
    algorithm: "hmac-sha256";
    canonicalization: "json-sorted-v1";
    content: "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1";
    canonicalSha256?: never;
    canonicalHmacSha256: string;
  };
  privacy: {
    includesCaseIds: false;
    includesCategoryLabels: false;
    rowHashesCanLinkPublicCases: false;
    rowHashesIncludeGraderValues: true;
    rowHashesAreUnsalted: false;
    rowHashesAreKeyed: true;
    hashPrivacy: "private_audit_hmac_sha256";
    structuralMetadataVisible: true;
  };
  rows: HmacManifestRow[];
};

export type EvalCaseSetManifest =
  | Sha256EvalCaseSetManifest
  | HmacEvalCaseSetManifest;

export type EvalCaseSetManifestBinding =
  | {
      status: "verified";
      schemaVersion: EvalCaseSetManifest["schemaVersion"];
      fingerprintVersion: EvalCaseSetManifest["fingerprintVersion"];
      canonicalization: EvalCaseSetManifest["fingerprint"]["canonicalization"];
      content: EvalCaseSetManifest["fingerprint"]["content"];
      intendedUse: EvalCaseManifestIntendedUse;
      hashAlgorithm: "sha256";
      privacyClass: "public_or_frozen_sha256";
      digestSha256: string;
      digestHmacSha256?: never;
      digestDisclosure: "private_report_only";
      verifiedAt: string;
    }
  | {
      status: "verified";
      schemaVersion: EvalCaseSetManifest["schemaVersion"];
      fingerprintVersion: EvalCaseSetManifest["fingerprintVersion"];
      canonicalization: EvalCaseSetManifest["fingerprint"]["canonicalization"];
      content: EvalCaseSetManifest["fingerprint"]["content"];
      intendedUse: EvalCaseManifestIntendedUse;
      hashAlgorithm: "hmac-sha256";
      privacyClass: "private_audit_hmac_sha256";
      digestSha256?: never;
      digestHmacSha256: string;
      digestDisclosure: "private_report_only";
      verifiedAt: string;
    };

export type EvalCaseSetManifestOptions = {
  sourcePath?: string;
  rawFileSha256?: string;
  intendedUse?: EvalCaseManifestIntendedUse;
  includeCaseIds?: boolean;
  includeCategoryLabels?: boolean;
  hashMode?: EvalCaseManifestHashMode;
  rows?: ParsedEvalCaseRow[];
  rawFileHmacSha256?: string;
};

export type GraderResult = {
  passed: boolean;
  smokeOnly: boolean;
  checks: Array<{ name: string; passed: boolean; details?: string }>;
};

export type EvalConfigOutcome = {
  configId: DeliberationMode;
  trialIndex: number;
  status: "completed" | "failed";
  passed: boolean;
  grader: GraderResult;
  executionOrder: number;
  result?: RetainedDeliberationResult;
  failure?: {
    status: ModelStatus;
    message: string;
    usage?: DeliberationResult["usage"];
    failures?: DeliberationResult["failures"];
    callTrace?: NonNullable<DeliberationResult["metadata"]["callTrace"]>;
  };
};

export type EvalTrialResult = {
  trialIndex: number;
  executionSchedule: DeliberationMode[];
  outcomes: EvalConfigOutcome[];
  fusionHarm: boolean;
};

export type ConfidenceInterval = {
  low: number;
  high: number;
};

export type CostPerPassInterval = {
  low: number | null;
  high: number | null;
  available: boolean;
  zeroPassResamples: number;
  undefinedRate: number;
};

export type PairedComparison = {
  paired_n: number;
  unpaired_n: number;
  wins: number;
  losses: number;
  ties: number;
  pass_rate_delta: number | null;
  mean_cost_delta_usd: number | null;
  incremental_cost_per_additional_pass: number | null;
  harm_rate: number | null;
};

export type PositionCounts = {
  all: number[];
  scored: number[];
};

export type EvalCaseResult = {
  id: string;
  caseIndex: number;
  category?: string;
  smokeOnly: boolean;
  graderEvidenceTier: GraderEvidenceTier;
  executionSchedule: DeliberationMode[];
  trials: EvalTrialResult[];
  outcomes: EvalConfigOutcome[];
  fusionHarm: boolean;
};

export type EvalReport = {
  runId: string;
  caseSetHash: string | null;
  caseSetManifestBinding?: EvalCaseSetManifestBinding;
  caseSetClaimGate?: EvalClaimGateAssessment;
  runProvenance?: EvalRunProvenance;
  startedAt: string;
  finishedAt: string;
  evaluationDesign: {
    trialsPerCase: number;
    schedule: "case-trial-rotation-v1";
    bootstrapSamples: number;
    confidenceLevel: 0.95;
  };
  configs: DeliberationMode[];
  cases: EvalCaseResult[];
  metrics: {
    n: number;
    scored_n: number;
    trials_per_case: number;
    scored_trial_n: number;
    scored_attempt_n: Record<DeliberationMode, number>;
    task_pass_rate: Record<DeliberationMode, number | null>;
    cost_per_pass: Record<DeliberationMode, number | null>;
    mean_cost_per_scored_attempt: Record<DeliberationMode, number | null>;
    total_cost_usd: Record<DeliberationMode, number>;
    p50_latency_ms: Record<DeliberationMode, number>;
    p95_latency_ms: Record<DeliberationMode, number>;
    fusion_harm_rate: number | null;
    paired_vs_direct: Record<DeliberationMode, PairedComparison>;
    position_counts: Record<DeliberationMode, PositionCounts>;
    confidence_intervals: {
      method: "case_cluster_bootstrap";
      level: 0.95;
      resamples: number;
      warnings: string[];
      task_pass_rate: Record<DeliberationMode, ConfidenceInterval | null>;
      cost_per_pass: Record<DeliberationMode, CostPerPassInterval>;
      pass_rate_delta_vs_direct: Record<
        DeliberationMode,
        ConfidenceInterval | null
      >;
    };
    invalid_output_rate: Record<DeliberationMode, number>;
    timeout_rate: Record<DeliberationMode, number>;
    provider_error_rate: Record<DeliberationMode, number>;
    budget_exhaustion_rate: Record<DeliberationMode, number>;
    partial_failure_rate: Record<DeliberationMode, number>;
    verification_failure_rate: Record<DeliberationMode, number>;
    smoke_completion_rate: Record<DeliberationMode, number>;
  };
  traces: TraceRecord[];
};

export type EvaluationOptions = {
  configs?: DeliberationMode[];
  trialsPerCase?: number;
  bootstrapSamples?: number;
  retainRawPrompt?: boolean;
  retainOutputs?: boolean;
  retainProviderIds?: boolean;
  retainFailureDetails?: boolean;
  caseSetManifestBinding?: EvalCaseSetManifestBinding;
  runProvenance?: EvalRunProvenance;
};

const ALL_CONFIGS: DeliberationMode[] = [
  "direct",
  "self_review",
  "repeated",
  "fusion",
];

const VALID_CONFIGS = new Set<DeliberationMode>(ALL_CONFIGS);

const DEFAULT_CONFIGS: DeliberationMode[] = [...ALL_CONFIGS];

const MAX_GRADED_ANSWER_CHARS = 20_000;
const MAX_GRADER_CHECKS = 50;
const MAX_GRADER_TERM_CHARS = 200;
const MAX_CHOICES = 50;
const MAX_REGEX_CHARS = 200;
const MAX_JSON_NODES = 2_000;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_STRING_CHARS = 10_000;
const MAX_JSON_PATH_CHARS = 120;
const MAX_JSON_PATH_SEGMENTS = 12;
const MAX_JSON_ARRAY_INDEX = 1_000;
const MAX_SCHEMA_SUBSET_DEPTH = 10;
const MAX_SCHEMA_SUBSET_NODES = 200;
const MAX_SCHEMA_SUBSET_PROPERTIES = 100;
const MAX_SCHEMA_SUBSET_ENUM_VALUES = 50;
const MAX_RETAINED_OUTPUT_CHARS = 10_000;
const MAX_CITATION_SOURCE_IDS = 50;
const MAX_CITATION_REQUIRED_CLAIMS = 25;
const CITATION_CLAIM_WINDOW_CHARS = 160;
const CITATION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const NUMBER_TEXT_PATTERN =
  "[+-]?(?:(?:\\d+\\.?\\d*)|(?:\\.\\d+))(?:[eE][+-]?\\d+)?";
const NUMBER_TEXT_REGEX = new RegExp(NUMBER_TEXT_PATTERN);
const ANCHORED_NUMBER_TEXT_REGEX = new RegExp(`^${NUMBER_TEXT_PATTERN}$`);
const MANIFEST_HMAC_DOMAIN = "frugal-fusion-manifest-hmac-v1";
const MIN_MANIFEST_HMAC_KEY_BYTES = 32;
const PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES = 100;
const PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY = 30;
const PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_DIFFICULTY = 30;
const PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY_DIFFICULTY = 5;
const PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES = 5;
const PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_DIFFICULTY = 5;
const PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY = 5;
const PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.9;
const PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_MIN_USEFUL_TOKENS = 12;

type ManifestDigestPurpose =
  | "raw-file"
  | "canonical-case-set"
  | "canonical-row"
  | "raw-line";

type ManifestDigestStrategy = {
  algorithm: "sha256" | "hmac-sha256";
  digest(text: string, purpose: ManifestDigestPurpose): string;
};

export async function runEvaluation(
  cases: EvalCase[],
  orchestrator: FrugalFusionOrchestrator,
  budget: DeliberationRequest["budget"],
  options: EvaluationOptions = {},
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const caseValidationSummary = validateEvalCases(cases);
  const configs = validateConfigs(options.configs ?? DEFAULT_CONFIGS);
  const runProvenance = normalizeRunProvenance(options.runProvenance, configs);
  const trialsPerCase = validatePositiveIntegerOption(
    options.trialsPerCase ?? 1,
    "trialsPerCase",
    100,
  );
  const bootstrapSamples = validatePositiveIntegerOption(
    options.bootstrapSamples ?? 500,
    "bootstrapSamples",
    10_000,
  );
  const caseSetManifestBinding = options.caseSetManifestBinding;
  const caseSetClaimGate = deriveCaseSetClaimGate(
    caseValidationSummary,
    caseSetManifestBinding,
    options,
  );
  const caseSetHash =
    caseSetManifestBinding?.hashAlgorithm === "hmac-sha256"
      ? null
      : hashCaseSet(cases);
  const runCaseSetIdentity =
    caseSetManifestBinding?.hashAlgorithm === "hmac-sha256"
      ? caseSetManifestBinding.digestHmacSha256
      : (caseSetHash ?? hashCaseSet(cases));
  const evaluationDesign: EvalReport["evaluationDesign"] = {
    trialsPerCase,
    schedule: "case-trial-rotation-v1",
    bootstrapSamples,
    confidenceLevel: 0.95,
  };
  const runId = hashText(
    `${startedAt}:${runCaseSetIdentity}:${configs.join(",")}:${trialsPerCase}:${bootstrapSamples}:${evaluationDesign.schedule}`,
  );
  const results: EvalCaseResult[] = [];
  const traces: TraceRecord[] = [];

  for (const [caseIndex, evalCase] of cases.entries()) {
    const trialResults: EvalTrialResult[] = [];
    const flatOutcomes: EvalConfigOutcome[] = [];
    for (let trialIndex = 0; trialIndex < trialsPerCase; trialIndex += 1) {
      const order = counterbalancedOrder(
        configs,
        caseIndex,
        trialIndex,
        trialsPerCase,
      );
      const outcomes: EvalConfigOutcome[] = [];
      for (const [executionOrder, configId] of order.entries()) {
        const request = buildRequest(
          evalCase,
          configId,
          budget,
          modelInputSeedMaterial(evalCase),
          trialIndex,
        );
        const traceStarted = new Date().toISOString();
        const outcome = await runOne({
          evalCase,
          configId,
          request,
          orchestrator,
          executionOrder,
          trialIndex,
          options,
        });
        outcomes.push(outcome);
        traces.push(
          trace(evalCase.id, configId, request, outcome, traceStarted, options),
        );
      }
      const sortedOutcomes = sortOutcomes(outcomes, configs);
      const fusionHarm = trialFusionHarm(evalCase, sortedOutcomes);
      trialResults.push({
        trialIndex,
        executionSchedule: order,
        outcomes: sortedOutcomes,
        fusionHarm,
      });
      flatOutcomes.push(...sortedOutcomes);
    }
    const caseResult: EvalCaseResult = {
      id: evalCase.id,
      caseIndex,
      smokeOnly: Boolean(evalCase.smokeOnly),
      graderEvidenceTier: caseGraderEvidenceTier(evalCase),
      executionSchedule: trialResults[0]?.executionSchedule ?? [],
      trials: trialResults,
      outcomes: flatOutcomes,
      fusionHarm: trialResults.some((trial) => trial.fusionHarm),
    };
    if (evalCase.category) caseResult.category = evalCase.category;
    results.push(caseResult);
  }

  return {
    runId,
    caseSetHash,
    ...(caseSetManifestBinding === undefined ? {} : { caseSetManifestBinding }),
    ...(caseSetClaimGate === undefined ? {} : { caseSetClaimGate }),
    ...(runProvenance === undefined ? {} : { runProvenance }),
    startedAt,
    finishedAt: new Date().toISOString(),
    evaluationDesign,
    configs,
    cases: results,
    metrics: metrics(results, configs, evaluationDesign),
    traces,
  };
}

function deriveCaseSetClaimGate(
  summary: EvalCaseValidationSummary,
  binding: EvalCaseSetManifestBinding | undefined,
  options: EvaluationOptions,
): EvalClaimGateAssessment | undefined {
  if (Object.prototype.hasOwnProperty.call(options, "caseSetClaimGate")) {
    throw new Error(
      "caseSetClaimGate is derived from the verified caseSetManifestBinding and current cases",
    );
  }
  if (binding === undefined) {
    return undefined;
  }
  return assessEvalClaimGate(summary, {
    intendedUse: binding.intendedUse,
    manifestRequested: true,
    manifestHashAlgorithm: binding.hashAlgorithm,
  });
}

function normalizeRunProvenance(
  provenance: EvalRunProvenance | undefined,
  configs: DeliberationMode[],
): EvalRunProvenance | undefined {
  if (provenance === undefined) return undefined;
  const normalized = normalizeEvalRunProvenance(provenance);
  if (!sameStringList(normalized.evaluatedConfigs, configs)) {
    throw new Error(
      "runProvenance.evaluatedConfigs must match evaluation configs",
    );
  }
  return normalized;
}

function sameStringList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

export function parseJsonlCaseRows(text: string): ParsedEvalCaseRow[] {
  const rows: ParsedEvalCaseRow[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push({
        line: index + 1,
        rawLine: line,
        case: JSON.parse(line) as EvalCase,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSONL at line ${index + 1}: ${reason}`);
    }
  }
  return rows;
}

export function parseJsonlCases(text: string): EvalCase[] {
  return parseJsonlCaseRows(text).map((row) => row.case);
}

export function validateEvalCases(
  cases: EvalCase[],
  options: EvalCaseValidationOptions = {},
): EvalCaseValidationSummary {
  validateCases(cases);
  const summary = summarizeEvalCases(cases);
  if (options.requireScored && summary.scoredCaseCount === 0) {
    throw new Error("Evaluation needs at least one scored case");
  }
  return summary;
}

export function parseEvalCaseSetManifest(text: string): EvalCaseSetManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw manifestBindingError("invalid_manifest_json");
  }
  validateParsedCaseSetManifest(parsed);
  return parsed;
}

export function verifyCaseSetManifestBinding(
  cases: EvalCase[],
  manifestText: string,
  options: { hmacKey?: string; verifiedAt?: string } = {},
): EvalCaseSetManifestBinding {
  const manifest = parseEvalCaseSetManifest(manifestText);
  const verifiedAt = options.verifiedAt ?? new Date().toISOString();
  if (manifest.fingerprint.algorithm === "hmac-sha256") {
    if (options.hmacKey === undefined) {
      throw manifestBindingError("hmac_key_required");
    }
    const digest = caseSetCanonicalManifestDigest(
      cases,
      {
        kind: "hmac-sha256",
        key: options.hmacKey,
      },
      manifest.intendedUse,
    );
    if (digest !== manifest.fingerprint.canonicalHmacSha256) {
      throw manifestBindingError("digest_mismatch");
    }
    return {
      status: "verified",
      schemaVersion: manifest.schemaVersion,
      fingerprintVersion: manifest.fingerprintVersion,
      canonicalization: manifest.fingerprint.canonicalization,
      content: manifest.fingerprint.content,
      intendedUse: manifest.intendedUse,
      hashAlgorithm: "hmac-sha256",
      privacyClass: "private_audit_hmac_sha256",
      digestHmacSha256: digest,
      digestDisclosure: "private_report_only",
      verifiedAt,
    };
  }

  if (options.hmacKey !== undefined) {
    throw manifestBindingError("hmac_key_not_allowed_for_sha256_manifest");
  }
  if (manifest.intendedUse === "holdout") {
    throw manifestBindingError("sha256_holdout_manifest_rejected");
  }
  const digest = caseSetCanonicalManifestDigest(
    cases,
    { kind: "sha256" },
    manifest.intendedUse,
  );
  if (digest !== manifest.fingerprint.canonicalSha256) {
    throw manifestBindingError("digest_mismatch");
  }
  return {
    status: "verified",
    schemaVersion: manifest.schemaVersion,
    fingerprintVersion: manifest.fingerprintVersion,
    canonicalization: manifest.fingerprint.canonicalization,
    content: manifest.fingerprint.content,
    intendedUse: manifest.intendedUse,
    hashAlgorithm: "sha256",
    privacyClass: "public_or_frozen_sha256",
    digestSha256: digest,
    digestDisclosure: "private_report_only",
    verifiedAt,
  };
}

export function assessEvalClaimGate(
  summary: EvalCaseValidationSummary,
  options: EvalClaimGateAssessmentOptions,
): EvalClaimGateAssessment {
  const target = options.target ?? "public_cost_performance";
  if (target !== "public_cost_performance") {
    throw new Error(`Unsupported claim gate target: ${String(target)}`);
  }
  const scoredCategoryCounts = Object.values(summary.scoredCategoryCounts);
  const minScoredCasesPerCategory =
    scoredCategoryCounts.length > 0 ? Math.min(...scoredCategoryCounts) : 0;
  const maxScoredCasesPerCategory =
    scoredCategoryCounts.length > 0 ? Math.max(...scoredCategoryCounts) : 0;
  const underpoweredCategoryCount = scoredCategoryCounts.filter(
    (count) => count < PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY,
  ).length;
  const claimEligibleCategoryEntries = Object.entries(
    summary.scoredCategoryCounts,
  ).filter(
    ([, count]) =>
      count >= PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY,
  );
  const claimEligibleCategoryNonSurfaceCounts =
    claimEligibleCategoryEntries.map(
      ([category]) =>
        summary.scoredCategoryNonSurfaceGraderEvidenceCounts[category] ?? 0,
    );
  const underpoweredNonSurfaceGraderEvidenceCategoryCount =
    claimEligibleCategoryNonSurfaceCounts.filter(
      (count) =>
        count <
        PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY,
    ).length;
  const minNonSurfaceGraderEvidenceCasesPerCategory =
    claimEligibleCategoryNonSurfaceCounts.length > 0
      ? Math.min(...claimEligibleCategoryNonSurfaceCounts)
      : 0;
  const claimEligibleCategoryDifficultyCounts =
    claimEligibleCategoryEntries.flatMap(([category]) =>
      EVAL_CASE_DIFFICULTIES.map(
        (difficulty) =>
          summary.scoredCategoryDifficultyCounts[category]?.[difficulty] ?? 0,
      ),
    );
  const underpoweredCategoryDifficultyCellCount =
    claimEligibleCategoryDifficultyCounts.filter(
      (count) =>
        count <
        PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY_DIFFICULTY,
    ).length;
  const minScoredCasesPerCategoryDifficulty =
    claimEligibleCategoryDifficultyCounts.length > 0
      ? Math.min(...claimEligibleCategoryDifficultyCounts)
      : 0;
  const scoredDifficultyCounts = EVAL_CASE_DIFFICULTIES.map(
    (difficulty) => summary.scoredDifficultyCounts[difficulty],
  );
  const minScoredCasesPerDifficulty =
    scoredDifficultyCounts.length > 0 ? Math.min(...scoredDifficultyCounts) : 0;
  const maxScoredCasesPerDifficulty =
    scoredDifficultyCounts.length > 0 ? Math.max(...scoredDifficultyCounts) : 0;
  const underpoweredDifficultyCount = scoredDifficultyCounts.filter(
    (count) => count < PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_DIFFICULTY,
  ).length;
  const scoredDifficultyNonSurfaceGraderEvidenceCounts =
    EVAL_CASE_DIFFICULTIES.map(
      (difficulty) =>
        summary.scoredDifficultyNonSurfaceGraderEvidenceCounts[difficulty],
    );
  const minNonSurfaceGraderEvidenceCasesPerDifficulty =
    scoredDifficultyNonSurfaceGraderEvidenceCounts.length > 0
      ? Math.min(...scoredDifficultyNonSurfaceGraderEvidenceCounts)
      : 0;
  const underpoweredNonSurfaceGraderEvidenceDifficultyCount =
    scoredDifficultyNonSurfaceGraderEvidenceCounts.filter(
      (count) =>
        count <
        PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_DIFFICULTY,
    ).length;
  const manifestHashAlgorithm = options.manifestRequested
    ? (options.manifestHashAlgorithm ?? null)
    : null;
  const blockers: EvalClaimGateFinding[] = [];
  const warnings: EvalClaimGateFinding[] = [
    {
      code: "no_spend_case_set_only",
      message:
        "This gate checks only case-set hygiene before spend; it cannot approve public performance claims, model outputs, pricing, or tuning isolation.",
    },
  ];

  if (options.intendedUse !== "holdout") {
    blockers.push({
      code: "not_holdout",
      message:
        "Public cost-performance claims require a case set marked as an unused holdout.",
      evidence: { intendedUse: options.intendedUse },
    });
  }
  if (!options.manifestRequested) {
    blockers.push({
      code: "manifest_absent_for_this_assessment",
      message:
        "Public cost-performance claims require a frozen case manifest; this assessment did not request one.",
      evidence: { manifestRequested: false },
    });
  }
  if (options.manifestRequested && manifestHashAlgorithm === null) {
    blockers.push({
      code: "manifest_hash_algorithm_unknown",
      message:
        "The claim gate needs the manifest hash algorithm for auditability warnings.",
    });
  }
  if (manifestHashAlgorithm === "sha256" && options.intendedUse === "holdout") {
    blockers.push({
      code: "holdout_manifest_requires_hmac",
      message:
        "Private holdout claim gates require an HMAC manifest so row hashes do not expose unsalted prompt or grader-value linkability.",
      evidence: { manifestHashAlgorithm },
    });
  }
  if (summary.scoredCaseCount < PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES) {
    blockers.push({
      code: "too_few_scored_cases",
      message:
        "The case set has too few scored cases for public cost-performance claims from this harness.",
      evidence: {
        scoredCaseCount: summary.scoredCaseCount,
        requiredScoredCases: PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES,
      },
    });
  }
  if (scoredCategoryCounts.length === 0) {
    blockers.push({
      code: "no_scored_categories",
      message:
        "Public cost-performance claims need scored categories for stratified failure analysis.",
      evidence: { scoredCategoryCount: 0 },
    });
  }
  if (summary.scoredUncategorizedCaseCount > 0) {
    blockers.push({
      code: "uncategorized_scored_cases",
      message:
        "All scored cases need categories before public cost-performance claims.",
      evidence: {
        scoredUncategorizedCaseCount: summary.scoredUncategorizedCaseCount,
      },
    });
  }
  if (underpoweredCategoryCount > 0) {
    blockers.push({
      code: "category_underpowered",
      message:
        "Every scored category needs the minimum case count before category-level public claims.",
      evidence: {
        underpoweredCategoryCount,
        minScoredCasesPerCategory,
        requiredScoredCasesPerCategory:
          PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY,
      },
    });
  }
  if (summary.scoredCasesMissingDifficultyCount > 0) {
    blockers.push({
      code: "missing_scored_case_difficulty",
      message:
        "Every scored case needs closed-enum difficulty metadata before public cost-performance claims.",
      evidence: {
        scoredCasesMissingDifficultyCount:
          summary.scoredCasesMissingDifficultyCount,
      },
    });
  }
  if (underpoweredDifficultyCount > 0) {
    blockers.push({
      code: "difficulty_underpowered",
      message:
        "Every difficulty bucket needs the minimum scored case count before public cost-performance claims.",
      evidence: {
        underpoweredDifficultyCount,
        minScoredCasesPerDifficulty,
        requiredScoredCasesPerDifficulty:
          PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_DIFFICULTY,
      },
    });
  }
  if (
    summary.scoredCasesMissingDifficultyCount === 0 &&
    underpoweredDifficultyCount === 0 &&
    underpoweredCategoryDifficultyCellCount > 0
  ) {
    blockers.push({
      code: "category_difficulty_coverage_underpowered",
      message:
        "Every claim-eligible scored category needs minimum scored-case coverage in each closed-enum difficulty bucket before public cost-performance claims.",
      evidence: {
        claimEligibleCategoryCount: claimEligibleCategoryEntries.length,
        underpoweredCategoryDifficultyCellCount,
        minScoredCasesPerCategoryDifficulty,
        requiredScoredCasesPerCategoryDifficulty:
          PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY_DIFFICULTY,
      },
    });
  }
  if (summary.graderEvidenceTierCounts.ungraded > 0) {
    blockers.push({
      code: "ungraded_scored_cases",
      message:
        "Scored cases must have deterministic grader evidence; this is a defensive invariant.",
      evidence: {
        ungradedCaseCount: summary.graderEvidenceTierCounts.ungraded,
      },
    });
  }
  const nonSurfaceGraderEvidenceCaseCount =
    summary.graderEvidenceTierCounts.structured_or_exact +
    summary.graderEvidenceTierCounts.mixed;
  if (
    summary.scoredCaseCount > 0 &&
    nonSurfaceGraderEvidenceCaseCount <
      PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES
  ) {
    blockers.push({
      code: "insufficient_non_surface_grader_evidence",
      message:
        "Public cost-performance claims need a minimum scored evidence cell beyond surface-text-only grader checks.",
      evidence: {
        scoredCaseCount: summary.scoredCaseCount,
        surfaceTextCaseCount: summary.graderEvidenceTierCounts.surface_text,
        mixedCaseCount: summary.graderEvidenceTierCounts.mixed,
        structuredOrExactCaseCount:
          summary.graderEvidenceTierCounts.structured_or_exact,
        nonSurfaceGraderEvidenceCaseCount,
        requiredNonSurfaceGraderEvidenceCases:
          PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES,
      },
    });
  }
  if (
    summary.scoredCasesMissingDifficultyCount === 0 &&
    underpoweredDifficultyCount === 0 &&
    underpoweredNonSurfaceGraderEvidenceDifficultyCount > 0
  ) {
    blockers.push({
      code: "difficulty_non_surface_grader_evidence_underpowered",
      message:
        "Every difficulty bucket needs the minimum non-surface grader-evidence cell before public cost-performance claims.",
      evidence: {
        underpoweredDifficultyCount:
          underpoweredNonSurfaceGraderEvidenceDifficultyCount,
        minNonSurfaceGraderEvidenceCasesPerDifficulty,
        requiredNonSurfaceGraderEvidenceCasesPerDifficulty:
          PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_DIFFICULTY,
      },
    });
  }
  if (underpoweredNonSurfaceGraderEvidenceCategoryCount > 0) {
    blockers.push({
      code: "category_non_surface_grader_evidence_underpowered",
      message:
        "Every claim-eligible scored category needs the minimum non-surface grader-evidence cell before category-level public cost-performance claims.",
      evidence: {
        categoryCount: claimEligibleCategoryEntries.length,
        underpoweredCategoryCount:
          underpoweredNonSurfaceGraderEvidenceCategoryCount,
        minNonSurfaceGraderEvidenceCasesPerCategory,
        requiredNonSurfaceGraderEvidenceCasesPerCategory:
          PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY,
      },
    });
  }
  if (summary.duplicateScoredCaseContentGroupCount > 0) {
    blockers.push({
      code: "duplicate_scored_case_content",
      message:
        "Public cost-performance claims require distinct scored case content; exact duplicate task, constraint, and grader content can inflate denominators and confidence intervals.",
      evidence: {
        duplicateScoredCaseContentGroupCount:
          summary.duplicateScoredCaseContentGroupCount,
        duplicateScoredCaseContentCaseCount:
          summary.duplicateScoredCaseContentCaseCount,
      },
    });
  }
  if (summary.nearDuplicateScoredCaseContentPairCount > 0) {
    blockers.push({
      code: "near_duplicate_scored_case_content",
      message:
        "Public cost-performance claims require distinct scored case prompts; high-confidence lexical near duplicates can inflate denominators and confidence intervals.",
      evidence: {
        nearDuplicateScoredCaseContentPairCount:
          summary.nearDuplicateScoredCaseContentPairCount,
        nearDuplicateScoredCaseContentCaseCount:
          summary.nearDuplicateScoredCaseContentCaseCount,
        nearDuplicateScoredCaseContentThreshold:
          summary.nearDuplicateScoredCaseContentThreshold,
        nearDuplicateScoredCaseContentMinUsefulTokenCount:
          summary.nearDuplicateScoredCaseContentMinUsefulTokenCount,
      },
    });
  }

  if (summary.smokeOnlyCaseCount > 0) {
    warnings.push({
      code: "smoke_only_cases_excluded",
      message:
        "Smoke-only cases are excluded from scored public cost-performance claims.",
      evidence: { smokeOnlyCaseCount: summary.smokeOnlyCaseCount },
    });
  }
  if (
    summary.graderEvidenceTierCounts.surface_text > 0 ||
    summary.graderEvidenceTierCounts.mixed > 0
  ) {
    warnings.push({
      code: "surface_text_grader_evidence_present",
      message:
        "Surface-text and mixed graders are useful harness checks but can be gamed by token stuffing.",
      evidence: {
        surfaceTextCaseCount: summary.graderEvidenceTierCounts.surface_text,
        mixedCaseCount: summary.graderEvidenceTierCounts.mixed,
      },
    });
  }
  if (
    summary.graderEvidenceTierCounts.structured_or_exact +
      summary.graderEvidenceTierCounts.mixed >
    0
  ) {
    warnings.push({
      code: "mechanical_grader_evidence_present",
      message:
        "Closed-label choice, structured, numeric, citation, and exact graders are mechanical checks, not proof of broad semantic reasoning quality.",
      evidence: {
        structuredOrExactCaseCount:
          summary.graderEvidenceTierCounts.structured_or_exact,
        mixedCaseCount: summary.graderEvidenceTierCounts.mixed,
      },
    });
  }
  if (manifestHashAlgorithm === "hmac-sha256") {
    warnings.push({
      code: "private_auditor_verifiable_only",
      message:
        "HMAC manifests reduce public linkability but are reproducible only by auditors with the private key.",
    });
    warnings.push({
      code: "hmac_structural_metadata_visible",
      message:
        "HMAC manifests still expose structural metadata such as row count, row order, smoke flags, grader families, and aggregate balance.",
    });
  }
  const externalEvidenceRequired: EvalClaimGateExternalEvidence[] = [
    {
      code: "published_or_archived_manifest",
      message:
        "The manifest must be frozen, versioned, and bound to the public report; generating one locally is not by itself public provenance.",
    },
    {
      code: "holdout_process_record",
      message:
        "Document how the holdout was created and kept out of prompt, model, grader, and threshold tuning.",
    },
    {
      code: "private_report_reproduction_package",
      message:
        "Retain the private report, config, model/provider provenance, price snapshot, and exact evaluation command for audit.",
    },
    {
      code: "uncertainty_and_category_analysis",
      message:
        "Publish confidence intervals, denominators, category-level limitations, and where fusion helps or harms.",
    },
  ];
  if (manifestHashAlgorithm === "hmac-sha256") {
    externalEvidenceRequired.push({
      code: "hmac_auditor_key_custody",
      message:
        "Define who can verify the HMAC manifest and how the shared audit key is protected or escrowed.",
    });
  }

  return {
    target,
    scope: "case_set_only",
    status:
      blockers.length === 0 ? "case_set_constraints_met" : "case_set_blocked",
    overallClaimStatus: "external_evidence_required",
    minimums: {
      scoredCases: PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES,
      scoredCasesPerCategory:
        PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY,
      scoredCasesPerDifficulty:
        PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_DIFFICULTY,
      scoredCasesPerCategoryDifficulty:
        PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_CATEGORY_DIFFICULTY,
      nonSurfaceGraderEvidenceCases:
        PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES,
      nonSurfaceGraderEvidenceCasesPerDifficulty:
        PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_DIFFICULTY,
      nonSurfaceGraderEvidenceCasesPerCategory:
        PUBLIC_COST_PERFORMANCE_MIN_NON_SURFACE_GRADER_EVIDENCE_CASES_PER_CATEGORY,
    },
    manifest: {
      required: true,
      requested: options.manifestRequested,
      hashAlgorithm: manifestHashAlgorithm,
    },
    categoryEvidence: {
      scoredCategoryCount: scoredCategoryCounts.length,
      minScoredCasesPerCategory,
      maxScoredCasesPerCategory,
      scoredUncategorizedCaseCount: summary.scoredUncategorizedCaseCount,
    },
    categoryGraderEvidence: {
      claimEligibleCategoryCount: claimEligibleCategoryEntries.length,
      minNonSurfaceGraderEvidenceCasesPerCategory,
      underpoweredClaimEligibleCategoryCount:
        underpoweredNonSurfaceGraderEvidenceCategoryCount,
    },
    categoryDifficultyCoverage: {
      claimEligibleCategoryCount: claimEligibleCategoryEntries.length,
      minScoredCasesPerCategoryDifficulty,
      underpoweredCategoryDifficultyCellCount,
    },
    difficultyCoverage: {
      scoredCasesMissingDifficultyCount:
        summary.scoredCasesMissingDifficultyCount,
      minScoredCasesPerDifficulty,
      maxScoredCasesPerDifficulty,
      underpoweredDifficultyCount,
    },
    difficultyGraderEvidence: {
      minNonSurfaceGraderEvidenceCasesPerDifficulty,
      underpoweredDifficultyCount:
        underpoweredNonSurfaceGraderEvidenceDifficultyCount,
    },
    graderEvidenceProfile: {
      version: summary.graderEvidenceTierVersion,
      tierCounts: { ...summary.graderEvidenceTierCounts },
    },
    blockers,
    warnings,
    externalEvidenceRequired,
  };
}

export function buildCaseSetManifestFromJsonl(
  text: string,
  options: Omit<
    EvalCaseSetManifestOptions,
    "rows" | "rawFileSha256" | "rawFileHmacSha256"
  > = {},
): EvalCaseSetManifest {
  const rows = parseJsonlCaseRows(text);
  const digest = manifestDigestStrategy(options.hashMode);
  const rawFileDigest =
    digest.algorithm === "hmac-sha256"
      ? { rawFileHmacSha256: digest.digest(text, "raw-file") }
      : { rawFileSha256: digest.digest(text, "raw-file") };
  return buildCaseSetManifest(
    rows.map((row) => row.case),
    {
      ...options,
      rows,
      ...rawFileDigest,
    },
  );
}

export function buildCaseSetManifest(
  cases: EvalCase[],
  options: EvalCaseSetManifestOptions = {},
): EvalCaseSetManifest {
  validateCases(cases);
  const summary = summarizeEvalCases(cases);
  const categoryCounts = Object.values(summary.categoryCounts);
  const scoredCategoryCounts = Object.values(summary.scoredCategoryCounts);
  const includeCaseIds = Boolean(options.includeCaseIds);
  const includeCategoryLabels = Boolean(options.includeCategoryLabels);
  const intendedUse = options.intendedUse ?? "dev";
  const digest = manifestDigestStrategy(options.hashMode);
  validateManifestHashModeOptions(options, digest.algorithm);
  const source: EvalCaseSetManifest["source"] = {};
  if (options.sourcePath !== undefined) source.path = options.sourcePath;
  if (options.rawFileSha256 !== undefined)
    source.rawFileSha256 = options.rawFileSha256;
  if (options.rawFileHmacSha256 !== undefined)
    source.rawFileHmacSha256 = options.rawFileHmacSha256;
  const manifestSummary: EvalCaseSetManifest["summary"] = {
    caseCount: summary.caseCount,
    scoredCaseCount: summary.scoredCaseCount,
    smokeOnlyCaseCount: summary.smokeOnlyCaseCount,
    categoryBalance: {
      categoryCount: categoryCounts.length,
      minCasesPerCategory:
        categoryCounts.length > 0 ? Math.min(...categoryCounts) : 0,
      maxCasesPerCategory:
        categoryCounts.length > 0 ? Math.max(...categoryCounts) : 0,
      uncategorizedCaseCount: summary.uncategorizedCaseCount,
    },
    scoredCategoryBalance: {
      categoryCount: scoredCategoryCounts.length,
      minScoredCasesPerCategory:
        scoredCategoryCounts.length > 0 ? Math.min(...scoredCategoryCounts) : 0,
      maxScoredCasesPerCategory:
        scoredCategoryCounts.length > 0 ? Math.max(...scoredCategoryCounts) : 0,
      scoredUncategorizedCaseCount: summary.scoredUncategorizedCaseCount,
    },
    difficultyCoverage: {
      difficultyCounts: summary.difficultyCounts,
      scoredDifficultyCounts: summary.scoredDifficultyCounts,
      scoredCasesMissingDifficultyCount:
        summary.scoredCasesMissingDifficultyCount,
      smokeOnlyCasesMissingDifficultyCount:
        summary.smokeOnlyCasesMissingDifficultyCount,
    },
    casesWithGraderKind: summary.graderKindCounts,
    graderEvidence: {
      version: summary.graderEvidenceTierVersion,
      tierCounts: summary.graderEvidenceTierCounts,
      smokeOnlyCasesWithConfiguredGraderCount:
        summary.smokeOnlyCasesWithConfiguredGraderCount,
      ignoredSmokeOnlyConfiguredGraderKindCounts:
        summary.ignoredSmokeOnlyConfiguredGraderKindCounts,
      ignoredSmokeOnlyConfiguredCheckCount:
        summary.ignoredSmokeOnlyConfiguredCheckCount,
    },
    totalConfiguredChecks: summary.totalConfiguredChecks,
  };
  if (includeCategoryLabels) {
    manifestSummary.categoryCounts = sortedRecord(summary.categoryCounts);
    manifestSummary.scoredCategoryCounts = sortedRecord(
      summary.scoredCategoryCounts,
    );
    manifestSummary.scoredCategoryNonSurfaceGraderEvidenceCounts = sortedRecord(
      Object.fromEntries(
        Object.keys(summary.scoredCategoryCounts).map((category) => [
          category,
          summary.scoredCategoryNonSurfaceGraderEvidenceCounts[category] ?? 0,
        ]),
      ),
    );
  }
  const canonicalCaseSetDigest = caseSetCanonicalManifestDigest(
    cases,
    options.hashMode ?? { kind: "sha256" },
    intendedUse,
  );
  if (digest.algorithm === "hmac-sha256") {
    const hmacSource: HmacEvalCaseSetManifest["source"] = {};
    if (source.rawFileHmacSha256 !== undefined) {
      hmacSource.rawFileHmacSha256 = source.rawFileHmacSha256;
    }
    return {
      schemaVersion: "frugal-fusion-case-set-manifest-v4",
      fingerprintVersion: "case-set-canonical-v3",
      intendedUse,
      source: hmacSource,
      fingerprint: {
        algorithm: "hmac-sha256",
        canonicalization: "json-sorted-v1",
        content:
          "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1",
        canonicalHmacSha256: canonicalCaseSetDigest,
      },
      privacy: {
        includesCaseIds: false,
        includesCategoryLabels: false,
        rowHashesCanLinkPublicCases: false,
        rowHashesIncludeGraderValues: true,
        rowHashesAreUnsalted: false,
        rowHashesAreKeyed: true,
        hashPrivacy: "private_audit_hmac_sha256",
        structuralMetadataVisible: true,
      },
      summary: manifestSummary,
      claimReadiness: claimReadiness(summary, intendedUse, digest.algorithm),
      rows: hmacManifestRows(cases, options.rows, digest),
    };
  }

  const shaSource: Sha256EvalCaseSetManifest["source"] = {};
  if (source.path !== undefined) shaSource.path = source.path;
  if (source.rawFileSha256 !== undefined)
    shaSource.rawFileSha256 = source.rawFileSha256;
  return {
    schemaVersion: "frugal-fusion-case-set-manifest-v4",
    fingerprintVersion: "case-set-canonical-v3",
    intendedUse,
    source: shaSource,
    fingerprint: {
      algorithm: "sha256",
      canonicalization: "json-sorted-v1",
      content: "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1",
      canonicalSha256: canonicalCaseSetDigest,
    },
    privacy: {
      includesCaseIds: includeCaseIds,
      includesCategoryLabels: includeCategoryLabels,
      rowHashesCanLinkPublicCases: true,
      rowHashesIncludeGraderValues: true,
      rowHashesAreUnsalted: true,
    },
    summary: manifestSummary,
    claimReadiness: claimReadiness(summary, intendedUse, digest.algorithm),
    rows: sha256ManifestRows(cases, options.rows, {
      includeCaseIds,
      includeCategoryLabels,
      digest,
    }),
  };
}

export function caseSetFingerprint(cases: EvalCase[]): string {
  return hashText(canonicalJson(canonicalCaseSet(cases)));
}

async function runOne({
  evalCase,
  configId,
  request,
  orchestrator,
  executionOrder,
  trialIndex,
  options,
}: {
  evalCase: EvalCase;
  configId: DeliberationMode;
  request: DeliberationRequest;
  orchestrator: FrugalFusionOrchestrator;
  executionOrder: number;
  trialIndex: number;
  options: EvaluationOptions;
}): Promise<EvalConfigOutcome> {
  try {
    const result = await orchestrator.run(request);
    const grader = grade(evalCase, result);
    return {
      configId,
      trialIndex,
      status: "completed",
      passed: result.verification.passed && grader.passed,
      grader,
      executionOrder,
      result: retainResult(result, options),
    };
  } catch (error) {
    const usage = error instanceof FrugalFusionError ? error.usage : [];
    const failures =
      error instanceof FrugalFusionError
        ? sanitizeFailures(error.failures, options)
        : [];
    const callTrace =
      error instanceof FrugalFusionError
        ? sanitizeCallTrace(error.callTrace, options)
        : [];
    const status = errorStatus(error);
    const failure: NonNullable<EvalConfigOutcome["failure"]> = {
      status,
      message: retainedFailureMessage(status, error, options),
    };
    if (usage.length > 0) failure.usage = usage;
    if (failures.length > 0) failure.failures = failures;
    if (callTrace.length > 0) failure.callTrace = callTrace;
    return {
      configId,
      trialIndex,
      status: "failed",
      passed: false,
      grader: {
        passed: false,
        smokeOnly: Boolean(evalCase.smokeOnly),
        checks: [{ name: "run_completed", passed: false }],
      },
      executionOrder,
      failure,
    };
  }
}

function buildRequest(
  evalCase: EvalCase,
  mode: DeliberationMode,
  budget: DeliberationRequest["budget"],
  inputSeedMaterial: string,
  trialIndex: number,
): DeliberationRequest {
  const request: DeliberationRequest = {
    task: evalCase.task,
    mode,
    verification: "none",
    budget,
    seedMaterial: `${inputSeedMaterial}:trial-${trialIndex}:${mode}`,
  };
  if (evalCase.constraints) request.constraints = evalCase.constraints;
  return request;
}

function grade(evalCase: EvalCase, result: DeliberationResult): GraderResult {
  if (evalCase.smokeOnly) {
    return {
      passed: true,
      smokeOnly: true,
      checks: [{ name: "smoke_only", passed: true }],
    };
  }
  if (result.answer.length > MAX_GRADED_ANSWER_CHARS) {
    return {
      passed: false,
      smokeOnly: false,
      checks: [
        {
          name: "answer_size",
          passed: false,
          details: "answer_too_large",
        },
      ],
    };
  }
  const checks: GraderResult["checks"] = [];
  const lowerAnswer = result.answer.toLowerCase();
  if (evalCase.grader?.exact !== undefined) {
    checks.push({
      name: "exact",
      passed: result.answer === evalCase.grader.exact,
    });
  }
  if (evalCase.grader?.exactNormalized !== undefined) {
    checks.push({
      name: "exact_normalized",
      passed:
        normalizeText(result.answer) ===
        normalizeText(evalCase.grader.exactNormalized),
    });
  }
  for (const term of evalCase.grader?.mustInclude ?? []) {
    checks.push({
      name: "must_include",
      passed: lowerAnswer.includes(term.toLowerCase()),
    });
  }
  if (evalCase.grader?.containsAny) {
    checks.push({
      name: "contains_any",
      passed: evalCase.grader.containsAny.some((term) =>
        lowerAnswer.includes(term.toLowerCase()),
      ),
    });
  }
  for (const term of evalCase.grader?.mustNotInclude ?? []) {
    checks.push({
      name: "must_not_include",
      passed: !lowerAnswer.includes(term.toLowerCase()),
    });
  }
  for (const pattern of evalCase.grader?.regex ?? []) {
    const regex = new RegExp(pattern, "i");
    checks.push({
      name: "regex",
      passed: regex.test(result.answer),
    });
  }
  if (evalCase.grader?.minLength !== undefined) {
    checks.push({
      name: "min_length",
      passed: result.answer.length >= evalCase.grader.minLength,
    });
  }
  if (evalCase.grader?.maxLength !== undefined) {
    checks.push({
      name: "max_length",
      passed: result.answer.length <= evalCase.grader.maxLength,
    });
  }
  if (evalCase.grader?.choice) {
    checks.push(...gradeChoice(evalCase.grader.choice, result.answer));
  }
  if (evalCase.grader?.json) {
    checks.push(...gradeJson(evalCase.grader.json, result.answer));
  }
  if (evalCase.grader?.number) {
    checks.push(...gradeNumber(evalCase.grader.number, result.answer));
  }
  if (evalCase.grader?.citations) {
    checks.push(...gradeCitations(evalCase.grader.citations, result.answer));
  }
  if (checks.length === 0) {
    checks.push({
      name: "grader_configured",
      passed: false,
      details:
        "Case has no deterministic grader; mark smokeOnly for smoke tests.",
    });
  }
  return {
    passed: checks.every((check) => check.passed),
    smokeOnly: false,
    checks,
  };
}

function gradeChoice(
  choiceGrader: NonNullable<NonNullable<EvalCase["grader"]>["choice"]>,
  answer: string,
): GraderResult["checks"] {
  const normalizedAnswer = normalizeText(answer);
  const normalizedExpected = normalizeText(choiceGrader.expected);
  const normalizedAllowed = new Set(choiceGrader.allowed.map(normalizeText));
  const valid = normalizedAllowed.has(normalizedAnswer);
  return [
    {
      name: "choice_valid",
      passed: valid,
      ...(valid ? {} : { details: "choice_not_allowed" }),
    },
    {
      name: "choice_expected",
      passed: normalizedAnswer === normalizedExpected,
      ...(normalizedAnswer === normalizedExpected
        ? {}
        : { details: valid ? "wrong_choice" : "choice_not_allowed" }),
    },
  ];
}

function gradeJson(
  jsonGrader: NonNullable<NonNullable<EvalCase["grader"]>["json"]>,
  answer: string,
): GraderResult["checks"] {
  const checks: GraderResult["checks"] = [];
  const parsed = parseGradedJson(answer);
  if (jsonGrader.requireValid === true) {
    checks.push(
      parsed.valid
        ? { name: "json_valid", passed: true }
        : { name: "json_valid", passed: false, details: parsed.reason },
    );
  }
  if (!parsed.valid) {
    const failedCount =
      (jsonGrader.requiredPaths?.length ?? 0) +
      Object.keys(jsonGrader.equals ?? {}).length +
      Object.keys(jsonGrader.includes ?? {}).length +
      Object.keys(jsonGrader.arrayMinLength ?? {}).length;
    for (let index = 0; index < failedCount; index += 1) {
      checks.push({
        name: "json_check",
        passed: false,
        details: parsed.reason,
      });
    }
    if (jsonGrader.schemaSubset !== undefined) {
      checks.push({
        name: "json_schema_subset",
        passed: false,
        details: parsed.reason,
      });
    }
    return checks;
  }

  for (const path of jsonGrader.requiredPaths ?? []) {
    checks.push({
      name: "json_required_path",
      passed: resolveJsonPath(parsed.value, path).found,
    });
  }
  for (const [path, expected] of Object.entries(jsonGrader.equals ?? {})) {
    const resolved = resolveJsonPath(parsed.value, path);
    checks.push(
      resolved.found
        ? {
            name: "json_equals",
            passed: primitiveEquals(resolved.value, expected),
          }
        : { name: "json_equals", passed: false, details: "path_missing" },
    );
  }
  for (const [path, term] of Object.entries(jsonGrader.includes ?? {})) {
    const resolved = resolveJsonPath(parsed.value, path);
    checks.push(
      resolved.found
        ? {
            name: "json_includes",
            passed:
              typeof resolved.value === "string" &&
              resolved.value.toLowerCase().includes(term.toLowerCase()),
          }
        : { name: "json_includes", passed: false, details: "path_missing" },
    );
  }
  for (const [path, minLength] of Object.entries(
    jsonGrader.arrayMinLength ?? {},
  )) {
    const resolved = resolveJsonPath(parsed.value, path);
    checks.push(
      resolved.found
        ? {
            name: "json_array_min_length",
            passed:
              Array.isArray(resolved.value) &&
              resolved.value.length >= minLength,
          }
        : {
            name: "json_array_min_length",
            passed: false,
            details: "path_missing",
          },
    );
  }
  if (jsonGrader.schemaSubset !== undefined) {
    const passed = matchesSchema(parsed.value, jsonGrader.schemaSubset);
    checks.push(
      passed
        ? { name: "json_schema_subset", passed: true }
        : {
            name: "json_schema_subset",
            passed: false,
            details: "schema_subset_mismatch",
          },
    );
  }
  return checks;
}

function gradeNumber(
  numberGrader: NonNullable<NonNullable<EvalCase["grader"]>["number"]>,
  answer: string,
): GraderResult["checks"] {
  const checks: GraderResult["checks"] = [];
  const extracted = extractGradedNumber(answer, numberGrader.extractionRegex);
  if (!extracted.found) {
    return [
      {
        name: "number_found",
        passed: false,
        details: extracted.reason,
      },
    ];
  }
  if (numberGrader.expected !== undefined) {
    const tolerance = numberGrader.tolerance ?? 0;
    checks.push({
      name: "number_expected",
      passed: Math.abs(extracted.value - numberGrader.expected) <= tolerance,
      details: "absolute_tolerance",
    });
  }
  if (numberGrader.min !== undefined) {
    checks.push({
      name: "number_min",
      passed: extracted.value >= numberGrader.min,
    });
  }
  if (numberGrader.max !== undefined) {
    checks.push({
      name: "number_max",
      passed: extracted.value <= numberGrader.max,
    });
  }
  return checks;
}

function gradeCitations(
  citationGrader: NonNullable<NonNullable<EvalCase["grader"]>["citations"]>,
  answer: string,
): GraderResult["checks"] {
  const checks: GraderResult["checks"] = [];
  const extracted = extractBracketCitations(answer);
  const cited = new Set(extracted.ids);
  const allowed = new Set(citationGrader.allowedSourceIds);
  const unknownCitation = extracted.ids.some((id) => !allowed.has(id));
  const allowedCited = new Set(extracted.ids.filter((id) => allowed.has(id)));

  checks.push({
    name: "citation_allowed_sources",
    passed: !extracted.malformed && !unknownCitation,
    ...(extracted.malformed
      ? { details: "malformed_citation" }
      : unknownCitation
        ? { details: "unknown_source" }
        : {}),
  });

  for (const sourceId of citationGrader.requiredSourceIds ?? []) {
    checks.push({
      name: "citation_required_source",
      passed: cited.has(sourceId),
      ...(cited.has(sourceId) ? {} : { details: "missing_required_source" }),
    });
  }

  if (citationGrader.minCitedSources !== undefined) {
    checks.push({
      name: "citation_min_sources",
      passed: allowedCited.size >= citationGrader.minCitedSources,
      ...(allowedCited.size >= citationGrader.minCitedSources
        ? {}
        : { details: "too_few_sources" }),
    });
  }

  for (const claim of citationGrader.requiredClaims ?? []) {
    const passed = requiredClaimIsCited(
      answer,
      claim.text,
      claim.sourceId,
      claim.citationPlacement ?? "within_window",
      extracted.spans,
    );
    checks.push({
      name: "citation_required_claim",
      passed,
      ...(passed
        ? {}
        : {
            details:
              claim.citationPlacement === "immediate"
                ? "claim_not_immediately_cited"
                : "claim_not_cited",
          }),
    });
  }

  return checks;
}

function metrics(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
  design: EvalReport["evaluationDesign"],
): EvalReport["metrics"] {
  const scoredResults = results.filter((result) => !result.smokeOnly);
  const point = pointMetrics(results, configs);
  const paired = pairedComparisons(results, configs);
  const intervals = confidenceIntervals(
    results,
    configs,
    design.bootstrapSamples,
  );
  const output = {
    n: results.length,
    scored_n: scoredResults.length,
    trials_per_case: design.trialsPerCase,
    scored_trial_n: scoredResults.reduce(
      (count, result) => count + result.trials.length,
      0,
    ),
    scored_attempt_n: emptyRecord(configs),
    task_pass_rate: emptyNullableRecord(configs),
    cost_per_pass: emptyNullableRecord(configs),
    mean_cost_per_scored_attempt: emptyNullableRecord(configs),
    total_cost_usd: emptyRecord(configs),
    p50_latency_ms: emptyRecord(configs),
    p95_latency_ms: emptyRecord(configs),
    fusion_harm_rate: paired.fusion?.harm_rate ?? null,
    paired_vs_direct: paired,
    position_counts: positionCounts(results, configs),
    confidence_intervals: intervals,
    invalid_output_rate: emptyRecord(configs),
    timeout_rate: emptyRecord(configs),
    provider_error_rate: emptyRecord(configs),
    budget_exhaustion_rate: emptyRecord(configs),
    partial_failure_rate: emptyRecord(configs),
    verification_failure_rate: emptyRecord(configs),
    smoke_completion_rate: emptyRecord(configs),
  };

  for (const config of configs) {
    const outcomes = results.flatMap((result) =>
      result.outcomes.filter((outcome) => outcome.configId === config),
    );
    const scored = outcomes.filter((outcome) => !outcome.grader.smokeOnly);
    const smoke = outcomes.filter((outcome) => outcome.grader.smokeOnly);
    const completed = outcomes.filter(
      (outcome) => outcome.status === "completed",
    );
    const scoredCompleted = scored.filter(
      (outcome) => outcome.status === "completed",
    );
    const costs = outcomes.map(costForOutcome);
    const latencies = completed.map(
      (outcome) => outcome.result?.totalLatencyMs ?? 0,
    );
    output.scored_attempt_n[config] = scored.length;
    output.task_pass_rate[config] = point.taskPassRate[config];
    output.total_cost_usd[config] = sum(costs);
    output.cost_per_pass[config] = point.costPerPass[config] ?? null;
    output.mean_cost_per_scored_attempt[config] =
      point.meanCostPerScoredAttempt[config] ?? null;
    output.p50_latency_ms[config] = percentile(latencies, 0.5);
    output.p95_latency_ms[config] = percentile(latencies, 0.95);
    output.invalid_output_rate[config] = statusRate(outcomes, "invalid_output");
    output.timeout_rate[config] = statusRate(outcomes, "timeout");
    output.provider_error_rate[config] = statusRate(outcomes, "provider_error");
    output.budget_exhaustion_rate[config] = statusRate(
      outcomes,
      "budget_exhausted",
    );
    output.partial_failure_rate[config] = ratio(
      completed.filter((outcome) => outcome.result?.degraded).length,
      outcomes.length,
    );
    output.verification_failure_rate[config] = ratio(
      scoredCompleted.filter((outcome) => !outcome.result?.verification.passed)
        .length,
      scored.length,
    );
    output.smoke_completion_rate[config] = ratio(
      smoke.filter((outcome) => outcome.status === "completed").length,
      smoke.length,
    );
  }
  return output;
}

function pointMetrics(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
): {
  taskPassRate: Record<DeliberationMode, number | null>;
  costPerPass: Record<DeliberationMode, number | null>;
  meanCostPerScoredAttempt: Record<DeliberationMode, number | null>;
} {
  const taskPassRate = emptyNullableRecord(configs);
  const costPerPass = emptyNullableRecord(configs);
  const meanCostPerScoredAttempt = emptyNullableRecord(configs);
  for (const config of configs) {
    const scored = outcomesForConfig(results, config).filter(
      (outcome) => !outcome.grader.smokeOnly,
    );
    const passed = scored.filter((outcome) => outcome.passed).length;
    const costs = scored.map(costForOutcome);
    taskPassRate[config] =
      scored.length === 0 ? null : ratio(passed, scored.length);
    costPerPass[config] = passed === 0 ? null : sum(costs) / passed;
    meanCostPerScoredAttempt[config] =
      scored.length === 0 ? null : sum(costs) / scored.length;
  }
  return { taskPassRate, costPerPass, meanCostPerScoredAttempt };
}

function pairedComparisons(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
): Record<DeliberationMode, PairedComparison> {
  const output = Object.fromEntries(
    ALL_CONFIGS.map((config) => [config, emptyPairedComparison()]),
  ) as Record<DeliberationMode, PairedComparison>;
  for (const config of configs) {
    if (config === "direct") continue;
    let paired = 0;
    let unpaired = 0;
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let passDelta = 0;
    let costDelta = 0;

    for (const result of results) {
      if (result.smokeOnly) continue;
      for (const trial of result.trials) {
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
        const directPassed = direct.passed;
        const targetPassed = target.passed;
        if (targetPassed && !directPassed) wins += 1;
        else if (!targetPassed && directPassed) losses += 1;
        else ties += 1;
        passDelta += Number(targetPassed) - Number(directPassed);
        costDelta += costForOutcome(target) - costForOutcome(direct);
      }
    }

    const netAdditionalPasses = wins - losses;
    output[config] = {
      paired_n: paired,
      unpaired_n: unpaired,
      wins,
      losses,
      ties,
      pass_rate_delta: paired === 0 ? null : ratio(passDelta, paired),
      mean_cost_delta_usd: paired === 0 ? null : ratio(costDelta, paired),
      incremental_cost_per_additional_pass:
        netAdditionalPasses <= 0 ? null : costDelta / netAdditionalPasses,
      harm_rate: paired === 0 ? null : ratio(losses, paired),
    };
  }
  return output;
}

function positionCounts(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
): Record<DeliberationMode, PositionCounts> {
  const output = Object.fromEntries(
    ALL_CONFIGS.map((config) => [
      config,
      {
        all: Array.from({ length: configs.length }, () => 0),
        scored: Array.from({ length: configs.length }, () => 0),
      },
    ]),
  ) as Record<DeliberationMode, PositionCounts>;

  for (const result of results) {
    for (const trial of result.trials) {
      for (const [position, config] of trial.executionSchedule.entries()) {
        const counts = output[config];
        counts.all[position] = (counts.all[position] ?? 0) + 1;
        if (!result.smokeOnly)
          counts.scored[position] = (counts.scored[position] ?? 0) + 1;
      }
    }
  }
  return output;
}

function confidenceIntervals(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
  resamples: number,
): EvalReport["metrics"]["confidence_intervals"] {
  const costPerPassSamples = nullableSampleRecord(configs);
  const zeroPassResamples = emptyRecord(configs);
  const scoredCases = results.filter((result) => !result.smokeOnly);
  const warnings: string[] = [];
  if (scoredCases.length === 0) {
    warnings.push("No scored cases; confidence intervals are degenerate.");
  } else if (scoredCases.length < 30) {
    warnings.push(
      "Fewer than 30 scored cases; bootstrap intervals are exploratory.",
    );
  }

  if (scoredCases.length > 0) {
    const rng = lcg(stableSeed("frugal-fusion-bootstrap-v1"));
    for (let sampleIndex = 0; sampleIndex < resamples; sampleIndex += 1) {
      const sample = Array.from({ length: scoredCases.length }, () => {
        const caseIndex = Math.floor(rng() * scoredCases.length);
        return scoredCases[caseIndex] as EvalCaseResult;
      });
      const point = pointMetrics(sample, configs);
      for (const config of configs) {
        const costPerPass = point.costPerPass[config] ?? null;
        costPerPassSamples[config].push(costPerPass);
        if (costPerPass === null) zeroPassResamples[config] += 1;
      }
    }
  }

  const costPerPass = Object.fromEntries(
    ALL_CONFIGS.map((config) => {
      const samples = costPerPassSamples[config];
      const defined = samples.filter((sample) => sample !== null);
      const hasPopulation = configs.includes(config) && scoredCases.length > 0;
      const undefinedRate = hasPopulation
        ? ratio(zeroPassResamples[config], resamples)
        : 1;
      const bounds =
        !hasPopulation || defined.length === 0 || defined.length < resamples / 2
          ? { low: null, high: null }
          : interval(defined);
      return [
        config,
        {
          ...bounds,
          available: bounds.low !== null && bounds.high !== null,
          zeroPassResamples: hasPopulation ? zeroPassResamples[config] : 0,
          undefinedRate,
        },
      ];
    }),
  ) as Record<DeliberationMode, CostPerPassInterval>;
  return {
    method: "case_cluster_bootstrap",
    level: 0.95,
    resamples,
    warnings,
    task_pass_rate: taskPassRateBootstrapIntervals(results, configs, resamples),
    cost_per_pass: costPerPass,
    pass_rate_delta_vs_direct: passRateDeltaVsDirectBootstrapIntervals(
      results,
      configs,
      resamples,
    ),
  };
}

export function taskPassRateBootstrapIntervals(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
  resamples: number,
): Record<DeliberationMode, ConfidenceInterval | null> {
  const taskPassRateSamples = sampleRecord(configs);
  const scoredCases = results.filter((result) => !result.smokeOnly);
  const scoredTrialCount = scoredCases.reduce(
    (count, result) => count + result.trials.length,
    0,
  );
  const hasCompleteScoredAttempts = Object.fromEntries(
    ALL_CONFIGS.map((config) => [
      config,
      configs.includes(config) &&
        scoredTrialCount > 0 &&
        scoredCases.every((result) =>
          result.trials.every(
            (trial) =>
              trial.outcomes.filter(
                (outcome) =>
                  outcome.configId === config && !outcome.grader.smokeOnly,
              ).length === 1,
          ),
        ),
    ]),
  ) as Record<DeliberationMode, boolean>;

  if (scoredCases.length > 0) {
    const rng = lcg(stableSeed("frugal-fusion-bootstrap-v1"));
    for (let sampleIndex = 0; sampleIndex < resamples; sampleIndex += 1) {
      const sample = Array.from({ length: scoredCases.length }, () => {
        const caseIndex = Math.floor(rng() * scoredCases.length);
        return scoredCases[caseIndex] as EvalCaseResult;
      });
      const point = pointMetrics(sample, configs);
      for (const config of configs) {
        const passRate = point.taskPassRate[config];
        if (hasCompleteScoredAttempts[config] && passRate !== null) {
          taskPassRateSamples[config].push(passRate);
        }
      }
    }
  }

  return Object.fromEntries(
    ALL_CONFIGS.map((config) => [
      config,
      !hasCompleteScoredAttempts[config] ||
      taskPassRateSamples[config].length === 0
        ? null
        : interval(taskPassRateSamples[config]),
    ]),
  ) as Record<DeliberationMode, ConfidenceInterval | null>;
}

export function passRateDeltaVsDirectBootstrapIntervals(
  results: EvalCaseResult[],
  configs: DeliberationMode[],
  resamples: number,
): Record<DeliberationMode, ConfidenceInterval | null> {
  const passDeltaSamples = sampleRecord(configs);
  const scoredCases = results.filter((result) => !result.smokeOnly);
  const hasCompletePairs = Object.fromEntries(
    ALL_CONFIGS.map((config) => [
      config,
      config !== "direct" &&
        configs.includes("direct") &&
        configs.includes(config) &&
        scoredCases.length > 0 &&
        scoredCases.every((result) =>
          result.trials.every(
            (trial) =>
              trial.outcomes.filter(
                (outcome) =>
                  outcome.configId === "direct" && !outcome.grader.smokeOnly,
              ).length === 1 &&
              trial.outcomes.filter(
                (outcome) =>
                  outcome.configId === config && !outcome.grader.smokeOnly,
              ).length === 1,
          ),
        ),
    ]),
  ) as Record<DeliberationMode, boolean>;

  if (scoredCases.length > 0) {
    const rng = lcg(stableSeed("frugal-fusion-bootstrap-v1"));
    for (let sampleIndex = 0; sampleIndex < resamples; sampleIndex += 1) {
      const sample = Array.from({ length: scoredCases.length }, () => {
        const caseIndex = Math.floor(rng() * scoredCases.length);
        return scoredCases[caseIndex] as EvalCaseResult;
      });
      const paired = pairedComparisons(sample, configs);
      for (const config of configs) {
        const delta = paired[config]?.pass_rate_delta;
        if (hasCompletePairs[config] && delta !== null) {
          passDeltaSamples[config].push(delta);
        }
      }
    }
  }

  return Object.fromEntries(
    ALL_CONFIGS.map((config) => [
      config,
      !hasCompletePairs[config] || passDeltaSamples[config].length === 0
        ? null
        : interval(passDeltaSamples[config]),
    ]),
  ) as Record<DeliberationMode, ConfidenceInterval | null>;
}

function trace(
  id: string,
  configId: DeliberationMode,
  request: DeliberationRequest,
  outcome: EvalConfigOutcome,
  startedAt: string,
  options: EvaluationOptions,
): TraceRecord {
  const requestTrace: TraceRecord["request"] = {
    mode: request.mode,
    budget: request.budget,
    taskHash: hashText(request.task),
    taskLength: request.task.length,
  };
  if (request.constraints) {
    requestTrace.constraintsHash = hashText(
      JSON.stringify(request.constraints),
    );
    requestTrace.constraintsCount = request.constraints.length;
  }
  if (request.seedMaterial)
    requestTrace.seedMaterialHash = hashText(request.seedMaterial);
  if (request.verification) requestTrace.verification = request.verification;
  if (options.retainRawPrompt === true) {
    requestTrace.taskRaw = request.task;
    requestTrace.taskRedacted = redactSecrets(request.task);
    if (request.constraints)
      requestTrace.constraintsRedacted = request.constraints.map(redactSecrets);
  }
  return {
    id: `${id}:trial-${outcome.trialIndex}:${configId}`,
    configId,
    trialIndex: outcome.trialIndex,
    executionOrder: outcome.executionOrder,
    request: requestTrace,
    outcome: redactValue(traceOutcome(outcome)),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function traceOutcome(outcome: EvalConfigOutcome): TraceRecord["outcome"] {
  if (outcome.status === "completed" && outcome.result) {
    return { status: "completed", result: outcome.result };
  }
  if (outcome.failure) {
    return { status: "failed", failure: outcome.failure };
  }
  return {
    status: "failed",
    failure: { status: "provider_error", message: "Missing failure details" },
  };
}

function counterbalancedOrder(
  configs: DeliberationMode[],
  caseIndex: number,
  trialIndex: number,
  trialsPerCase: number,
): DeliberationMode[] {
  if (configs.length === 0) return [];
  const offset = (caseIndex * trialsPerCase + trialIndex) % configs.length;
  return [...configs.slice(offset), ...configs.slice(0, offset)];
}

function sortOutcomes(
  outcomes: EvalConfigOutcome[],
  configs: DeliberationMode[],
): EvalConfigOutcome[] {
  return outcomes.sort(
    (left, right) =>
      left.trialIndex - right.trialIndex ||
      configs.indexOf(left.configId) - configs.indexOf(right.configId),
  );
}

function trialFusionHarm(
  evalCase: EvalCase,
  outcomes: EvalConfigOutcome[],
): boolean {
  if (evalCase.smokeOnly) return false;
  const direct = outcomes.find((outcome) => outcome.configId === "direct");
  const fusion = outcomes.find((outcome) => outcome.configId === "fusion");
  if (!direct || !fusion) return false;
  return direct.passed && !fusion.passed;
}

function outcomesForConfig(
  results: EvalCaseResult[],
  config: DeliberationMode,
): EvalConfigOutcome[] {
  return results.flatMap((result) =>
    result.outcomes.filter((outcome) => outcome.configId === config),
  );
}

function statusRate(
  outcomes: EvalConfigOutcome[],
  status: ModelStatus,
): number {
  return ratio(
    outcomes.filter((outcome) => {
      if (outcome.failure?.status === status) return true;
      if (
        outcome.failure?.failures?.some((failure) => failure.status === status)
      )
        return true;
      return outcome.result?.failures.some(
        (failure) => failure.status === status,
      );
    }).length,
    outcomes.length,
  );
}

function retainResult(
  result: DeliberationResult,
  options: EvaluationOptions,
): RetainedDeliberationResult {
  const metadata = sanitizeMetadata(result.metadata, options);
  const retained: RetainedDeliberationResult = {
    modeUsed: result.modeUsed,
    degraded: result.degraded,
    usage: result.usage,
    rawResponseIds:
      options.retainProviderIds === true ? result.rawResponseIds : [],
    totalCostUsd: result.totalCostUsd,
    totalLatencyMs: result.totalLatencyMs,
    verification: result.verification,
    priceSnapshot: result.priceSnapshot,
    metadata,
    failures: sanitizeFailures(result.failures, options),
  };
  if (options.retainOutputs === true) {
    const answer = retainText(result.answer);
    retained.answer = answer.text;
    const retention: NonNullable<RetainedDeliberationResult["retention"]> = {};
    retention.answer = answer.metadata;
    if (result.ledger) {
      const ledger = retainStrings(result.ledger);
      retained.ledger = ledger.value;
      retention.ledger = {
        truncated: ledger.truncatedStringCount > 0,
        truncatedStringCount: ledger.truncatedStringCount,
      };
    }
    retained.retention = retention;
  }
  return retained;
}

function sanitizeMetadata(
  metadata: DeliberationResult["metadata"],
  options: EvaluationOptions,
): DeliberationResult["metadata"] {
  const sanitized: DeliberationResult["metadata"] = { ...metadata };
  if (metadata.callTrace) {
    sanitized.callTrace = sanitizeCallTrace(metadata.callTrace, options);
  }
  return sanitized;
}

function sanitizeCallTrace(
  callTrace: NonNullable<DeliberationResult["metadata"]["callTrace"]>,
  options: EvaluationOptions,
): NonNullable<DeliberationResult["metadata"]["callTrace"]> {
  return callTrace.map((trace) => {
    const copy = { ...trace };
    if (options.retainProviderIds !== true) delete copy.rawResponseId;
    return copy;
  });
}

function sanitizeFailures(
  failures: DeliberationResult["failures"],
  options: EvaluationOptions,
): DeliberationResult["failures"] {
  return failures.map((failure) => ({
    ...failure,
    message:
      options.retainFailureDetails === true
        ? truncate(redactSecrets(failure.message), 500)
        : statusFailureMessage(failure.status),
  }));
}

function retainedFailureMessage(
  status: ModelStatus,
  error: unknown,
  options: EvaluationOptions,
): string {
  if (options.retainFailureDetails === true) {
    return truncate(redactSecrets(errorMessage(error)), 500);
  }
  return statusFailureMessage(status);
}

function statusFailureMessage(status: ModelStatus): string {
  return `Model call failed with status: ${status}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function retainText(text: string): {
  text: string;
  metadata: RetainedTextMetadata;
} {
  const truncated = text.length > MAX_RETAINED_OUTPUT_CHARS;
  const retainedText = truncated
    ? text.slice(0, MAX_RETAINED_OUTPUT_CHARS)
    : text;
  return {
    text: retainedText,
    metadata: {
      truncated,
      originalLength: text.length,
      retainedLength: retainedText.length,
      sha256: hashText(text),
    },
  };
}

function retainStrings<T>(value: T): {
  value: T;
  truncatedStringCount: number;
} {
  if (typeof value === "string") {
    const retained = retainText(value);
    return {
      value: retained.text as T,
      truncatedStringCount: retained.metadata.truncated ? 1 : 0,
    };
  }
  if (Array.isArray(value)) {
    let truncatedStringCount = 0;
    const retained = value.map((item) => {
      const nested = retainStrings(item);
      truncatedStringCount += nested.truncatedStringCount;
      return nested.value;
    });
    return { value: retained as T, truncatedStringCount };
  }
  if (isRecord(value)) {
    let truncatedStringCount = 0;
    const entries = Object.entries(value).map(([key, nested]) => {
      const retained = retainStrings(nested);
      truncatedStringCount += retained.truncatedStringCount;
      return [key, retained.value];
    });
    return {
      value: Object.fromEntries(entries) as T,
      truncatedStringCount,
    };
  }
  return { value, truncatedStringCount: 0 };
}

function costForOutcome(outcome: EvalConfigOutcome): number {
  if (outcome.result) return outcome.result.totalCostUsd;
  return (
    outcome.failure?.usage?.reduce((sum, usage) => sum + usage.costUsd, 0) ?? 0
  );
}

function parseGradedJson(
  answer: string,
): { valid: true; value: unknown } | { valid: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(answer.trim());
  } catch {
    return { valid: false, reason: "json_parse_failed" };
  }
  if (!withinJsonBudget(value)) {
    return { valid: false, reason: "json_too_large" };
  }
  return { valid: true, value };
}

function withinJsonBudget(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || item.depth > MAX_JSON_DEPTH) return false;
    if (typeof item.value === "string") {
      if (item.value.length > MAX_JSON_STRING_CHARS) return false;
      continue;
    }
    if (typeof item.value === "number" && !Number.isFinite(item.value)) {
      return false;
    }
    if (Array.isArray(item.value)) {
      for (const nested of item.value) {
        stack.push({ value: nested, depth: item.depth + 1 });
      }
      continue;
    }
    if (isRecord(item.value)) {
      const entries = Object.entries(item.value);
      if (entries.length > MAX_JSON_NODES) return false;
      for (const [, nested] of entries) {
        stack.push({ value: nested, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

function resolveJsonPath(
  value: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  const parsed = parseJsonPath(path);
  let current = value;
  for (const step of parsed) {
    if (!isRecord(current) || !Object.hasOwn(current, step.key)) {
      return { found: false };
    }
    current = current[step.key];
    for (const index of step.indexes) {
      if (!Array.isArray(current) || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    }
  }
  return { found: true, value: current };
}

function parseJsonPath(
  path: string,
): Array<{ key: string; indexes: number[] }> {
  return path.split(".").map((segment) => {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)(.*)$/.exec(segment);
    if (!match) throw new Error(`Invalid JSON path: ${path}`);
    const key = match[1] as string;
    const suffix = match[2] as string;
    const indexes: number[] = [];
    let rest = suffix;
    while (rest.length > 0) {
      const indexMatch = /^\[(\d+)\]/.exec(rest);
      if (!indexMatch) throw new Error(`Invalid JSON path: ${path}`);
      indexes.push(Number(indexMatch[1]));
      rest = rest.slice(indexMatch[0].length);
    }
    return { key, indexes };
  });
}

function primitiveEquals(actual: unknown, expected: JsonPrimitive): boolean {
  if (expected === null) return actual === null;
  if (typeof expected === "number") {
    return typeof actual === "number" && actual === expected;
  }
  return actual === expected;
}

function extractGradedNumber(
  answer: string,
  extractionRegex?: string,
): { found: true; value: number } | { found: false; reason: string } {
  const text = answer.slice(0, MAX_GRADED_ANSWER_CHARS);
  const raw = extractionRegex
    ? new RegExp(extractionRegex).exec(text)?.[1]
    : NUMBER_TEXT_REGEX.exec(text)?.[0];
  if (!raw) return { found: false, reason: "number_not_found" };
  if (!ANCHORED_NUMBER_TEXT_REGEX.test(raw)) {
    return { found: false, reason: "invalid_number_text" };
  }
  const value = Number(raw);
  if (!Number.isFinite(value))
    return { found: false, reason: "number_not_finite" };
  return { found: true, value };
}

function extractBracketCitations(answer: string): {
  ids: string[];
  spans: Array<{ id: string; start: number; end: number }>;
  malformed: boolean;
} {
  const ids: string[] = [];
  const spans: Array<{ id: string; start: number; end: number }> = [];
  let malformed = false;
  let index = 0;
  while (index < answer.length) {
    const char = answer[index];
    if (char === "]") {
      malformed = true;
      index += 1;
      continue;
    }
    if (char !== "[") {
      index += 1;
      continue;
    }
    const close = answer.indexOf("]", index + 1);
    if (close === -1) {
      malformed = true;
      break;
    }
    const raw = answer.slice(index + 1, close);
    if (
      raw.length === 0 ||
      raw.includes("[") ||
      raw.includes("]") ||
      raw.includes("\n") ||
      raw.includes("\r") ||
      !CITATION_ID_REGEX.test(raw)
    ) {
      malformed = true;
      index = close + 1;
      continue;
    }
    ids.push(raw);
    spans.push({ id: raw, start: index, end: close + 1 });
    index = close + 1;
  }
  return { ids, spans, malformed };
}

function requiredClaimIsCited(
  answer: string,
  text: string,
  sourceId: string,
  placement: "within_window" | "immediate",
  citations: Array<{ id: string; start: number; end: number }>,
): boolean {
  const lowerAnswer = answer.toLowerCase();
  const lowerText = text.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < lowerAnswer.length) {
    const claimIndex = lowerAnswer.indexOf(lowerText, searchFrom);
    if (claimIndex === -1) return false;
    const windowStart = claimIndex + text.length;
    if (placement === "immediate") {
      const citation = citations.find(
        (item) =>
          item.id === sourceId &&
          item.start >= windowStart &&
          answer.slice(windowStart, item.start).trim().length === 0,
      );
      if (citation) return true;
      searchFrom = claimIndex + lowerText.length;
      continue;
    }
    const windowEnd = windowStart + CITATION_CLAIM_WINDOW_CHARS;
    if (
      citations.some(
        (citation) =>
          citation.id === sourceId &&
          citation.start >= windowStart &&
          citation.start < windowEnd,
      )
    ) {
      return true;
    }
    searchFrom = claimIndex + lowerText.length;
  }
  return false;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function caseSetCanonicalManifestDigest(
  cases: EvalCase[],
  mode: EvalCaseManifestHashMode,
  intendedUse: EvalCaseManifestIntendedUse,
): string {
  return manifestDigestStrategy(mode).digest(
    canonicalJson(canonicalManifestCaseSet(cases, intendedUse)),
    "canonical-case-set",
  );
}

function validateParsedCaseSetManifest(
  value: unknown,
): asserts value is EvalCaseSetManifest {
  if (!isRecord(value)) throw manifestBindingError("invalid_manifest_shape");
  validateManifestKeys(value, [
    "schemaVersion",
    "fingerprintVersion",
    "intendedUse",
    "source",
    "fingerprint",
    "privacy",
    "summary",
    "claimReadiness",
    "rows",
  ]);
  requireManifestLiteral(
    value,
    "schemaVersion",
    "frugal-fusion-case-set-manifest-v4",
  );
  requireManifestLiteral(value, "fingerprintVersion", "case-set-canonical-v3");
  if (!isManifestIntendedUse(value.intendedUse)) {
    throw manifestBindingError("invalid_manifest_intended_use");
  }
  if (!isRecord(value.source)) {
    throw manifestBindingError("invalid_manifest_source");
  }
  validateManifestKeys(value.source, [
    "path",
    "rawFileSha256",
    "rawFileHmacSha256",
  ]);
  if (!isRecord(value.fingerprint)) {
    throw manifestBindingError("invalid_manifest_fingerprint");
  }
  validateManifestKeys(value.fingerprint, [
    "algorithm",
    "canonicalization",
    "content",
    "canonicalSha256",
    "canonicalHmacSha256",
  ]);
  requireManifestLiteral(
    value.fingerprint,
    "canonicalization",
    "json-sorted-v1",
  );
  requireManifestLiteral(
    value.fingerprint,
    "content",
    "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1",
  );
  if (!isRecord(value.privacy)) {
    throw manifestBindingError("invalid_manifest_privacy");
  }
  validateManifestKeys(value.privacy, [
    "includesCaseIds",
    "includesCategoryLabels",
    "rowHashesCanLinkPublicCases",
    "rowHashesIncludeGraderValues",
    "rowHashesAreUnsalted",
    "rowHashesAreKeyed",
    "hashPrivacy",
    "structuralMetadataVisible",
  ]);
  if (!isRecord(value.summary)) {
    throw manifestBindingError("invalid_manifest_summary");
  }
  validateManifestSummary(value.summary);
  if (!isRecord(value.claimReadiness)) {
    throw manifestBindingError("invalid_manifest_claim_readiness");
  }
  validateClaimReadiness(value.claimReadiness);
  if (!Array.isArray(value.rows)) {
    throw manifestBindingError("invalid_manifest_rows");
  }
  const algorithm = value.fingerprint.algorithm;
  if (algorithm === "sha256") {
    validateSha256ManifestShape(value);
    return;
  }
  if (algorithm === "hmac-sha256") {
    validateHmacManifestShape(value);
    return;
  }
  throw manifestBindingError("invalid_manifest_algorithm");
}

function validateSha256ManifestShape(
  value: Record<string, unknown>,
): asserts value is Sha256EvalCaseSetManifest {
  const source = value.source as Record<string, unknown>;
  const fingerprint = value.fingerprint as Record<string, unknown>;
  const privacy = value.privacy as Record<string, unknown>;
  if (
    typeof source.rawFileHmacSha256 !== "undefined" ||
    typeof fingerprint.canonicalHmacSha256 !== "undefined"
  ) {
    throw manifestBindingError("invalid_manifest_digest_fields");
  }
  if (!isLowerHexSha256(fingerprint.canonicalSha256)) {
    throw manifestBindingError("invalid_manifest_digest");
  }
  if (
    typeof source.rawFileSha256 !== "undefined" &&
    !isLowerHexSha256(source.rawFileSha256)
  ) {
    throw manifestBindingError("invalid_manifest_source_digest");
  }
  if (
    typeof privacy.includesCaseIds !== "boolean" ||
    typeof privacy.includesCategoryLabels !== "boolean" ||
    typeof privacy.rowHashesCanLinkPublicCases !== "boolean" ||
    privacy.rowHashesIncludeGraderValues !== true ||
    privacy.rowHashesAreUnsalted !== true ||
    typeof privacy.rowHashesAreKeyed !== "undefined" ||
    typeof privacy.hashPrivacy !== "undefined" ||
    typeof privacy.structuralMetadataVisible !== "undefined"
  ) {
    throw manifestBindingError("invalid_manifest_privacy");
  }
  const summary = value.summary as Record<string, unknown>;
  if (
    !privacy.includesCategoryLabels &&
    (typeof summary.categoryCounts !== "undefined" ||
      typeof summary.scoredCategoryCounts !== "undefined" ||
      typeof summary.scoredCategoryNonSurfaceGraderEvidenceCounts !==
        "undefined")
  ) {
    throw manifestBindingError("invalid_manifest_summary");
  }
  validateManifestRows(value.rows, "sha256", {
    includesCaseIds: privacy.includesCaseIds,
    includesCategoryLabels: privacy.includesCategoryLabels,
  });
}

function validateHmacManifestShape(
  value: Record<string, unknown>,
): asserts value is HmacEvalCaseSetManifest {
  const source = value.source as Record<string, unknown>;
  const fingerprint = value.fingerprint as Record<string, unknown>;
  const privacy = value.privacy as Record<string, unknown>;
  if (
    typeof source.path !== "undefined" ||
    typeof source.rawFileSha256 !== "undefined" ||
    typeof fingerprint.canonicalSha256 !== "undefined"
  ) {
    throw manifestBindingError("invalid_manifest_digest_fields");
  }
  if (!isLowerHexSha256(fingerprint.canonicalHmacSha256)) {
    throw manifestBindingError("invalid_manifest_digest");
  }
  if (
    typeof source.rawFileHmacSha256 !== "undefined" &&
    !isLowerHexSha256(source.rawFileHmacSha256)
  ) {
    throw manifestBindingError("invalid_manifest_source_digest");
  }
  if (
    privacy.includesCaseIds !== false ||
    privacy.includesCategoryLabels !== false ||
    privacy.rowHashesCanLinkPublicCases !== false ||
    privacy.rowHashesIncludeGraderValues !== true ||
    privacy.rowHashesAreUnsalted !== false ||
    privacy.rowHashesAreKeyed !== true ||
    privacy.hashPrivacy !== "private_audit_hmac_sha256" ||
    privacy.structuralMetadataVisible !== true
  ) {
    throw manifestBindingError("invalid_manifest_privacy");
  }
  const summary = value.summary as Record<string, unknown>;
  if (
    typeof summary.categoryCounts !== "undefined" ||
    typeof summary.scoredCategoryCounts !== "undefined" ||
    typeof summary.scoredCategoryNonSurfaceGraderEvidenceCounts !== "undefined"
  ) {
    throw manifestBindingError("invalid_manifest_summary");
  }
  validateManifestRows(value.rows, "hmac-sha256");
}

function validateManifestSummary(summary: Record<string, unknown>): void {
  validateManifestKeys(summary, [
    "caseCount",
    "scoredCaseCount",
    "smokeOnlyCaseCount",
    "categoryBalance",
    "scoredCategoryBalance",
    "difficultyCoverage",
    "categoryCounts",
    "scoredCategoryCounts",
    "scoredCategoryNonSurfaceGraderEvidenceCounts",
    "casesWithGraderKind",
    "graderEvidence",
    "totalConfiguredChecks",
  ]);
  for (const key of [
    "caseCount",
    "scoredCaseCount",
    "smokeOnlyCaseCount",
    "totalConfiguredChecks",
  ]) {
    if (!isNonNegativeInteger(summary[key])) {
      throw manifestBindingError("invalid_manifest_summary");
    }
  }
  if (
    !isRecord(summary.categoryBalance) ||
    !isRecord(summary.scoredCategoryBalance) ||
    !isRecord(summary.difficultyCoverage) ||
    !isRecord(summary.casesWithGraderKind) ||
    !isRecord(summary.graderEvidence)
  ) {
    throw manifestBindingError("invalid_manifest_summary");
  }
  validateDifficultyCoverage(summary.difficultyCoverage);
}

function validateDifficultyCoverage(value: Record<string, unknown>): void {
  validateManifestKeys(value, [
    "difficultyCounts",
    "scoredDifficultyCounts",
    "scoredCasesMissingDifficultyCount",
    "smokeOnlyCasesMissingDifficultyCount",
  ]);
  if (
    !isDifficultyCounts(value.difficultyCounts) ||
    !isDifficultyCounts(value.scoredDifficultyCounts) ||
    !isNonNegativeInteger(value.scoredCasesMissingDifficultyCount) ||
    !isNonNegativeInteger(value.smokeOnlyCasesMissingDifficultyCount)
  ) {
    throw manifestBindingError("invalid_manifest_summary");
  }
}

function isDifficultyCounts(value: unknown): value is EvalCaseDifficultyCounts {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === EVAL_CASE_DIFFICULTIES.length &&
    EVAL_CASE_DIFFICULTIES.every((difficulty) =>
      isNonNegativeInteger(value[difficulty]),
    ) &&
    keys.every((key) => isEvalCaseDifficulty(key))
  );
}

function validateClaimReadiness(value: Record<string, unknown>): void {
  validateManifestKeys(value, ["status", "warnings"]);
  if (
    value.status !== "not_claim_ready" &&
    value.status !== "requires_private_audit"
  ) {
    throw manifestBindingError("invalid_manifest_claim_readiness");
  }
  if (
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning) => typeof warning !== "string")
  ) {
    throw manifestBindingError("invalid_manifest_claim_readiness");
  }
}

function validateManifestRows(
  rows: unknown,
  algorithm: EvalClaimGateManifestHashAlgorithm,
  disclosure: { includesCaseIds: boolean; includesCategoryLabels: boolean } = {
    includesCaseIds: false,
    includesCategoryLabels: false,
  },
): void {
  if (!Array.isArray(rows)) throw manifestBindingError("invalid_manifest_rows");
  for (const row of rows) {
    if (!isRecord(row)) throw manifestBindingError("invalid_manifest_rows");
    validateManifestKeys(row, [
      "line",
      "publicId",
      "id",
      "category",
      "smokeOnly",
      "graderKinds",
      "ignoredSmokeOnlyGraderKinds",
      "graderEvidenceTier",
      "canonicalRowSha256",
      "canonicalRowHmacSha256",
      "rawLineSha256",
      "rawLineHmacSha256",
    ]);
    if (
      !isNonNegativeInteger(row.line) ||
      typeof row.publicId !== "string" ||
      typeof row.smokeOnly !== "boolean" ||
      !Array.isArray(row.graderKinds) ||
      row.graderKinds.some((kind) => typeof kind !== "string") ||
      !GRADER_EVIDENCE_TIERS.includes(row.graderEvidenceTier as never)
    ) {
      throw manifestBindingError("invalid_manifest_rows");
    }
    if (
      row.ignoredSmokeOnlyGraderKinds !== undefined &&
      (!Array.isArray(row.ignoredSmokeOnlyGraderKinds) ||
        row.ignoredSmokeOnlyGraderKinds.some(
          (kind) => typeof kind !== "string",
        ))
    ) {
      throw manifestBindingError("invalid_manifest_rows");
    }
    if (algorithm === "hmac-sha256") {
      if (
        row.id !== undefined ||
        row.category !== undefined ||
        row.canonicalRowSha256 !== undefined ||
        row.rawLineSha256 !== undefined ||
        !isLowerHexSha256(row.canonicalRowHmacSha256) ||
        (row.rawLineHmacSha256 !== undefined &&
          !isLowerHexSha256(row.rawLineHmacSha256))
      ) {
        throw manifestBindingError("invalid_manifest_rows");
      }
      continue;
    }
    if (!disclosure.includesCaseIds && row.id !== undefined) {
      throw manifestBindingError("invalid_manifest_rows");
    }
    if (!disclosure.includesCategoryLabels && row.category !== undefined) {
      throw manifestBindingError("invalid_manifest_rows");
    }
    if (
      row.canonicalRowHmacSha256 !== undefined ||
      row.rawLineHmacSha256 !== undefined ||
      !isLowerHexSha256(row.canonicalRowSha256) ||
      (row.rawLineSha256 !== undefined && !isLowerHexSha256(row.rawLineSha256))
    ) {
      throw manifestBindingError("invalid_manifest_rows");
    }
  }
}

function validateManifestKeys(
  value: Record<string, unknown>,
  keys: string[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw manifestBindingError("invalid_manifest_keys");
  }
}

function requireManifestLiteral(
  value: Record<string, unknown>,
  key: string,
  expected: string,
): void {
  if (value[key] !== expected) throw manifestBindingError("invalid_manifest");
}

function isManifestIntendedUse(
  value: unknown,
): value is EvalCaseManifestIntendedUse {
  return value === "dev" || value === "public_sample" || value === "holdout";
}

function isEvalCaseDifficulty(value: unknown): value is EvalCaseDifficulty {
  return (
    typeof value === "string" &&
    EVAL_CASE_DIFFICULTIES.includes(value as EvalCaseDifficulty)
  );
}

function isLowerHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function manifestBindingError(reason: string): Error {
  return new Error(`Case manifest binding failed: ${reason}`);
}

function manifestDigestStrategy(
  mode: EvalCaseManifestHashMode | undefined,
): ManifestDigestStrategy {
  if (mode?.kind !== "hmac-sha256") {
    return {
      algorithm: "sha256",
      digest: (text) => hashText(text),
    };
  }
  validateManifestHmacKey(mode.key);
  return {
    algorithm: "hmac-sha256",
    digest: (text, purpose) =>
      createHmac("sha256", mode.key)
        .update(`${MANIFEST_HMAC_DOMAIN}\0${purpose}\0`, "utf8")
        .update(text, "utf8")
        .digest("hex"),
  };
}

function validateManifestHmacKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.trim().length === 0 ||
    Buffer.byteLength(key, "utf8") < MIN_MANIFEST_HMAC_KEY_BYTES
  ) {
    throw new Error("Manifest HMAC key must be at least 32 bytes");
  }
}

function validateManifestHashModeOptions(
  options: EvalCaseSetManifestOptions,
  algorithm: ManifestDigestStrategy["algorithm"],
): void {
  if (algorithm === "hmac-sha256") {
    if (
      options.sourcePath !== undefined ||
      options.includeCaseIds === true ||
      options.includeCategoryLabels === true
    ) {
      throw new Error(
        "HMAC manifests do not allow source labels, case IDs, or category labels",
      );
    }
    if (options.rawFileSha256 !== undefined) {
      throw new Error("HMAC manifests do not allow raw SHA-256 source digests");
    }
    return;
  }
  if (options.rawFileHmacSha256 !== undefined) {
    throw new Error("SHA-256 manifests do not allow HMAC source digests");
  }
}

function hashCaseSet(cases: EvalCase[]): string {
  return caseSetFingerprint(cases);
}

function modelInputSeedMaterial(evalCase: EvalCase): string {
  return hashText(
    canonicalJson({
      seedVersion: "model-visible-eval-case-v1",
      id: evalCase.id,
      taskHash: hashText(evalCase.task),
      constraintsHash: hashText(canonicalJson(evalCase.constraints ?? [])),
      constraintsCount: evalCase.constraints?.length ?? 0,
    }),
  );
}

function canonicalCaseSet(cases: EvalCase[]): unknown {
  return {
    fingerprintVersion: "case-set-canonical-v3",
    cases: cases.map(canonicalCase),
  };
}

function canonicalManifestCaseSet(
  cases: EvalCase[],
  intendedUse: EvalCaseManifestIntendedUse,
): unknown {
  return {
    fingerprintVersion: "case-set-canonical-v3",
    intendedUse,
    cases: cases.map(canonicalCase),
  };
}

function canonicalCase(evalCase: EvalCase): unknown {
  return {
    id: evalCase.id,
    taskHash: hashText(evalCase.task),
    taskLength: evalCase.task.length,
    constraintsHash: hashText(canonicalJson(evalCase.constraints ?? [])),
    constraintsCount: evalCase.constraints?.length ?? 0,
    category: evalCase.category ?? null,
    difficulty: evalCase.difficulty ?? null,
    smokeOnly: Boolean(evalCase.smokeOnly),
    grader: evalCase.grader ?? null,
  };
}

function caseContentFingerprint(evalCase: EvalCase): string {
  return hashText(
    canonicalJson({
      fingerprintVersion: "case-content-canonical-v1",
      taskHash: hashText(evalCase.task),
      taskLength: evalCase.task.length,
      constraintsHash: hashText(canonicalJson(evalCase.constraints ?? [])),
      constraintsCount: evalCase.constraints?.length ?? 0,
      smokeOnly: Boolean(evalCase.smokeOnly),
      grader: evalCase.grader ?? null,
    }),
  );
}

function nearDuplicateText(evalCase: EvalCase): string {
  return [evalCase.task, ...(evalCase.constraints ?? [])].join("\n");
}

function nearDuplicateTokenSet(evalCase: EvalCase): Set<string> {
  const normalized = nearDuplicateText(evalCase)
    .normalize("NFKC")
    .toLowerCase();
  return new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccardSimilarity(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

type NearDuplicateCandidate = {
  exactFingerprint: string;
  index: number;
  tokens: ReadonlySet<string>;
};

function nearDuplicatePrefixLength(tokenCount: number): number {
  return Math.max(
    1,
    tokenCount -
      Math.ceil(
        PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_JACCARD_THRESHOLD * tokenCount,
      ) +
      1,
  );
}

function sortedNearDuplicateTokens(
  tokens: ReadonlySet<string>,
  frequencies: ReadonlyMap<string, number>,
): string[] {
  return [...tokens].sort(
    (left, right) =>
      (frequencies.get(left) ?? 0) - (frequencies.get(right) ?? 0) ||
      left.localeCompare(right),
  );
}

function countNearDuplicateScoredCaseContent(
  candidates: readonly NearDuplicateCandidate[],
): { pairCount: number; caseCount: number } {
  const frequencies = new Map<string, number>();
  for (const candidate of candidates) {
    for (const token of candidate.tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  const prefixIndex = new Map<string, number[]>();
  const nearDuplicateCaseIndexes = new Set<number>();
  let pairCount = 0;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const prefixTokens = sortedNearDuplicateTokens(
      candidate.tokens,
      frequencies,
    ).slice(0, nearDuplicatePrefixLength(candidate.tokens.size));
    const comparisonIndexes = new Set<number>();
    for (const token of prefixTokens) {
      for (const priorIndex of prefixIndex.get(token) ?? []) {
        comparisonIndexes.add(priorIndex);
      }
    }
    for (const priorIndex of comparisonIndexes) {
      const prior = candidates[priorIndex];
      if (!prior || prior.exactFingerprint === candidate.exactFingerprint) {
        continue;
      }
      if (
        jaccardSimilarity(prior.tokens, candidate.tokens) >=
        PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_JACCARD_THRESHOLD
      ) {
        pairCount += 1;
        nearDuplicateCaseIndexes.add(prior.index);
        nearDuplicateCaseIndexes.add(candidate.index);
      }
    }
    for (const token of prefixTokens) {
      const indexes = prefixIndex.get(token) ?? [];
      indexes.push(candidateIndex);
      prefixIndex.set(token, indexes);
    }
  }
  return {
    pairCount,
    caseCount: nearDuplicateCaseIndexes.size,
  };
}

function baseManifestRow(
  evalCase: EvalCase,
  index: number,
  parsed: ParsedEvalCaseRow | undefined,
): Omit<
  Sha256ManifestRow,
  | "canonicalRowSha256"
  | "canonicalRowHmacSha256"
  | "rawLineSha256"
  | "rawLineHmacSha256"
  | "id"
  | "category"
> {
  const graderKinds = caseGraderKinds(evalCase.grader);
  const base: Omit<
    Sha256ManifestRow,
    | "canonicalRowSha256"
    | "canonicalRowHmacSha256"
    | "rawLineSha256"
    | "rawLineHmacSha256"
    | "id"
    | "category"
  > = {
    line: parsed?.line ?? index + 1,
    publicId: `case_${String(index + 1).padStart(4, "0")}`,
    smokeOnly: Boolean(evalCase.smokeOnly),
    graderKinds: evalCase.smokeOnly ? [] : graderKinds,
    graderEvidenceTier: caseGraderEvidenceTier(evalCase),
  };
  if (evalCase.smokeOnly && graderKinds.length > 0) {
    base.ignoredSmokeOnlyGraderKinds = graderKinds;
  }
  return base;
}

function sha256ManifestRows(
  cases: EvalCase[],
  rows: ParsedEvalCaseRow[] | undefined,
  labels: {
    includeCaseIds: boolean;
    includeCategoryLabels: boolean;
    digest: ManifestDigestStrategy;
  },
): Sha256ManifestRow[] {
  return cases.map((evalCase, index) => {
    const parsed = rows?.[index];
    const base = baseManifestRow(evalCase, index, parsed);
    const canonicalRowDigest = labels.digest.digest(
      canonicalJson(canonicalCase(evalCase)),
      "canonical-row",
    );
    const output: Sha256ManifestRow = {
      ...base,
      canonicalRowSha256: canonicalRowDigest,
    };
    if (parsed?.rawLine !== undefined) {
      output.rawLineSha256 = labels.digest.digest(parsed.rawLine, "raw-line");
    }
    if (labels.includeCaseIds) {
      output.id = evalCase.id;
    }
    if (labels.includeCategoryLabels && evalCase.category !== undefined) {
      output.category = evalCase.category;
    }
    return output;
  });
}

function hmacManifestRows(
  cases: EvalCase[],
  rows: ParsedEvalCaseRow[] | undefined,
  digest: ManifestDigestStrategy,
): HmacManifestRow[] {
  return cases.map((evalCase, index) => {
    const parsed = rows?.[index];
    const output: HmacManifestRow = {
      ...baseManifestRow(evalCase, index, parsed),
      canonicalRowHmacSha256: digest.digest(
        canonicalJson(canonicalCase(evalCase)),
        "canonical-row",
      ),
    };
    if (parsed?.rawLine !== undefined) {
      output.rawLineHmacSha256 = digest.digest(parsed.rawLine, "raw-line");
    }
    return output;
  });
}

function claimReadiness(
  summary: EvalCaseValidationSummary,
  intendedUse: EvalCaseManifestIntendedUse,
  algorithm: ManifestDigestStrategy["algorithm"],
): EvalCaseSetManifest["claimReadiness"] {
  const warnings = [
    "This manifest freezes case-set identity only; it does not prove benchmark validity.",
    "No-spend validation cannot prove that prompts, models, or graders were not tuned against this case set.",
  ];
  if (intendedUse !== "holdout") {
    warnings.push(
      "This case set is not marked as an unused holdout; do not use it for public cost-performance claims.",
    );
  } else {
    warnings.push(
      "Holdout status still requires external process evidence before public claims.",
    );
  }
  if (summary.scoredCaseCount < 100) {
    warnings.push(
      "Fewer than 100 scored cases; aggregate intervals and category conclusions are exploratory.",
    );
  }
  if (summary.scoredCasesMissingDifficultyCount > 0) {
    warnings.push(
      "Some scored cases do not have closed-enum difficulty metadata; public cost-performance claim gates require difficulty coverage.",
    );
  }
  if (
    Math.min(...Object.values(summary.scoredDifficultyCounts)) <
    PUBLIC_COST_PERFORMANCE_MIN_SCORED_CASES_PER_DIFFICULTY
  ) {
    warnings.push(
      "Difficulty coverage is below the public-claim floor for at least one difficulty bucket; difficulty labels are metadata and do not prove semantic difficulty calibration.",
    );
  }
  if (
    summary.graderEvidenceTierCounts.surface_text > 0 ||
    summary.graderEvidenceTierCounts.mixed > 0
  ) {
    warnings.push(
      "Contains surface-text grader evidence; these checks exercise the harness but can be gamed by token stuffing.",
    );
  }
  if (
    summary.graderEvidenceTierCounts.structured_or_exact +
      summary.graderEvidenceTierCounts.mixed >
    0
  ) {
    warnings.push(
      "Closed-label choice, structured, numeric, citation, exact, and mixed graders are mechanical checks, not proof of broad reasoning quality.",
    );
  }
  if (algorithm === "hmac-sha256") {
    warnings.push(
      "HMAC fingerprints reduce public linkability but are verifiable only by auditors who possess the private key.",
    );
    warnings.push(
      "Structural metadata such as row count, line numbers, row order, generated row IDs, smoke flags, grader families, grader evidence tiers, and aggregate balance remains visible.",
    );
  }
  return {
    status:
      intendedUse === "holdout" ? "requires_private_audit" : "not_claim_ready",
    warnings,
  };
}

function isNonSurfaceGraderEvidenceTier(tier: GraderEvidenceTier): boolean {
  return tier === "structured_or_exact" || tier === "mixed";
}

export function caseGraderEvidenceTier(
  evalCase: Pick<EvalCase, "grader" | "smokeOnly">,
): GraderEvidenceTier {
  if (evalCase.smokeOnly) return "smoke_only";
  const grader = evalCase.grader;
  if (!grader) return "ungraded";
  const structuredOrExact = hasStructuredOrExactEvidence(grader);
  const surfaceText = hasSurfaceTextEvidence(grader);
  if (structuredOrExact && surfaceText) return "mixed";
  if (structuredOrExact) return "structured_or_exact";
  if (surfaceText) return "surface_text";
  return "ungraded";
}

function hasStructuredOrExactEvidence(
  grader: NonNullable<EvalCase["grader"]>,
): boolean {
  return Boolean(
    grader.exact !== undefined ||
    grader.exactNormalized !== undefined ||
    hasChoiceCheck(grader.choice) ||
    hasJsonCheck(grader.json) ||
    hasNumberCheck(grader.number) ||
    hasCitationCheck(grader.citations),
  );
}

function hasSurfaceTextEvidence(
  grader: NonNullable<EvalCase["grader"]>,
): boolean {
  return Boolean(
    (grader.mustInclude?.length ?? 0) > 0 ||
    (grader.containsAny?.length ?? 0) > 0 ||
    (grader.mustNotInclude?.length ?? 0) > 0 ||
    (grader.regex?.length ?? 0) > 0 ||
    grader.minLength !== undefined ||
    grader.maxLength !== undefined,
  );
}

function emptyGraderKindCounts(): GraderKindCounts {
  return {
    exact: 0,
    exactNormalized: 0,
    mustInclude: 0,
    containsAny: 0,
    mustNotInclude: 0,
    regex: 0,
    length: 0,
    choice: 0,
    json: 0,
    number: 0,
    citations: 0,
  };
}

export function emptyGraderEvidenceTierCounts(): GraderEvidenceTierCounts {
  return Object.fromEntries(
    GRADER_EVIDENCE_TIERS.map((tier) => [tier, 0]),
  ) as GraderEvidenceTierCounts;
}

function emptyDifficultyCounts(): EvalCaseDifficultyCounts {
  return Object.fromEntries(
    EVAL_CASE_DIFFICULTIES.map((difficulty) => [difficulty, 0]),
  ) as EvalCaseDifficultyCounts;
}

function caseGraderKindCounts(
  grader: NonNullable<EvalCase["grader"]>,
): GraderKindCounts {
  return {
    exact: Number(grader.exact !== undefined),
    exactNormalized: Number(grader.exactNormalized !== undefined),
    mustInclude: Number((grader.mustInclude?.length ?? 0) > 0),
    containsAny: Number((grader.containsAny?.length ?? 0) > 0),
    mustNotInclude: Number((grader.mustNotInclude?.length ?? 0) > 0),
    regex: Number((grader.regex?.length ?? 0) > 0),
    length: Number(
      grader.minLength !== undefined || grader.maxLength !== undefined,
    ),
    choice: Number(hasChoiceCheck(grader.choice)),
    json: Number(hasJsonCheck(grader.json)),
    number: Number(hasNumberCheck(grader.number)),
    citations: Number(hasCitationCheck(grader.citations)),
  };
}

function addGraderKindCounts(
  target: GraderKindCounts,
  source: GraderKindCounts,
): void {
  for (const key of Object.keys(target) as Array<keyof GraderKindCounts>) {
    target[key] += source[key];
  }
}

function caseGraderKinds(
  grader: EvalCase["grader"] | undefined,
): Array<keyof EvalCaseValidationSummary["graderKindCounts"]> {
  if (!grader) return [];
  const kinds: Array<keyof EvalCaseValidationSummary["graderKindCounts"]> = [];
  if (grader.exact !== undefined) kinds.push("exact");
  if (grader.exactNormalized !== undefined) kinds.push("exactNormalized");
  if ((grader.mustInclude?.length ?? 0) > 0) kinds.push("mustInclude");
  if ((grader.containsAny?.length ?? 0) > 0) kinds.push("containsAny");
  if ((grader.mustNotInclude?.length ?? 0) > 0) kinds.push("mustNotInclude");
  if ((grader.regex?.length ?? 0) > 0) kinds.push("regex");
  if (grader.minLength !== undefined || grader.maxLength !== undefined) {
    kinds.push("length");
  }
  if (hasChoiceCheck(grader.choice)) kinds.push("choice");
  if (hasJsonCheck(grader.json)) kinds.push("json");
  if (hasNumberCheck(grader.number)) kinds.push("number");
  if (hasCitationCheck(grader.citations)) kinds.push("citations");
  return kinds;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot canonicalize value");
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key] as T]),
  );
}

function validateCases(cases: EvalCase[]): void {
  if (cases.length === 0) throw new Error("Evaluation needs at least one case");
  const ids = new Set<string>();
  for (const [caseIndex, evalCase] of cases.entries()) {
    if (!isRecord(evalCase)) {
      throw new Error(`Eval case at index ${caseIndex} must be an object`);
    }
    const label =
      typeof evalCase.id === "string" && evalCase.id.trim().length > 0
        ? `Eval case ${evalCase.id}`
        : `Eval case at index ${caseIndex}`;
    validateKnownKeys(
      evalCase,
      [
        "id",
        "task",
        "constraints",
        "category",
        "difficulty",
        "smokeOnly",
        "grader",
      ],
      label,
    );
    rejectUndefinedValues(evalCase, label);
    if (typeof evalCase.id !== "string" || evalCase.id.trim().length === 0) {
      throw new Error("Every eval case needs a non-empty id");
    }
    if (ids.has(evalCase.id))
      throw new Error(`Duplicate eval case id: ${evalCase.id}`);
    ids.add(evalCase.id);
    if (typeof evalCase.task !== "string" || evalCase.task.trim().length === 0)
      throw new Error(`Eval case ${evalCase.id} has an empty task`);
    if (
      evalCase.category !== undefined &&
      (typeof evalCase.category !== "string" ||
        evalCase.category.trim().length === 0)
    ) {
      throw new Error(`Eval case ${evalCase.id} category must be string`);
    }
    if (typeof evalCase.category === "string") {
      requireBoundedString(
        evalCase.category,
        `Eval case ${evalCase.id} category`,
      );
    }
    if (
      evalCase.difficulty !== undefined &&
      !isEvalCaseDifficulty(evalCase.difficulty)
    ) {
      throw new Error(
        `Eval case ${evalCase.id} difficulty must be easy, medium, or hard`,
      );
    }
    if (
      evalCase.smokeOnly !== undefined &&
      typeof evalCase.smokeOnly !== "boolean"
    )
      throw new Error(`Eval case ${evalCase.id} smokeOnly must be boolean`);
    if (evalCase.constraints !== undefined)
      requireStringArray(
        evalCase.constraints,
        `Eval case ${evalCase.id} constraints`,
      );
    validateGrader(evalCase);
  }
}

function summarizeEvalCases(cases: EvalCase[]): EvalCaseValidationSummary {
  const summary: EvalCaseValidationSummary = {
    caseCount: cases.length,
    scoredCaseCount: 0,
    smokeOnlyCaseCount: 0,
    categoryCounts: {},
    scoredCategoryCounts: {},
    scoredCategoryNonSurfaceGraderEvidenceCounts: {},
    scoredCategoryDifficultyCounts: {},
    difficultyCounts: emptyDifficultyCounts(),
    scoredDifficultyCounts: emptyDifficultyCounts(),
    scoredDifficultyNonSurfaceGraderEvidenceCounts: emptyDifficultyCounts(),
    scoredCasesMissingDifficultyCount: 0,
    smokeOnlyCasesMissingDifficultyCount: 0,
    duplicateScoredCaseContentGroupCount: 0,
    duplicateScoredCaseContentCaseCount: 0,
    nearDuplicateScoredCaseContentPairCount: 0,
    nearDuplicateScoredCaseContentCaseCount: 0,
    nearDuplicateScoredCaseContentThreshold:
      PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_JACCARD_THRESHOLD,
    nearDuplicateScoredCaseContentMinUsefulTokenCount:
      PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_MIN_USEFUL_TOKENS,
    uncategorizedCaseCount: 0,
    scoredUncategorizedCaseCount: 0,
    graderKindCounts: emptyGraderKindCounts(),
    graderEvidenceTierVersion: GRADER_EVIDENCE_TIER_VERSION,
    graderEvidenceTierCounts: emptyGraderEvidenceTierCounts(),
    smokeOnlyCasesWithConfiguredGraderCount: 0,
    ignoredSmokeOnlyConfiguredGraderKindCounts: emptyGraderKindCounts(),
    ignoredSmokeOnlyConfiguredCheckCount: 0,
    totalConfiguredChecks: 0,
  };
  const scoredContentCounts = new Map<string, number>();
  const nearDuplicateCandidateByExactFingerprint = new Map<
    string,
    Omit<NearDuplicateCandidate, "index">
  >();

  for (const evalCase of cases) {
    const evidenceTier = caseGraderEvidenceTier(evalCase);
    if (evalCase.smokeOnly) {
      summary.smokeOnlyCaseCount += 1;
      if (evalCase.difficulty === undefined) {
        summary.smokeOnlyCasesMissingDifficultyCount += 1;
      }
    } else {
      summary.scoredCaseCount += 1;
      if (evalCase.difficulty === undefined) {
        summary.scoredCasesMissingDifficultyCount += 1;
      } else {
        summary.scoredDifficultyCounts[evalCase.difficulty] += 1;
        if (isNonSurfaceGraderEvidenceTier(evidenceTier)) {
          summary.scoredDifficultyNonSurfaceGraderEvidenceCounts[
            evalCase.difficulty
          ] += 1;
        }
      }
      const contentFingerprint = caseContentFingerprint(evalCase);
      scoredContentCounts.set(
        contentFingerprint,
        (scoredContentCounts.get(contentFingerprint) ?? 0) + 1,
      );
      const tokens = nearDuplicateTokenSet(evalCase);
      if (
        tokens.size >= PUBLIC_COST_PERFORMANCE_NEAR_DUPLICATE_MIN_USEFUL_TOKENS
      ) {
        if (!nearDuplicateCandidateByExactFingerprint.has(contentFingerprint)) {
          nearDuplicateCandidateByExactFingerprint.set(contentFingerprint, {
            exactFingerprint: contentFingerprint,
            tokens,
          });
        }
      }
    }
    if (evalCase.difficulty !== undefined) {
      summary.difficultyCounts[evalCase.difficulty] += 1;
    }
    if (evalCase.category) {
      summary.categoryCounts[evalCase.category] =
        (summary.categoryCounts[evalCase.category] ?? 0) + 1;
      if (!evalCase.smokeOnly) {
        summary.scoredCategoryCounts[evalCase.category] =
          (summary.scoredCategoryCounts[evalCase.category] ?? 0) + 1;
        if (evalCase.difficulty !== undefined) {
          const categoryDifficultyCounts =
            summary.scoredCategoryDifficultyCounts[evalCase.category] ??
            emptyDifficultyCounts();
          categoryDifficultyCounts[evalCase.difficulty] += 1;
          summary.scoredCategoryDifficultyCounts[evalCase.category] =
            categoryDifficultyCounts;
        }
        if (isNonSurfaceGraderEvidenceTier(evidenceTier)) {
          summary.scoredCategoryNonSurfaceGraderEvidenceCounts[
            evalCase.category
          ] =
            (summary.scoredCategoryNonSurfaceGraderEvidenceCounts[
              evalCase.category
            ] ?? 0) + 1;
        }
      }
    } else {
      summary.uncategorizedCaseCount += 1;
      if (!evalCase.smokeOnly) summary.scoredUncategorizedCaseCount += 1;
    }
    const grader = evalCase.grader;
    summary.graderEvidenceTierCounts[evidenceTier] += 1;
    if (!grader) continue;
    const configuredKinds = caseGraderKindCounts(grader);
    if (evalCase.smokeOnly) {
      summary.smokeOnlyCasesWithConfiguredGraderCount += 1;
      addGraderKindCounts(
        summary.ignoredSmokeOnlyConfiguredGraderKindCounts,
        configuredKinds,
      );
      summary.ignoredSmokeOnlyConfiguredCheckCount +=
        countConfiguredChecks(grader);
      continue;
    }
    addGraderKindCounts(summary.graderKindCounts, configuredKinds);
    summary.totalConfiguredChecks += countConfiguredChecks(grader);
  }
  for (const count of scoredContentCounts.values()) {
    if (count > 1) {
      summary.duplicateScoredCaseContentGroupCount += 1;
      summary.duplicateScoredCaseContentCaseCount += count;
    }
  }
  const nearDuplicateCandidates = [
    ...nearDuplicateCandidateByExactFingerprint.values(),
  ].map((candidate, index) => ({ ...candidate, index }));
  const nearDuplicateCounts = countNearDuplicateScoredCaseContent(
    nearDuplicateCandidates,
  );
  summary.nearDuplicateScoredCaseContentPairCount =
    nearDuplicateCounts.pairCount;
  summary.nearDuplicateScoredCaseContentCaseCount =
    nearDuplicateCounts.caseCount;

  return summary;
}

function validateConfigs(configs: DeliberationMode[]): DeliberationMode[] {
  if (configs.length === 0)
    throw new Error("Evaluation needs at least one config");
  const seen = new Set<DeliberationMode>();
  for (const config of configs) {
    if (!VALID_CONFIGS.has(config))
      throw new Error(`Unknown evaluation config: ${String(config)}`);
    if (seen.has(config)) {
      throw new Error(
        `Duplicate evaluation config ${config}; use trialsPerCase for repeated runs`,
      );
    }
    seen.add(config);
  }
  return configs;
}

function validateGrader(evalCase: EvalCase): void {
  const grader = evalCase.grader;
  if (grader === undefined) {
    if (evalCase.smokeOnly) return;
    throw new Error(
      `Eval case ${evalCase.id} needs a deterministic grader or smokeOnly=true`,
    );
  }
  if (!isRecord(grader))
    throw new Error(`Eval case ${evalCase.id} grader must be an object`);
  validateKnownKeys(
    grader,
    [
      "exact",
      "exactNormalized",
      "mustInclude",
      "containsAny",
      "mustNotInclude",
      "regex",
      "minLength",
      "maxLength",
      "choice",
      "json",
      "number",
      "citations",
    ],
    `Eval case ${evalCase.id} grader`,
  );
  if (grader?.exact !== undefined && typeof grader.exact !== "string")
    throw new Error(`Eval case ${evalCase.id} grader.exact must be string`);
  if (grader?.exact !== undefined)
    requireBoundedString(grader.exact, `Eval case ${evalCase.id} grader.exact`);
  if (
    grader?.exactNormalized !== undefined &&
    typeof grader.exactNormalized !== "string"
  )
    throw new Error(
      `Eval case ${evalCase.id} grader.exactNormalized must be string`,
    );
  if (grader?.exactNormalized !== undefined) {
    requireBoundedString(
      grader.exactNormalized,
      `Eval case ${evalCase.id} grader.exactNormalized`,
    );
  }
  if (grader?.mustInclude !== undefined)
    requireStringArray(
      grader.mustInclude,
      `Eval case ${evalCase.id} grader.mustInclude`,
    );
  for (const term of grader?.mustInclude ?? [])
    requireBoundedString(term, `Eval case ${evalCase.id} grader.mustInclude`);
  if (grader?.containsAny !== undefined)
    requireStringArray(
      grader.containsAny,
      `Eval case ${evalCase.id} grader.containsAny`,
    );
  for (const term of grader?.containsAny ?? [])
    requireBoundedString(term, `Eval case ${evalCase.id} grader.containsAny`);
  if (grader?.mustNotInclude !== undefined)
    requireStringArray(
      grader.mustNotInclude,
      `Eval case ${evalCase.id} grader.mustNotInclude`,
    );
  for (const term of grader?.mustNotInclude ?? [])
    requireBoundedString(
      term,
      `Eval case ${evalCase.id} grader.mustNotInclude`,
    );
  if (grader?.regex !== undefined)
    requireStringArray(grader.regex, `Eval case ${evalCase.id} grader.regex`);
  if (grader?.minLength !== undefined)
    requireNonNegativeInteger(
      grader.minLength,
      `Eval case ${evalCase.id} grader.minLength`,
    );
  if (grader?.maxLength !== undefined)
    requireNonNegativeInteger(
      grader.maxLength,
      `Eval case ${evalCase.id} grader.maxLength`,
    );
  if (
    grader?.minLength !== undefined &&
    grader?.maxLength !== undefined &&
    grader.maxLength < grader.minLength
  ) {
    throw new Error(`Eval case ${evalCase.id} maxLength must be >= minLength`);
  }
  const hasCheck = Boolean(
    grader?.exact !== undefined ||
    grader?.exactNormalized !== undefined ||
    grader?.mustInclude?.length ||
    grader?.containsAny?.length ||
    grader?.mustNotInclude?.length ||
    grader?.regex?.length ||
    grader?.minLength !== undefined ||
    grader?.maxLength !== undefined ||
    hasChoiceCheck(grader?.choice) ||
    hasJsonCheck(grader?.json) ||
    hasNumberCheck(grader?.number) ||
    hasCitationCheck(grader?.citations),
  );
  if (!evalCase.smokeOnly && !hasCheck) {
    throw new Error(
      `Eval case ${evalCase.id} needs a deterministic grader or smokeOnly=true`,
    );
  }
  for (const pattern of grader?.regex ?? []) {
    validateSafeRegex(pattern, `Eval case ${evalCase.id} grader.regex`);
  }
  validateJsonGrader(evalCase);
  validateChoiceGrader(evalCase);
  validateNumberGrader(evalCase);
  validateCitationGrader(evalCase);
  const checkCount = countConfiguredChecks(grader);
  if (checkCount > MAX_GRADER_CHECKS)
    throw new Error(`Eval case ${evalCase.id} has too many grader checks`);
}

function validateChoiceGrader(evalCase: EvalCase): void {
  const choice = evalCase.grader?.choice;
  if (choice === undefined) return;
  const path = `Eval case ${evalCase.id} grader.choice`;
  if (!isRecord(choice)) throw new Error(`${path} must be an object`);
  validateKnownKeys(choice, ["expected", "allowed"], path);
  if (typeof choice.expected !== "string") {
    throw new Error(`${path}.expected must be string`);
  }
  requireBoundedString(choice.expected, `${path}.expected`);
  requireStringArray(choice.allowed, `${path}.allowed`);
  if (choice.allowed.length === 0 || choice.allowed.length > MAX_CHOICES) {
    throw new Error(`${path}.allowed has invalid length`);
  }
  const normalizedAllowed = new Set<string>();
  for (const [index, value] of choice.allowed.entries()) {
    const itemPath = `${path}.allowed[${index}]`;
    requireBoundedString(value, itemPath);
    const normalized = normalizeText(value);
    if (normalized.length === 0) throw new Error(`${itemPath} is empty`);
    if (normalizedAllowed.has(normalized)) {
      throw new Error(`${path}.allowed has duplicate normalized choices`);
    }
    normalizedAllowed.add(normalized);
  }
  if (!normalizedAllowed.has(normalizeText(choice.expected))) {
    throw new Error(`${path}.expected must be one of allowed`);
  }
}

function validateJsonGrader(evalCase: EvalCase): void {
  const json = evalCase.grader?.json;
  if (json === undefined) return;
  if (!isRecord(json))
    throw new Error(`Eval case ${evalCase.id} grader.json must be an object`);
  validateKnownKeys(
    json,
    [
      "requireValid",
      "requiredPaths",
      "equals",
      "includes",
      "arrayMinLength",
      "schemaSubset",
    ],
    `Eval case ${evalCase.id} grader.json`,
  );
  if (json.requireValid !== undefined && typeof json.requireValid !== "boolean")
    throw new Error(
      `Eval case ${evalCase.id} grader.json.requireValid must be boolean`,
    );
  if (json.requiredPaths !== undefined)
    requireStringArray(
      json.requiredPaths,
      `Eval case ${evalCase.id} grader.json.requiredPaths`,
    );
  for (const path of json.requiredPaths ?? []) validateJsonPath(path);
  validatePrimitiveRecord(
    json.equals,
    `Eval case ${evalCase.id} grader.json.equals`,
  );
  for (const path of Object.keys(json.equals ?? {})) validateJsonPath(path);
  validateStringRecord(
    json.includes,
    `Eval case ${evalCase.id} grader.json.includes`,
  );
  for (const [path, term] of Object.entries(json.includes ?? {})) {
    validateJsonPath(path);
    requireBoundedString(term, `Eval case ${evalCase.id} grader.json.includes`);
  }
  validateNonNegativeIntegerRecord(
    json.arrayMinLength,
    `Eval case ${evalCase.id} grader.json.arrayMinLength`,
  );
  for (const path of Object.keys(json.arrayMinLength ?? {})) {
    validateJsonPath(path);
  }
  if (json.schemaSubset !== undefined) {
    validateJsonSchemaSubset(
      json.schemaSubset,
      `Eval case ${evalCase.id} grader.json.schemaSubset`,
    );
  }
}

function validateJsonSchemaSubset(value: unknown, path: string): void {
  const state = { nodes: 0 };
  validateJsonSchemaSubsetNode(value, path, 0, state);
}

function validateJsonSchemaSubsetNode(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): asserts value is JsonSchemaSubset {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_SUBSET_NODES) {
    throw new Error(`${path} has too many schema nodes`);
  }
  if (depth > MAX_SCHEMA_SUBSET_DEPTH) {
    throw new Error(`${path} exceeds maximum schema depth`);
  }
  if (!isPlainRecord(value)) throw new Error(`${path} must be a plain object`);
  if (!Object.hasOwn(value, "type"))
    throw new Error(`${path}.type is required`);
  const schemaType = value.type;
  if (
    schemaType !== "object" &&
    schemaType !== "array" &&
    schemaType !== "string" &&
    schemaType !== "number" &&
    schemaType !== "integer" &&
    schemaType !== "boolean"
  ) {
    throw new Error(`${path}.type must be a supported schema subset type`);
  }
  const allowedKeys = schemaAllowedKeys(schemaType);
  validateKnownKeys(value, allowedKeys, path);
  if (schemaType === "object") {
    validateObjectSchemaSubset(value, path, depth, state);
  } else if (schemaType === "array") {
    if (!Object.hasOwn(value, "items"))
      throw new Error(`${path}.items is required`);
    validateJsonSchemaSubsetNode(
      value.items,
      `${path}.items`,
      depth + 1,
      state,
    );
  } else if (schemaType === "string") {
    validateStringSchemaSubset(value, path);
  } else if (schemaType === "number" || schemaType === "integer") {
    validateNumericSchemaSubset(value, path);
  }
}

function validateObjectSchemaSubset(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  state: { nodes: number },
): void {
  if (!isPlainRecord(value.properties)) {
    throw new Error(`${path}.properties must be an object`);
  }
  const propertyNames = Object.keys(value.properties);
  if (propertyNames.length > MAX_SCHEMA_SUBSET_PROPERTIES) {
    throw new Error(`${path}.properties has too many entries`);
  }
  if (typeof value.additionalProperties !== "boolean") {
    throw new Error(`${path}.additionalProperties must be explicit boolean`);
  }
  for (const key of propertyNames) {
    validateSchemaPropertyName(key, `${path}.properties`);
    validateJsonSchemaSubsetNode(
      value.properties[key],
      `${path}.properties.${key}`,
      depth + 1,
      state,
    );
  }
  if (value.required !== undefined) {
    requireStringArray(value.required, `${path}.required`);
    const seen = new Set<string>();
    for (const item of value.required) {
      validateSchemaPropertyName(item, `${path}.required`);
      if (seen.has(item)) throw new Error(`${path}.required has duplicates`);
      seen.add(item);
      if (!Object.hasOwn(value.properties, item)) {
        throw new Error(`${path}.required must reference properties`);
      }
    }
  }
}

function validateStringSchemaSubset(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.enum === undefined) return;
  if (
    !Array.isArray(value.enum) ||
    value.enum.length === 0 ||
    value.enum.length > MAX_SCHEMA_SUBSET_ENUM_VALUES
  ) {
    throw new Error(`${path}.enum has invalid length`);
  }
  const seen = new Set<string>();
  for (const [index, item] of value.enum.entries()) {
    const itemPath = `${path}.enum[${index}]`;
    if (typeof item !== "string") throw new Error(`${itemPath} must be string`);
    requireBoundedString(item, itemPath);
    if (seen.has(item)) throw new Error(`${path}.enum has duplicates`);
    seen.add(item);
  }
}

function validateNumericSchemaSubset(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.minimum !== undefined)
    requireFiniteNumber(value.minimum, `${path}.minimum`);
  if (value.maximum !== undefined)
    requireFiniteNumber(value.maximum, `${path}.maximum`);
  if (
    typeof value.minimum === "number" &&
    typeof value.maximum === "number" &&
    value.maximum < value.minimum
  ) {
    throw new Error(`${path}.maximum must be >= minimum`);
  }
}

function schemaAllowedKeys(type: string): string[] {
  if (type === "object") {
    return ["type", "properties", "required", "additionalProperties"];
  }
  if (type === "array") return ["type", "items"];
  if (type === "string") return ["type", "enum"];
  if (type === "number" || type === "integer") {
    return ["type", "minimum", "maximum"];
  }
  return ["type"];
}

function validateSchemaPropertyName(value: string, path: string): void {
  requireBoundedString(value, path);
  if (
    value === "__proto__" ||
    value === "prototype" ||
    value === "constructor"
  ) {
    throw new Error(`${path} contains unsafe property name`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateNumberGrader(evalCase: EvalCase): void {
  const number = evalCase.grader?.number;
  if (number === undefined) return;
  if (!isRecord(number))
    throw new Error(`Eval case ${evalCase.id} grader.number must be an object`);
  validateKnownKeys(
    number,
    ["expected", "tolerance", "min", "max", "extractionRegex"],
    `Eval case ${evalCase.id} grader.number`,
  );
  if (number.expected !== undefined)
    requireFiniteNumber(
      number.expected,
      `Eval case ${evalCase.id} grader.number.expected`,
    );
  if (number.tolerance !== undefined) {
    requireFiniteNumber(
      number.tolerance,
      `Eval case ${evalCase.id} grader.number.tolerance`,
    );
    if (number.tolerance < 0)
      throw new Error(
        `Eval case ${evalCase.id} grader.number.tolerance must be non-negative`,
      );
  }
  if (number.tolerance !== undefined && number.expected === undefined) {
    throw new Error(
      `Eval case ${evalCase.id} grader.number.tolerance requires expected`,
    );
  }
  if (number.min !== undefined)
    requireFiniteNumber(
      number.min,
      `Eval case ${evalCase.id} grader.number.min`,
    );
  if (number.max !== undefined)
    requireFiniteNumber(
      number.max,
      `Eval case ${evalCase.id} grader.number.max`,
    );
  if (
    number.min !== undefined &&
    number.max !== undefined &&
    number.max < number.min
  ) {
    throw new Error(
      `Eval case ${evalCase.id} grader.number.max must be >= min`,
    );
  }
  if (number.extractionRegex !== undefined) {
    validateSafeRegex(
      number.extractionRegex,
      `Eval case ${evalCase.id} grader.number.extractionRegex`,
      1,
    );
  }
}

function validateCitationGrader(evalCase: EvalCase): void {
  const citations = evalCase.grader?.citations;
  if (citations === undefined) return;
  if (!isRecord(citations)) {
    throw new Error(
      `Eval case ${evalCase.id} grader.citations must be an object`,
    );
  }
  validateKnownKeys(
    citations,
    [
      "allowedSourceIds",
      "requiredSourceIds",
      "minCitedSources",
      "requiredClaims",
    ],
    `Eval case ${evalCase.id} grader.citations`,
  );
  validateCitationIdArray(
    citations.allowedSourceIds,
    `Eval case ${evalCase.id} grader.citations.allowedSourceIds`,
    { required: true },
  );
  const allowed = new Set(citations.allowedSourceIds);
  if (citations.requiredSourceIds !== undefined) {
    validateCitationIdArray(
      citations.requiredSourceIds,
      `Eval case ${evalCase.id} grader.citations.requiredSourceIds`,
      { required: false },
    );
    for (const sourceId of citations.requiredSourceIds) {
      if (!allowed.has(sourceId)) {
        throw new Error(
          `Eval case ${evalCase.id} grader.citations.requiredSourceIds must be allowed`,
        );
      }
    }
  }
  if (citations.minCitedSources !== undefined) {
    validatePositiveIntegerOption(
      citations.minCitedSources,
      `Eval case ${evalCase.id} grader.citations.minCitedSources`,
      MAX_CITATION_SOURCE_IDS,
    );
    if (citations.minCitedSources > citations.allowedSourceIds.length) {
      throw new Error(
        `Eval case ${evalCase.id} grader.citations.minCitedSources exceeds allowedSourceIds`,
      );
    }
  }
  if (citations.requiredClaims !== undefined) {
    if (
      !Array.isArray(citations.requiredClaims) ||
      citations.requiredClaims.length === 0 ||
      citations.requiredClaims.length > MAX_CITATION_REQUIRED_CLAIMS
    ) {
      throw new Error(
        `Eval case ${evalCase.id} grader.citations.requiredClaims has invalid length`,
      );
    }
    for (const [index, claim] of citations.requiredClaims.entries()) {
      const path = `Eval case ${evalCase.id} grader.citations.requiredClaims[${index}]`;
      if (!isRecord(claim)) throw new Error(`${path} must be an object`);
      validateKnownKeys(claim, ["sourceId", "text", "citationPlacement"], path);
      if (typeof claim.sourceId !== "string") {
        throw new Error(`${path}.sourceId must be string`);
      }
      validateCitationId(claim.sourceId, `${path}.sourceId`);
      if (!allowed.has(claim.sourceId)) {
        throw new Error(`${path}.sourceId must be allowed`);
      }
      if (typeof claim.text !== "string") {
        throw new Error(`${path}.text must be string`);
      }
      requireBoundedString(claim.text, `${path}.text`);
      if (
        claim.citationPlacement !== undefined &&
        claim.citationPlacement !== "within_window" &&
        claim.citationPlacement !== "immediate"
      ) {
        throw new Error(
          `${path}.citationPlacement must be within_window or immediate`,
        );
      }
    }
  }
  if (!hasCitationCheck(citations)) {
    throw new Error(
      `Eval case ${evalCase.id} grader.citations needs requiredSourceIds, minCitedSources, or requiredClaims`,
    );
  }
}

function hasJsonCheck(
  json: NonNullable<EvalCase["grader"]>["json"] | undefined,
): boolean {
  return Boolean(
    json?.requireValid === true ||
    json?.requiredPaths?.length ||
    Object.keys(json?.equals ?? {}).length ||
    Object.keys(json?.includes ?? {}).length ||
    Object.keys(json?.arrayMinLength ?? {}).length ||
    json?.schemaSubset !== undefined,
  );
}

function hasChoiceCheck(
  choice: NonNullable<EvalCase["grader"]>["choice"] | undefined,
): boolean {
  return Boolean(choice !== undefined);
}

function hasNumberCheck(
  number: NonNullable<EvalCase["grader"]>["number"] | undefined,
): boolean {
  return Boolean(
    number?.expected !== undefined ||
    number?.min !== undefined ||
    number?.max !== undefined,
  );
}

function hasCitationCheck(
  citations: NonNullable<EvalCase["grader"]>["citations"] | undefined,
): boolean {
  return Boolean(
    (citations?.requiredSourceIds?.length ?? 0) > 0 ||
    citations?.minCitedSources !== undefined ||
    (citations?.requiredClaims?.length ?? 0) > 0,
  );
}

function countConfiguredChecks(
  grader: NonNullable<EvalCase["grader"]>,
): number {
  return (
    Number(grader.exact !== undefined) +
    Number(grader.exactNormalized !== undefined) +
    (grader.mustInclude?.length ?? 0) +
    Number((grader.containsAny?.length ?? 0) > 0) +
    (grader.mustNotInclude?.length ?? 0) +
    (grader.regex?.length ?? 0) +
    Number(grader.minLength !== undefined) +
    Number(grader.maxLength !== undefined) +
    choiceCheckCount(grader.choice) +
    Number(grader.json?.requireValid === true) +
    (grader.json?.requiredPaths?.length ?? 0) +
    Object.keys(grader.json?.equals ?? {}).length +
    Object.keys(grader.json?.includes ?? {}).length +
    Object.keys(grader.json?.arrayMinLength ?? {}).length +
    Number(grader.json?.schemaSubset !== undefined) +
    Number(grader.number?.expected !== undefined) +
    Number(grader.number?.min !== undefined) +
    Number(grader.number?.max !== undefined) +
    citationCheckCount(grader.citations)
  );
}

function choiceCheckCount(
  choice: NonNullable<EvalCase["grader"]>["choice"] | undefined,
): number {
  return choice === undefined ? 0 : 2;
}

function requireStringArray(
  value: unknown,
  path: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
}

function validateCitationIdArray(
  value: unknown,
  path: string,
  options: { required: boolean },
): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (
    (options.required && value.length === 0) ||
    value.length > MAX_CITATION_SOURCE_IDS
  ) {
    throw new Error(`${path} has invalid length`);
  }
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") throw new Error(`${itemPath} must be string`);
    validateCitationId(item, itemPath);
    if (seen.has(item)) throw new Error(`${path} has duplicate source ids`);
    seen.add(item);
  }
}

function validateCitationId(value: string, path: string): void {
  if (!CITATION_ID_REGEX.test(value)) {
    throw new Error(`${path} must be a safe citation source id`);
  }
}

function citationCheckCount(
  citations: NonNullable<EvalCase["grader"]>["citations"] | undefined,
): number {
  if (!citations) return 0;
  return (
    1 +
    (citations.requiredSourceIds?.length ?? 0) +
    Number(citations.minCitedSources !== undefined) +
    (citations.requiredClaims?.length ?? 0)
  );
}

function validateKnownKeys(
  value: Record<string, unknown>,
  keys: string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
}

function rejectUndefinedValues(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(`${path} must not be undefined`);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      rejectUndefinedValues(item, `${path}[${index}]`);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    rejectUndefinedValues(nested, `${path}.${key}`);
  }
}

function validatePrimitiveRecord(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const [key, nested] of Object.entries(value)) {
    validateJsonPath(key);
    if (!isJsonPrimitive(nested)) {
      throw new Error(`${path}.${key} must be a JSON primitive`);
    }
    if (typeof nested === "string")
      requireBoundedString(nested, `${path}.${key}`);
    if (typeof nested === "number" && !Number.isFinite(nested)) {
      throw new Error(`${path}.${key} must be finite`);
    }
  }
}

function validateStringRecord(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const [key, nested] of Object.entries(value)) {
    validateJsonPath(key);
    if (typeof nested !== "string")
      throw new Error(`${path}.${key} must be string`);
  }
}

function validateNonNegativeIntegerRecord(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const [key, nested] of Object.entries(value)) {
    validateJsonPath(key);
    requireNonNegativeInteger(nested, `${path}.${key}`);
  }
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function requireFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

function requireBoundedString(value: string, path: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${path} must be non-empty`);
  }
  if (value.length > MAX_GRADER_TERM_CHARS) {
    throw new Error(`${path} is too long`);
  }
}

function validatePositiveIntegerOption(
  value: number,
  path: string,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  if (value > max) {
    throw new Error(`${path} is too large`);
  }
  return value;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function validateJsonPath(path: string): void {
  if (
    path.length === 0 ||
    path.length > MAX_JSON_PATH_CHARS ||
    path.split(".").length > MAX_JSON_PATH_SEGMENTS
  ) {
    throw new Error(`Invalid JSON path: ${path}`);
  }
  for (const step of parseJsonPath(path)) {
    if (
      step.key === "__proto__" ||
      step.key === "prototype" ||
      step.key === "constructor"
    ) {
      throw new Error(`Invalid JSON path: ${path}`);
    }
    if (step.indexes.some((index) => index > MAX_JSON_ARRAY_INDEX)) {
      throw new Error(`Invalid JSON path: ${path}`);
    }
  }
}

function validateSafeRegex(
  pattern: string,
  path: string,
  requiredCaptures?: number,
): void {
  if (pattern.length === 0 || pattern.length > MAX_REGEX_CHARS) {
    throw new Error(`${path} has an invalid regex length`);
  }
  new RegExp(pattern, "i");
  if (requiredCaptures !== undefined) {
    validateNumericExtractionRegex(pattern, path, requiredCaptures);
    return;
  }
  validateTextRegex(pattern, path);
}

function validateTextRegex(pattern: string, path: string): void {
  if (/[()|+*{}]/.test(pattern) || /(^|[^\\])\?/.test(pattern)) {
    throw new Error(`${path} uses unsupported regex syntax`);
  }
}

function validateNumericExtractionRegex(
  pattern: string,
  path: string,
  requiredCaptures: number,
): void {
  if (/\\[1-9]/.test(pattern) || /\(\?/.test(pattern) || /\|/.test(pattern)) {
    throw new Error(`${path} uses unsupported regex syntax`);
  }
  if (countCapturingGroups(pattern) !== requiredCaptures) {
    throw new Error(`${path} must have exactly ${requiredCaptures} capture`);
  }
  const group = singleCapturingGroup(pattern);
  if (!group)
    throw new Error(`${path} must have exactly ${requiredCaptures} capture`);
  if (
    !/^(?:\\d|\[[^\]\r\n]+\])(?:[+*?]|\{\d{1,3}(?:,\d{1,3})?\})?$/.test(
      group.source,
    )
  ) {
    throw new Error(`${path} uses unsupported regex syntax`);
  }
  validateTextRegex(group.before, path);
  validateTextRegex(group.after, path);
}

function singleCapturingGroup(
  pattern: string,
): { before: string; source: string; after: string } | null {
  let open = -1;
  let close = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "(" || isEscaped(pattern, index)) continue;
    if (open !== -1) return null;
    open = index;
  }
  if (open === -1) return null;
  for (let index = open + 1; index < pattern.length; index += 1) {
    if (pattern[index] !== ")" || isEscaped(pattern, index)) continue;
    close = index;
    break;
  }
  if (close === -1) return null;
  const after = pattern.slice(close + 1);
  if (after.includes("(") || after.includes(")")) return null;
  return {
    before: pattern.slice(0, open),
    source: pattern.slice(open + 1, close),
    after,
  };
}

function countCapturingGroups(pattern: string): number {
  let count = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "(") continue;
    if (!isEscaped(pattern, index)) count += 1;
  }
  return count;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyRecord(
  _configs: DeliberationMode[],
): Record<DeliberationMode, number> {
  return Object.fromEntries(ALL_CONFIGS.map((config) => [config, 0])) as Record<
    DeliberationMode,
    number
  >;
}

function emptyNullableRecord(
  _configs: DeliberationMode[],
): Record<DeliberationMode, number | null> {
  return Object.fromEntries(
    ALL_CONFIGS.map((config) => [config, null]),
  ) as Record<DeliberationMode, number | null>;
}

function sampleRecord(
  _configs: DeliberationMode[],
): Record<DeliberationMode, number[]> {
  return Object.fromEntries(
    ALL_CONFIGS.map((config) => [config, [] as number[]]),
  ) as unknown as Record<DeliberationMode, number[]>;
}

function nullableSampleRecord(
  _configs: DeliberationMode[],
): Record<DeliberationMode, Array<number | null>> {
  return Object.fromEntries(
    ALL_CONFIGS.map((config) => [config, [] as Array<number | null>]),
  ) as unknown as Record<DeliberationMode, Array<number | null>>;
}

function emptyPairedComparison(): PairedComparison {
  return {
    paired_n: 0,
    unpaired_n: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    pass_rate_delta: null,
    mean_cost_delta_usd: null,
    incremental_cost_per_additional_pass: null,
    harm_rate: null,
  };
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function interval(values: number[]): ConfidenceInterval {
  if (values.length === 0) return { low: 0, high: 0 };
  return {
    low: quantile(values, 0.025),
    high: quantile(values, 0.975),
  };
}

function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  );
  return sorted[index] ?? 0;
}

function stableSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
