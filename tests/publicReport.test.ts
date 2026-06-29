import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildCaseSetManifest,
  runEvaluation,
  verifyCaseSetManifestBinding,
} from "../src/evaluation.js";
import { FrugalFusionOrchestrator } from "../src/orchestrator.js";
import {
  assessPublicReportClaimGate,
  buildPublicEvalReport,
  publicReportJsonParseFailureVerification,
  publicReportJsonReadFailureVerification,
  verifyPublicEvalReportArtifact,
} from "../src/publicReport.js";
import {
  buildEvalRunProvenance,
  cliEvalInvocationProvenance,
  modelIdsForRunProvenance,
} from "../src/runProvenance.js";
import type {
  PublicEvalCase,
  PublicEvalMetrics,
  PublicEvalReport,
} from "../src/publicReport.js";
import type {
  Budget,
  DeliberationMode,
  JsonSchema,
  ModelClient,
  ModelRoleConfig,
  ModelUsage,
  PriceSnapshotEntry,
} from "../src/types.js";
import { FakeModelClient } from "./fakeClient.js";

const budget: Budget = {
  maxCostUsd: 0.05,
  maxLatencyMs: 1_000,
  maxCandidates: 2,
  maxCompletionTokens: 600,
  maxRepairRounds: 1,
};

const models: ModelRoleConfig = {
  directModelId: "direct/model-secret",
  selfReviewModelId: "direct/model-secret",
  repeatedModelId: "direct/model-secret",
  candidateModels: ["candidate/a-secret", "candidate/b-secret"],
  aggregatorModelId: "aggregator/model-secret",
};

const allConfigs: DeliberationMode[] = [
  "direct",
  "self_review",
  "repeated",
  "fusion",
];
const publicDisclosureNotes = [
  "This public report is an allowlisted projection of a private evaluation report.",
  "Model identities, provider identities, price snapshots, prompts, answers, traces, usage rows, and raw case identifiers are omitted.",
  "Per-case generated row labels preserve report order; when the evaluated case file is public, row-level outcomes can be linked back to that public file.",
  "The private report is required to reproduce model/provider provenance, run-provenance fingerprints, case-manifest binding, and exact cost accounting; no private report hash, case-set digest, config digest, model digest, path, or command is included in this public artifact.",
];
const publicClaimReadinessWarnings = [
  "This public report is not evidence that the evaluated case set is a locked holdout or public benchmark.",
  "Interpret pass-rate, harm, and cost metrics together with a separate case-set manifest and private audit evidence.",
  "Category breakdowns are descriptive stratification only; generated category labels are pseudonymous and may be linkable through public case manifests.",
];
const publicGraderEvidenceNotes = [
  "Tiers are derived from configured deterministic grader families before model calls.",
  "They describe mechanical evidence shape, not task difficulty, holdout status, or semantic grading strength.",
];
const publicCategoryBreakdownNotes = [
  "Generated category IDs preserve first appearance order and are not anonymous.",
  "Trials are repeated attempts over the same cases; do not interpret trial counts as independent case counts.",
  "Category differences can be confounded by grader mix, difficulty, and prompt tuning.",
  "Grader evidence tiers are heuristic case-definition metadata, not task difficulty or semantic-grading strength.",
  "Rows below the recommended scored-case count are published only as exploratory stratification.",
  "Category-level task pass-rate and pass-rate-delta intervals resample cases within each category; category-level cost intervals are not included in the public projection.",
];

describe("buildPublicEvalReport", () => {
  it("projects a public allowlist without private report fields", async () => {
    const secret = "Acme-Private sk-or-v1-secret";
    const report = await runEvaluation(
      [
        {
          id: `case-${secret}`,
          category: `category-${secret}`,
          task: `Task for ${secret}`,
          smokeOnly: true,
        },
        {
          id: "failed-private-case",
          task: "Fail privately",
          smokeOnly: true,
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: { answer: `private answer ${secret}` },
            rawResponseId: "gen-secret",
          },
          {
            kind: "error",
            status: "provider_error",
            message: `failed for ${secret}`,
            costUsd: 0.002,
          },
        ]),
      ),
      budget,
      {
        configs: ["direct"],
        retainOutputs: true,
        retainProviderIds: true,
        retainFailureDetails: true,
        runProvenance: runProvenanceFixture(["direct"]),
      },
    );

    const leakedConfig = "direct/model-secret-extra";
    (report.metrics.scored_attempt_n as Record<string, number>)[leakedConfig] =
      999;
    (report.metrics.task_pass_rate as Record<string, number>)[leakedConfig] = 1;
    (report.metrics.position_counts as Record<string, unknown>)[leakedConfig] =
      {
        all: [999],
        scored: [999],
      };
    (
      report.metrics.confidence_intervals.task_pass_rate as Record<
        string,
        unknown
      >
    )[leakedConfig] = { low: 1, high: 1 };
    (report.metrics.paired_vs_direct as Record<string, unknown>)[leakedConfig] =
      {
        paired_n: 999,
        unpaired_n: 0,
        wins: 999,
        losses: 0,
        ties: 0,
      };
    (
      report.metrics.confidence_intervals.pass_rate_delta_vs_direct as Record<
        string,
        unknown
      >
    )[leakedConfig] = { low: 1, high: 1 };
    (
      report.metrics.confidence_intervals.cost_per_pass as Record<
        string,
        unknown
      >
    )[leakedConfig] = {
      low: 0,
      high: 0,
      available: true,
      zeroPassResamples: 0,
      undefinedRate: 0,
    };
    for (const rates of [
      report.metrics.invalid_output_rate,
      report.metrics.timeout_rate,
      report.metrics.provider_error_rate,
      report.metrics.budget_exhaustion_rate,
      report.metrics.partial_failure_rate,
      report.metrics.verification_failure_rate,
    ]) {
      (rates as Record<string, number>)[leakedConfig] = 1;
    }
    const privateInvocationMarkers = [
      "--case-manifest",
      "FRUGAL_FUSION_MANIFEST_HMAC_KEY",
      "/private/holdout.jsonl",
      ".frugal-fusion/eval-result.json",
    ];
    (report.runProvenance as unknown as Record<string, unknown>)[
      "privateInvocationMarkers"
    ] = privateInvocationMarkers;

    const publicReport = buildPublicEvalReport(report);
    const serialized = JSON.stringify(publicReport);

    expect(publicReport.schemaVersion).toBe("frugal-fusion-public-eval-v11");
    expect(publicReport.disclosure.reproducibilityLevel).toBe(
      "private-audit-only",
    );
    expect(publicReport.disclosure.caseIdentity).toBe("generated-row-labels");
    expect(publicReport.claimReadiness.status).toBe("not_benchmark");
    expect(publicReport.claimGate).toMatchObject({
      target: "public_cost_performance",
      scope: "public_projection_with_private_attestations",
      status: "public_report_blocked",
      overallClaimStatus: "external_evidence_required",
    });
    expect(publicReport.claimGate.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "missing_fusion_config",
        "too_few_scored_cases",
        "category_evidence_unavailable",
        "cost_latency_suppressed",
        "case_set_claim_gate_missing",
      ]),
    );
    expect(publicReport.disclosure.runProvenance).toMatchObject({
      status: "private_report_fields_present",
      config: {
        digestDisclosure: "omitted",
        pathDisclosure: "omitted",
      },
      modelPriceSnapshot: {
        digestDisclosure: "omitted",
        pathDisclosure: "omitted",
      },
      openRouterRequestPolicy: {
        status: "private_report_fields_present",
        content: "openrouter-fixed-baseline-request-policy-v1",
        digestDisclosure: "omitted",
      },
      providerRouting: {
        status: "private_report_fields_present",
        content: "openrouter-provider-routing-policy-v1",
        providerEndpointPinning: "single_provider_endpoint_pinned",
        detailDisclosure: "omitted",
      },
    });
    expect(publicReport.disclosure.caseSetClaimGate).toEqual({
      status: "not_provided",
    });
    expect(serialized).not.toContain("cli_eval");
    expect(serialized).not.toContain("normalized-cli-invocation-v1");
    expect(serialized).not.toContain("rawArgvDisclosure");
    expect(serialized).not.toContain("jsonl_file");
    expect(serialized).not.toContain("X-OpenRouter-Metadata");
    expect(serialized).not.toContain("disabledDefaultPluginIds");
    expect(serialized).not.toContain("requestPolicyDigest");
    expect(serialized).not.toContain("provider-secret/endpoint-secret");
    for (const marker of privateInvocationMarkers) {
      expect(serialized).not.toContain(marker);
    }
    expect("privateAudit" in publicReport.disclosure).toBe(false);
    expect(publicReport.cases.map((item) => item.publicId)).toEqual([
      "case_0001",
      "case_0002",
    ]);
    expect("traces" in publicReport).toBe(false);
    expect("runId" in publicReport).toBe(false);
    expect("caseSetHash" in publicReport).toBe(false);
    expect("caseIndex" in (publicReport.cases[0] ?? {})).toBe(false);
    expect(publicReport.metrics.task_pass_rate.direct).toBeNull();
    expect(
      "result" in (publicReport.cases[0]?.trials[0]?.outcomes[0] ?? {}),
    ).toBe(false);
    expect(
      "failure" in (publicReport.cases[1]?.trials[0]?.outcomes[0] ?? {}),
    ).toBe(false);
    expect(publicReport.metrics.cost_latency).toMatchObject({
      available: false,
      suppressedReason: "small_scored_case_count",
      minimumScoredCases: 30,
    });
    expect(publicReport.metrics.grader_evidence).toMatchObject({
      version: "grader-evidence-tier-v2",
      tier_counts: {
        smoke_only: 2,
      },
      scored_tier_counts: {
        structured_or_exact: 0,
        surface_text: 0,
        mixed: 0,
        smoke_only: 0,
        ungraded: 0,
      },
      smoke_only_case_n: 2,
      dominant_tier: null,
      dominant_tier_case_share: null,
      profile_mix: "no_scored_cases",
      small_profile_cell_warning: false,
      minimum_profile_cell_size: 5,
    });

    for (const forbidden of [
      secret,
      "direct/model-secret",
      "provider-secret",
      "gen-secret",
      "candidateAliasMap",
      "taskHash",
      "constraintsHash",
      "seedMaterialHash",
      "autoRouting",
      "budget_aware_v1",
      "selected_richest_within_budget",
      "fell_back_to_direct_over_budget",
      "estimate_unavailable_defaulted_to_direct",
      "sha256",
      "failed for",
      "category-",
      "case-Acme",
      leakedConfig,
      "resolvedConfigDigest",
      "effectivePriceSnapshotDigest",
      "caller_provided",
      "models_file",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits retained aggregation ledger fields from public reports", async () => {
    const secret = "Acme-Ledger-Secret";
    const report = await runEvaluation(
      [{ id: "fusion-ledger", task: "Smoke fusion ledger", smokeOnly: true }],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              candidateId: "a",
              conclusion: "schema",
              claims: [
                {
                  claimId: "a-1",
                  text: "schema",
                  evidenceIds: [],
                  confidence: 0.8,
                },
              ],
              reasoningOutline: [],
              alternatives: [],
              risks: [],
              unresolved: [],
            },
          },
          {
            kind: "ok",
            output: {
              candidateId: "b",
              conclusion: "fallback",
              claims: [
                {
                  claimId: "b-1",
                  text: "fallback",
                  evidenceIds: [],
                  confidence: 0.7,
                },
              ],
              reasoningOutline: [],
              alternatives: [],
              risks: [],
              unresolved: [],
            },
          },
          {
            kind: "ok",
            output: {
              answer: "schema",
              ledger: {
                consensusClaimIds: [],
                adoptedClaimIds: ["candidate_1_claim_1"],
                uniqueAdoptedClaimIds: ["candidate_1_claim_1"],
                rejectedClaims: [],
                conflicts: [],
                coverageGaps: [`unmet ${secret}`],
                blindSpots: [`risk ${secret}`],
                requiredChecks: [`check ${secret}`],
              },
            },
          },
        ]),
      ),
      budget,
      { configs: ["fusion"], retainOutputs: true },
    );

    const publicReport = buildPublicEvalReport(report);
    const serialized = JSON.stringify(publicReport);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("coverageGaps");
    expect(serialized).not.toContain("uniqueAdoptedClaimIds");
  });

  it("sanitizes malformed confidence interval metadata in public projections", async () => {
    const rawMarkers = [
      "secret-bootstrap-method",
      "secret-bootstrap-level",
      "500-secret",
      "secret-bootstrap-warning",
    ];
    const report = await runEvaluation(
      [{ id: "ci-secret", task: "Smoke CI metadata", smokeOnly: true }],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "ok" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );
    const intervals = report.metrics.confidence_intervals as unknown as Record<
      string,
      unknown
    >;
    intervals.method = rawMarkers[0];
    intervals.level = rawMarkers[1];
    intervals.resamples = rawMarkers[2];
    intervals.warnings = [
      rawMarkers[3],
      "Fewer than 30 scored cases; bootstrap intervals are exploratory.",
    ];

    const publicReport = buildPublicEvalReport(report);
    const serialized = JSON.stringify(publicReport);

    expect(publicReport.metrics.confidence_intervals).toMatchObject({
      method: null,
      level: null,
      resamples: null,
      warnings: [
        "Fewer than 30 scored cases; bootstrap intervals are exploratory.",
      ],
    });
    expect(publicReport.claimGate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "confidence_interval_contract_malformed",
          evidence: expect.objectContaining({
            confidenceIntervalMethodCaseClusterBootstrap: false,
            confidenceIntervalLevel95: false,
            confidenceIntervalResamplesPositiveInteger: false,
            confidenceIntervalResamplesAtLeastMinimum: false,
            confidenceIntervalResampleCount: null,
            minimumConfidenceIntervalResamples: 500,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("keeps only public grader check structure", async () => {
    const report = await runEvaluation(
      [
        {
          id: "numeric",
          task: "Return total",
          grader: {
            number: {
              expected: 42,
              tolerance: 0.1,
              extractionRegex: "^total=([0-9.]+)$",
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: { answer: "total=41.95" } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);

    expect(publicReport.cases[0]?.trials[0]?.outcomes[0]?.grader).toEqual({
      passed: true,
      smokeOnly: false,
      checkCounts: { total: 1, passed: 1, failed: 0 },
      checks: [{ checkIndex: 0, kind: "number_expected", passed: true }],
    });
    expect(JSON.stringify(publicReport)).not.toContain("absolute_tolerance");
    expect(JSON.stringify(publicReport)).not.toContain("41.95");
  });

  it("includes rounded cost uncertainty when public cost metrics are available", async () => {
    const cases = Array.from({ length: 30 }, (_, index) => ({
      id: `case-${index}`,
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    }));
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient(
          cases.map(() => ({ kind: "ok", output: { answer: "schema" } })),
        ),
      ),
      budget,
      { configs: ["direct"], bootstrapSamples: 20 },
    );

    const publicReport = buildPublicEvalReport(report);

    expect(publicReport.metrics.cost_latency).toMatchObject({
      available: true,
      cost_per_pass_interval_usd: {
        direct: {
          available: true,
          undefinedRate: 0,
        },
      },
    });
  });

  it("marks public report constraints met while still requiring external evidence", () => {
    const metrics = publicMetricsFixture();
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate).toMatchObject({
      target: "public_cost_performance",
      scope: "public_projection_with_private_attestations",
      status: "public_report_constraints_met",
      overallClaimStatus: "external_evidence_required",
      directionalComparison: {
        status: "fusion_directionally_better",
        basis: "fusion_pass_rate_delta_ci",
        passRateDeltaVsDirect: { low: 0.02, high: 0.12 },
      },
      minimums: {
        scoredCases: 100,
        scoredCasesPerCategory: 30,
        nonSurfaceGraderEvidenceCases: 5,
        nonSurfaceGraderEvidenceCasesPerCategory: 5,
      },
    });
    expect(gate.blockers).toEqual([]);
    expect(gate.blockers.map((item) => item.code)).not.toContain(
      "confidence_interval_contract_malformed",
    );
    expect(gate.externalEvidenceRequired.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "frozen_manifest_bound_to_report",
        "holdout_process_record",
        "private_reproduction_package",
      ]),
    );
  });

  it("blocks public report claims when the top-level public schema is stale", () => {
    const staleSchemaMarker = "frugal-fusion-public-eval-v10";
    const gate = assessPublicReportClaimGate({
      schemaVersion:
        staleSchemaMarker as unknown as PublicEvalReport["schemaVersion"],
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_schema_version_unsupported",
          evidence: { publicReportSchemaVersionKnown: false },
        }),
      ]),
    );
    expect(serialized).not.toContain(staleSchemaMarker);
  });

  it.each([
    {
      label: "secret method",
      overrides: {
        method:
          "secret-bootstrap-method" as PublicEvalMetrics["confidence_intervals"]["method"],
      },
      evidence: {
        confidenceIntervalMethodCaseClusterBootstrap: false,
        confidenceIntervalLevel95: true,
        confidenceIntervalResamplesPositiveInteger: true,
        confidenceIntervalResamplesAtLeastMinimum: true,
        confidenceIntervalResampleCount: 500,
        minimumConfidenceIntervalResamples: 500,
      },
      rawMarker: "secret-bootstrap-method",
    },
    {
      label: "wrong level",
      overrides: {
        level: 0.9 as PublicEvalMetrics["confidence_intervals"]["level"],
      },
      evidence: {
        confidenceIntervalMethodCaseClusterBootstrap: true,
        confidenceIntervalLevel95: false,
        confidenceIntervalResamplesPositiveInteger: true,
        confidenceIntervalResamplesAtLeastMinimum: true,
        confidenceIntervalResampleCount: 500,
        minimumConfidenceIntervalResamples: 500,
      },
    },
    {
      label: "zero resamples",
      overrides: { resamples: 0 },
      evidence: {
        confidenceIntervalMethodCaseClusterBootstrap: true,
        confidenceIntervalLevel95: true,
        confidenceIntervalResamplesPositiveInteger: false,
        confidenceIntervalResamplesAtLeastMinimum: false,
        confidenceIntervalResampleCount: 0,
        minimumConfidenceIntervalResamples: 500,
      },
    },
    {
      label: "below public floor",
      overrides: { resamples: 499 },
      evidence: {
        confidenceIntervalMethodCaseClusterBootstrap: true,
        confidenceIntervalLevel95: true,
        confidenceIntervalResamplesPositiveInteger: true,
        confidenceIntervalResamplesAtLeastMinimum: false,
        confidenceIntervalResampleCount: 499,
        minimumConfidenceIntervalResamples: 500,
      },
    },
    {
      label: "non-integer resamples",
      overrides: { resamples: 12.5 },
      evidence: {
        confidenceIntervalMethodCaseClusterBootstrap: true,
        confidenceIntervalLevel95: true,
        confidenceIntervalResamplesPositiveInteger: false,
        confidenceIntervalResamplesAtLeastMinimum: false,
        confidenceIntervalResampleCount: null,
        minimumConfidenceIntervalResamples: 500,
      },
    },
    {
      label: "secret string resamples",
      overrides: { resamples: "500-secret" as unknown as number },
      evidence: {
        confidenceIntervalMethodCaseClusterBootstrap: true,
        confidenceIntervalLevel95: true,
        confidenceIntervalResamplesPositiveInteger: false,
        confidenceIntervalResamplesAtLeastMinimum: false,
        confidenceIntervalResampleCount: null,
        minimumConfidenceIntervalResamples: 500,
      },
      rawMarker: "500-secret",
    },
  ])(
    "blocks public report claims when confidence interval contract is malformed: $label",
    (testCase) => {
      const base = publicMetricsFixture();
      const metrics = publicMetricsFixture({
        confidence_intervals: {
          ...base.confidence_intervals,
          ...testCase.overrides,
        },
      });

      const gate = assessPublicReportClaimGate({
        schemaVersion: "frugal-fusion-public-eval-v11",
        configs: allConfigs,
        disclosure: publicDisclosureFixture(
          boundCaseManifestDisclosure(),
          boundRunProvenanceDisclosure(),
          boundCaseSetClaimGateDisclosure(),
        ),
        metrics,
      });
      const serialized = JSON.stringify(gate);

      expect(gate.status).toBe("public_report_blocked");
      expect(gate.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "confidence_interval_contract_malformed",
            evidence: testCase.evidence,
          }),
        ]),
      );
      if (testCase.rawMarker) {
        expect(serialized).not.toContain(testCase.rawMarker);
      }
    },
  );

  it("blocks public report claims when the fixed MVP matrix is incomplete", () => {
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: ["direct", "fusion"],
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_self_review_config",
          evidence: { requiredConfig: "self_review" },
        }),
        expect.objectContaining({
          code: "missing_repeated_config",
          evidence: { requiredConfig: "repeated" },
        }),
        expect.objectContaining({
          code: "run_provenance_config_count_mismatch",
          evidence: {
            runProvenanceEvaluatedConfigCount: 4,
            publicReportConfigCount: 2,
            requiredConfigCount: 4,
          },
        }),
      ]),
    );
    expect(gate.blockers.map((item) => item.code)).not.toEqual(
      expect.arrayContaining([
        "self_review_scored_attempts_unavailable",
        "repeated_scored_attempts_unavailable",
      ]),
    );
    expect(serialized).not.toContain("model-secret");
    expect(serialized).not.toContain("direct/model-secret");
  });

  it.each([
    {
      label: "unknown config replaces a required config",
      configs: ["direct", "self_review", "repeated", "secret/model-id"],
      evidence: {
        publicConfigsArray: true,
        publicConfigsRecognized: false,
        publicConfigsDistinct: true,
        publicConfigCount: 4,
        requiredConfigCount: 4,
      },
      rawMarker: "secret/model-id",
    },
    {
      label: "duplicate fixed config",
      configs: ["direct", "self_review", "repeated", "fusion", "fusion"],
      evidence: {
        publicConfigsArray: true,
        publicConfigsRecognized: true,
        publicConfigsDistinct: false,
        publicConfigCount: 5,
        requiredConfigCount: 4,
      },
      rawMarker: "secret/model-id",
    },
    {
      label: "extra unknown config",
      configs: [
        "direct",
        "self_review",
        "repeated",
        "fusion",
        "secret/extra-config",
      ],
      evidence: {
        publicConfigsArray: true,
        publicConfigsRecognized: false,
        publicConfigsDistinct: true,
        publicConfigCount: 5,
        requiredConfigCount: 4,
      },
      rawMarker: "secret/extra-config",
    },
    {
      label: "non-array configs",
      configs: "secret/non-array-config",
      evidence: {
        publicConfigsArray: false,
        publicConfigsRecognized: true,
        publicConfigsDistinct: true,
        publicConfigCount: 0,
        requiredConfigCount: 4,
      },
      rawMarker: "secret/non-array-config",
    },
  ])(
    "blocks public report claims when config contract is malformed: $label",
    (testCase) => {
      const gate = assessPublicReportClaimGate({
        schemaVersion: "frugal-fusion-public-eval-v11",
        configs: testCase.configs as unknown as DeliberationMode[],
        disclosure: publicDisclosureFixture(
          boundCaseManifestDisclosure(),
          boundRunProvenanceDisclosure(),
          boundCaseSetClaimGateDisclosure(),
        ),
        metrics: publicMetricsFixture(),
      });
      const serialized = JSON.stringify(gate);

      expect(gate.status).toBe("public_report_blocked");
      expect(gate.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "public_config_contract_malformed",
            evidence: testCase.evidence,
          }),
        ]),
      );
      expect(serialized).not.toContain(testCase.rawMarker);
    },
  );

  it("blocks public report claims when required config metric cells are unavailable", () => {
    const base = publicMetricsFixture();
    const costLatency = base.cost_latency;
    if (!costLatency.available) throw new Error("expected cost latency");
    const metrics = publicMetricsFixture({
      scored_attempt_n: {
        ...base.scored_attempt_n,
        self_review: 0,
      },
      task_pass_rate: {
        ...base.task_pass_rate,
        repeated: null,
      },
      confidence_intervals: {
        ...base.confidence_intervals,
        task_pass_rate: {
          ...base.confidence_intervals.task_pass_rate,
          repeated: null,
        },
      },
      cost_latency: {
        ...costLatency,
        cost_per_pass_interval_usd: {
          ...costLatency.cost_per_pass_interval_usd,
          self_review: {
            low: null,
            high: null,
            available: false,
            undefinedRate: 1,
          },
        },
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "self_review_scored_attempts_unavailable",
        "repeated_task_pass_rate_unavailable",
        "repeated_task_pass_rate_interval_unavailable",
        "self_review_cost_per_pass_interval_unavailable",
      ]),
    );
    expect(gate.blockers.map((item) => item.code)).not.toEqual(
      expect.arrayContaining([
        "missing_self_review_config",
        "missing_repeated_config",
      ]),
    );
  });

  it("blocks public report claims when required config scored-attempt coverage is incomplete", () => {
    const base = publicMetricsFixture();
    const metrics = publicMetricsFixture({
      scored_attempt_n: {
        ...base.scored_attempt_n,
        self_review: 1,
        repeated: base.scored_trial_n - 1,
      },
      scored_attempt_coverage: {
        ...base.scored_attempt_coverage,
        self_review: {
          expected_scored_case_trial_n: base.scored_trial_n,
          observed_scored_attempt_n: 1,
          incomplete_scored_case_trial_n: base.scored_trial_n - 1,
          complete: false,
        },
        repeated: {
          expected_scored_case_trial_n: base.scored_trial_n,
          observed_scored_attempt_n: base.scored_trial_n - 1,
          incomplete_scored_case_trial_n: 1,
          complete: false,
        },
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "self_review_scored_attempt_coverage_incomplete",
          evidence: {
            config: "self_review",
            scoredAttemptCount: 1,
            scoredTrialCount: 120,
            incompleteScoredCaseTrialCount: 119,
          },
        }),
        expect.objectContaining({
          code: "repeated_scored_attempt_coverage_incomplete",
          evidence: {
            config: "repeated",
            scoredAttemptCount: 119,
            scoredTrialCount: 120,
            incompleteScoredCaseTrialCount: 1,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when scored-attempt counts hide duplicate or missing case-trials", () => {
    const base = publicMetricsFixture();
    const metrics = publicMetricsFixture({
      scored_attempt_coverage: {
        ...base.scored_attempt_coverage,
        self_review: {
          expected_scored_case_trial_n: base.scored_trial_n,
          observed_scored_attempt_n: base.scored_trial_n,
          incomplete_scored_case_trial_n: 2,
          complete: false,
        },
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "self_review_scored_attempt_coverage_incomplete",
          evidence: {
            config: "self_review",
            scoredAttemptCount: 120,
            scoredTrialCount: 120,
            incompleteScoredCaseTrialCount: 2,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when scored-attempt coverage diagnostics contradict themselves", () => {
    const base = publicMetricsFixture();
    const metrics = publicMetricsFixture({
      scored_attempt_coverage: {
        ...base.scored_attempt_coverage,
        self_review: {
          expected_scored_case_trial_n: base.scored_trial_n,
          observed_scored_attempt_n: base.scored_trial_n,
          incomplete_scored_case_trial_n: 2,
          complete: true,
        },
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "self_review_scored_attempt_coverage_incomplete",
          evidence: {
            config: "self_review",
            scoredAttemptCount: 120,
            scoredTrialCount: 120,
            incompleteScoredCaseTrialCount: 2,
          },
        }),
      ]),
    );
  });

  it("blocks instead of throwing when scored-attempt coverage diagnostics are missing", () => {
    const metrics = publicMetricsFixture();
    delete (metrics as Partial<PublicEvalMetrics>).scored_attempt_coverage;

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "direct_scored_attempt_coverage_incomplete",
          evidence: {
            config: "direct",
            scoredAttemptCount: 120,
            scoredTrialCount: 120,
            incompleteScoredCaseTrialCount: null,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when the top-level disclosure contract is malformed", () => {
    const rawMarkers = [
      "direct/model-secret",
      "$0.000001-secret",
      "prompt-secret",
      "case-secret",
      "trace-secret",
      "public-repro-secret",
    ];
    const disclosure = {
      ...publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      modelDisclosure: rawMarkers[0],
      priceDisclosure: rawMarkers[1],
      promptDisclosure: rawMarkers[2],
      caseIdentity: rawMarkers[3],
      traceDisclosure: rawMarkers[4],
      reproducibilityLevel: rawMarkers[5],
    } as unknown as PublicEvalReport["disclosure"];

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            publicDisclosureRootShapeStrict: true,
            modelDisclosureRedacted: false,
            priceDisclosureRedacted: false,
            promptDisclosureRedacted: false,
            caseIdentityGeneratedRowLabels: false,
            traceDisclosureOmitted: false,
            reproducibilityPrivateAuditOnly: false,
            caseManifestDigestOmitted: true,
            caseManifestNotProvidedShapeStrict: true,
            caseSetClaimGateNotProvidedShapeStrict: true,
            caseSetClaimGateDetailOmitted: true,
            runProvenanceNotProvidedShapeStrict: true,
            runProvenancePresentShapeStrict: true,
            runProvenanceSchemaVersionKnown: true,
            runProvenanceFingerprintVersionKnown: true,
            runProvenanceCanonicalizationKnown: true,
            runConfigPresentShapeStrict: true,
            runConfigContentKnown: true,
            runConfigDigestOmitted: true,
            runConfigPathOmitted: true,
            runModelPricePresentShapeStrict: true,
            runModelPriceContentKnown: true,
            runModelPriceDigestOmitted: true,
            runModelPricePathOmitted: true,
            openRouterRequestPolicyDigestOmitted: true,
            openRouterRequestPolicyContentKnown: true,
            openRouterRequestPolicyNotProvidedShapeStrict: true,
            openRouterRequestPolicyPresentShapeStrict: true,
            providerRoutingDetailOmitted: true,
            providerRoutingContentKnown: true,
            providerRoutingNotProvidedShapeStrict: true,
            providerRoutingPresentShapeStrict: true,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when nested no-digest disclosure fields are malformed", () => {
    const rawMarkers = [
      "case-manifest-digest-secret",
      "config-digest-secret",
      "/private/config-secret.json",
      "price-digest-secret",
      "/private/prices-secret.json",
      "provider-routing-secret",
    ];
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const disclosure = {
      ...publicDisclosureFixture(
        {
          ...boundCaseManifestDisclosure(),
          digestDisclosure: rawMarkers[0],
        } as unknown as PublicEvalReport["disclosure"]["caseSetManifestBinding"],
        {
          ...runProvenance,
          config: {
            ...runProvenance.config,
            digestDisclosure: rawMarkers[1],
            pathDisclosure: rawMarkers[2],
          },
          modelPriceSnapshot: {
            ...runProvenance.modelPriceSnapshot,
            digestDisclosure: rawMarkers[3],
            pathDisclosure: rawMarkers[4],
          },
          providerRouting: {
            ...runProvenance.providerRouting,
            detailDisclosure: rawMarkers[5],
          },
        } as unknown as PublicEvalReport["disclosure"]["runProvenance"],
        boundCaseSetClaimGateDisclosure(),
      ),
    };

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            modelDisclosureRedacted: true,
            priceDisclosureRedacted: true,
            promptDisclosureRedacted: true,
            caseIdentityGeneratedRowLabels: true,
            traceDisclosureOmitted: true,
            reproducibilityPrivateAuditOnly: true,
            caseManifestDigestOmitted: false,
            caseManifestNotProvidedShapeStrict: true,
            caseSetClaimGateNotProvidedShapeStrict: true,
            caseSetClaimGateDetailOmitted: true,
            runProvenanceNotProvidedShapeStrict: true,
            runConfigDigestOmitted: false,
            runConfigPathOmitted: false,
            runModelPriceDigestOmitted: false,
            runModelPricePathOmitted: false,
            providerRoutingDetailOmitted: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when run-provenance contract labels are stale", () => {
    const rawMarkers = [
      "PRIVATE-RUN-SCHEMA",
      "PRIVATE-RUN-FINGERPRINT",
      "PRIVATE-CANONICALIZATION",
      "PRIVATE-CONFIG-CONTENT",
      "PRIVATE-PRICE-CONTENT",
    ];
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const disclosure = publicDisclosureFixture(
      boundCaseManifestDisclosure(),
      {
        ...runProvenance,
        schemaVersion: rawMarkers[0],
        fingerprintVersion: rawMarkers[1],
        canonicalization: rawMarkers[2],
        config: {
          ...runProvenance.config,
          content: rawMarkers[3],
        },
        modelPriceSnapshot: {
          ...runProvenance.modelPriceSnapshot,
          content: rawMarkers[4],
        },
      } as unknown as PublicEvalReport["disclosure"]["runProvenance"],
      boundCaseSetClaimGateDisclosure(),
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            runProvenancePresentShapeStrict: true,
            runProvenanceSchemaVersionKnown: false,
            runProvenanceFingerprintVersionKnown: false,
            runProvenanceCanonicalizationKnown: false,
            runConfigPresentShapeStrict: true,
            runConfigContentKnown: false,
            runModelPricePresentShapeStrict: true,
            runModelPriceContentKnown: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when present run-provenance disclosure shapes have extra fields", () => {
    const rawMarkers = [
      "PRIVATE-RUN-ROOT",
      "PRIVATE-CONFIG-DIGEST",
      "PRIVATE-PRICE-DIGEST",
      "PRIVATE-REQUEST-POLICY",
      "PRIVATE-PROVIDER-ROUTING",
    ];
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const disclosure = publicDisclosureFixture(
      boundCaseManifestDisclosure(),
      {
        ...runProvenance,
        privateRoot: rawMarkers[0],
        config: {
          ...runProvenance.config,
          resolvedConfigDigest: rawMarkers[1],
        },
        modelPriceSnapshot: {
          ...runProvenance.modelPriceSnapshot,
          effectivePriceSnapshotDigest: rawMarkers[2],
        },
        openRouterRequestPolicy: {
          ...runProvenance.openRouterRequestPolicy,
          requestPolicyDigest: rawMarkers[3],
        },
        providerRouting: {
          ...runProvenance.providerRouting,
          orderedProviderSlugs: [rawMarkers[4]],
        },
      } as unknown as PublicEvalReport["disclosure"]["runProvenance"],
      boundCaseSetClaimGateDisclosure(),
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            runProvenancePresentShapeStrict: false,
            runConfigPresentShapeStrict: false,
            runModelPricePresentShapeStrict: false,
            openRouterRequestPolicyPresentShapeStrict: false,
            providerRoutingPresentShapeStrict: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when the disclosure root carries extra fields", () => {
    const rawMarker = "PRIVATE-ROOT-AUDIT-SECRET";
    const disclosure = {
      ...publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      privateAudit: rawMarker,
    } as unknown as PublicEvalReport["disclosure"];

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            publicDisclosureRootShapeStrict: false,
          }),
        }),
      ]),
    );
    expect(serialized).not.toContain(rawMarker);
  });

  it("blocks public report claims when a bound case-manifest disclosure carries extra fields", () => {
    const rawMarkers = [
      "PRIVATE-MANIFEST-RAW-DIGEST",
      "PRIVATE-MANIFEST-ROW-HASH",
    ];
    const disclosure = publicDisclosureFixture(
      {
        ...boundCaseManifestDisclosure(),
        rawFileSha256: rawMarkers[0],
        rowHashes: [rawMarkers[1]],
      } as unknown as PublicEvalReport["disclosure"]["caseSetManifestBinding"],
      boundRunProvenanceDisclosure(),
      boundCaseSetClaimGateDisclosure(),
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            caseSetManifestBindingPresentShapeStrict: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when bound case-manifest labels are unsupported", () => {
    const rawMarkers = [
      "PRIVATE-MANIFEST-SCHEMA",
      "PRIVATE-MANIFEST-FINGERPRINT",
      "PRIVATE-MANIFEST-CANONICALIZATION",
      "PRIVATE-MANIFEST-CONTENT",
    ];
    const disclosure = publicDisclosureFixture(
      {
        ...boundCaseManifestDisclosure(),
        schemaVersion: rawMarkers[0],
        fingerprintVersion: rawMarkers[1],
        canonicalization: rawMarkers[2],
        content: rawMarkers[3],
      } as unknown as PublicEvalReport["disclosure"]["caseSetManifestBinding"],
      boundRunProvenanceDisclosure(),
      boundCaseSetClaimGateDisclosure(),
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            caseSetManifestBindingPresentShapeStrict: true,
            caseManifestSchemaVersionKnown: false,
            caseManifestFingerprintVersionKnown: false,
            caseManifestCanonicalizationKnown: false,
            caseManifestContentKnown: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when a bound case-set claim-gate disclosure carries extra fields", () => {
    const rawMarkers = [
      "PRIVATE-CASE-GATE-BLOCKER",
      "PRIVATE-CASE-GATE-DETAIL",
    ];
    const disclosure = publicDisclosureFixture(
      boundCaseManifestDisclosure(),
      boundRunProvenanceDisclosure(),
      {
        ...boundCaseSetClaimGateDisclosure(),
        blockers: [rawMarkers[0]],
        details: rawMarkers[1],
      } as unknown as PublicEvalReport["disclosure"]["caseSetClaimGate"],
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            caseSetClaimGatePresentShapeStrict: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks instead of throwing when disclosure omits nested attestation fields", () => {
    const {
      caseSetManifestBinding: _caseSetManifestBinding,
      caseSetClaimGate: _caseSetClaimGate,
      runProvenance: _runProvenance,
      ...withoutNestedDisclosures
    } = publicDisclosureFixture();

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure:
        withoutNestedDisclosures as unknown as PublicEvalReport["disclosure"],
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            publicDisclosureRootShapeStrict: false,
          }),
        }),
        expect.objectContaining({
          code: "case_manifest_binding_malformed",
          evidence: { caseSetManifestBindingStatus: null },
        }),
        expect.objectContaining({
          code: "case_set_claim_gate_malformed",
          evidence: { caseSetClaimGateStatus: null },
        }),
        expect.objectContaining({
          code: "run_provenance_malformed",
          evidence: { runProvenanceStatus: null },
        }),
      ]),
    );
  });

  it("blocks instead of throwing when present run-provenance disclosure omits nested fields", () => {
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const {
      config: _config,
      modelPriceSnapshot: _modelPriceSnapshot,
      ...withoutNestedProvenance
    } = runProvenance;
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        withoutNestedProvenance as PublicEvalReport["disclosure"]["runProvenance"],
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            runProvenancePresentShapeStrict: false,
            runConfigPresentShapeStrict: false,
            runModelPricePresentShapeStrict: false,
          }),
        }),
        expect.objectContaining({
          code: "run_provenance_incomplete",
          evidence: {
            runProvenanceStatus: "private_report_fields_present",
            configProvenanceStatus: null,
            modelPriceProvenanceStatus: null,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when not-provided disclosure variants carry extra fields", () => {
    const rawMarkers = [
      "case-manifest-digest-secret",
      "claim-gate-detail-secret",
      "claim-gate-payload-secret",
      "config-digest-secret",
      "/private/config-secret.json",
      "price-digest-secret",
      "/private/prices-secret.json",
      "provider-routing-secret",
    ];
    const disclosure = publicDisclosureFixture(
      {
        status: "not_provided",
        digestDisclosure: rawMarkers[0],
      } as unknown as PublicEvalReport["disclosure"]["caseSetManifestBinding"],
      {
        status: "not_provided",
        config: {
          digestDisclosure: rawMarkers[3],
          pathDisclosure: rawMarkers[4],
        },
        modelPriceSnapshot: {
          digestDisclosure: rawMarkers[5],
          pathDisclosure: rawMarkers[6],
        },
        providerRouting: {
          detailDisclosure: rawMarkers[7],
        },
      } as unknown as PublicEvalReport["disclosure"]["runProvenance"],
      {
        status: "not_provided",
        detailDisclosure: rawMarkers[1],
        details: rawMarkers[2],
      } as unknown as PublicEvalReport["disclosure"]["caseSetClaimGate"],
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_disclosure_contract_malformed",
          evidence: expect.objectContaining({
            caseManifestDigestOmitted: false,
            caseManifestNotProvidedShapeStrict: false,
            caseSetClaimGateNotProvidedShapeStrict: false,
            caseSetClaimGateDetailOmitted: false,
            runProvenanceNotProvidedShapeStrict: false,
            runConfigDigestOmitted: false,
            runConfigPathOmitted: false,
            runModelPriceDigestOmitted: false,
            runModelPricePathOmitted: false,
            providerRoutingDetailOmitted: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("sanitizes malformed disclosure enum evidence before returning blockers", () => {
    const rawMarkers = [
      "manifest-use-secret",
      "manifest-hash-secret",
      "manifest-privacy-secret",
      "config-status-secret",
      "price-status-secret",
      "claim-status-secret",
      "run-status-secret",
    ];
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const disclosure = publicDisclosureFixture(
      {
        ...boundCaseManifestDisclosure(),
        intendedUse: rawMarkers[0],
        hashAlgorithm: rawMarkers[1],
        privacyClass: rawMarkers[2],
      } as unknown as PublicEvalReport["disclosure"]["caseSetManifestBinding"],
      {
        ...runProvenance,
        config: {
          ...runProvenance.config,
          status: rawMarkers[3],
        },
        modelPriceSnapshot: {
          ...runProvenance.modelPriceSnapshot,
          status: rawMarkers[4],
        },
      } as unknown as PublicEvalReport["disclosure"]["runProvenance"],
      {
        ...boundCaseSetClaimGateDisclosure(),
        status: rawMarkers[5],
      } as unknown as PublicEvalReport["disclosure"]["caseSetClaimGate"],
    );
    const malformedRunStatusDisclosure = publicDisclosureFixture(
      boundCaseManifestDisclosure(),
      {
        ...runProvenance,
        status: rawMarkers[6],
      } as unknown as PublicEvalReport["disclosure"]["runProvenance"],
      boundCaseSetClaimGateDisclosure(),
    );

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure,
      metrics: publicMetricsFixture(),
    });
    const malformedRunStatusGate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: malformedRunStatusDisclosure,
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify([gate, malformedRunStatusGate]);

    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "case_manifest_not_holdout",
          evidence: { manifestIntendedUse: null },
        }),
        expect.objectContaining({
          code: "case_manifest_not_private_audit_hmac",
          evidence: {
            manifestHashAlgorithm: null,
            manifestPrivacyClass: null,
          },
        }),
        expect.objectContaining({
          code: "run_provenance_incomplete",
          evidence: {
            runProvenanceStatus: "private_report_fields_present",
            configProvenanceStatus: null,
            modelPriceProvenanceStatus: null,
          },
        }),
        expect.objectContaining({
          code: "case_set_claim_gate_malformed",
          evidence: { caseSetClaimGateStatus: null },
        }),
      ]),
    );
    expect(malformedRunStatusGate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "run_provenance_malformed",
          evidence: { runProvenanceStatus: null },
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when run provenance is missing", () => {
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(boundCaseManifestDisclosure()),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "run_provenance_missing",
          evidence: { runProvenanceStatus: "not_provided" },
        }),
      ]),
    );
    expect(gate.blockers.map((item) => item.code)).not.toContain(
      "run_provenance_config_count_mismatch",
    );
    expect(gate.overallClaimStatus).toBe("external_evidence_required");
  });

  it("blocks public report claims when OpenRouter request-policy provenance is missing", () => {
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const { openRouterRequestPolicy: _omitted, ...withoutPolicy } =
      runProvenance;
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        withoutPolicy as PublicEvalReport["disclosure"]["runProvenance"],
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "openrouter_request_policy_missing",
          evidence: {
            runProvenanceStatus: "private_report_fields_present",
            openRouterRequestPolicyStatus: null,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when OpenRouter request-policy disclosure is malformed", () => {
    const malformedPolicies = [
      {
        status: "private_report_fields_present",
        content: "PRIVATE-OPENROUTER-POLICY-DETAIL",
        digestDisclosure: "omitted",
      },
      {
        status: "private_report_fields_present",
        content: "openrouter-fixed-baseline-request-policy-v1",
      },
      {
        status: "private_report_fields_present",
        content: "openrouter-fixed-baseline-request-policy-v1",
        digestDisclosure: "omitted",
        requestPolicyDigest: "PRIVATE-DIGEST",
        metadataHeader: "PRIVATE-HEADER",
      },
    ] as const;

    for (const openRouterRequestPolicy of malformedPolicies) {
      const runProvenance = boundRunProvenanceDisclosure();
      if (runProvenance.status !== "private_report_fields_present") {
        throw new Error("expected bound run provenance");
      }
      const gate = assessPublicReportClaimGate({
        schemaVersion: "frugal-fusion-public-eval-v11",
        configs: allConfigs,
        disclosure: publicDisclosureFixture(
          boundCaseManifestDisclosure(),
          {
            ...runProvenance,
            openRouterRequestPolicy,
          } as PublicEvalReport["disclosure"]["runProvenance"],
          boundCaseSetClaimGateDisclosure(),
        ),
        metrics: publicMetricsFixture(),
      });
      const serialized = JSON.stringify(gate);

      expect(gate.status).toBe("public_report_blocked");
      const blockerCodes = gate.blockers.map((item) => item.code);
      expect(blockerCodes).toContain("public_disclosure_contract_malformed");
      if (
        "digestDisclosure" in openRouterRequestPolicy &&
        openRouterRequestPolicy.content ===
          "openrouter-fixed-baseline-request-policy-v1"
      ) {
        expect(blockerCodes).not.toContain("openrouter_request_policy_missing");
      } else {
        expect(blockerCodes).toContain("openrouter_request_policy_missing");
      }
      expect(serialized).not.toContain("PRIVATE-OPENROUTER-POLICY-DETAIL");
      expect(serialized).not.toContain("PRIVATE-DIGEST");
      expect(serialized).not.toContain("PRIVATE-HEADER");
    }
  });

  it("blocks public report claims when provider endpoint pinning is absent or not exact", () => {
    const statuses = [
      "not_configured",
      "fallbacks_allowed",
      "multiple_provider_endpoints_allowed",
      "base_provider_slug_only",
    ] as const;

    for (const providerEndpointPinning of statuses) {
      const gate = assessPublicReportClaimGate({
        schemaVersion: "frugal-fusion-public-eval-v11",
        configs: allConfigs,
        disclosure: publicDisclosureFixture(
          boundCaseManifestDisclosure(),
          boundRunProvenanceDisclosure(4, providerEndpointPinning),
          boundCaseSetClaimGateDisclosure(),
        ),
        metrics: publicMetricsFixture(),
      });

      expect(gate.status).toBe("public_report_blocked");
      expect(gate.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "provider_endpoint_pinning_missing",
            evidence: {
              runProvenanceStatus: "private_report_fields_present",
              providerRoutingStatus: "private_report_fields_present",
              providerEndpointPinning,
            },
          }),
        ]),
      );
    }
  });

  it("blocks public report claims when provider routing disclosure is malformed", () => {
    const rawMarkers = [
      "PRIVATE-PROVIDER-ROUTING-CONTENT",
      "provider-secret/endpoint-secret",
    ];
    const runProvenance = boundRunProvenanceDisclosure();
    if (runProvenance.status !== "private_report_fields_present") {
      throw new Error("expected bound run provenance");
    }
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        {
          ...runProvenance,
          providerRouting: {
            status: "private_report_fields_present",
            content: rawMarkers[0],
            providerEndpointPinning: rawMarkers[1],
            detailDisclosure: "omitted",
          },
        } as PublicEvalReport["disclosure"]["runProvenance"],
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "public_disclosure_contract_malformed",
        "provider_endpoint_pinning_missing",
      ]),
    );
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "provider_endpoint_pinning_missing",
          evidence: {
            runProvenanceStatus: "private_report_fields_present",
            providerRoutingStatus: "private_report_fields_present",
            providerEndpointPinning: null,
          },
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report claims when run provenance config count is too low", () => {
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(3),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "run_provenance_config_count_mismatch",
          evidence: {
            runProvenanceEvaluatedConfigCount: 3,
            publicReportConfigCount: 4,
            requiredConfigCount: 4,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when run provenance config count is too high", () => {
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(5),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "run_provenance_config_count_mismatch",
          evidence: {
            runProvenanceEvaluatedConfigCount: 5,
            publicReportConfigCount: 4,
            requiredConfigCount: 4,
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when the private case-set claim gate is blocked", () => {
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        {
          status: "private_report_blocked",
          target: "public_cost_performance",
          scope: "case_set_only",
          overallClaimStatus: "external_evidence_required",
          detailDisclosure: "omitted",
        },
      ),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "case_set_claim_gate_blocked",
          evidence: { caseSetClaimGateStatus: "private_report_blocked" },
        }),
      ]),
    );
  });

  it("blocks public report claims when case-set claim-gate disclosure is malformed", () => {
    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        {
          status: "private_report_constraints_met",
          target: "unexpected_target",
          scope: "case_set_only",
          overallClaimStatus: "external_evidence_required",
          detailDisclosure: "omitted",
        } as unknown as PublicEvalReport["disclosure"]["caseSetClaimGate"],
      ),
      metrics: publicMetricsFixture(),
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "case_set_claim_gate_malformed",
          evidence: {
            caseSetClaimGateStatus: "private_report_constraints_met",
          },
        }),
      ]),
    );
  });

  it("blocks public report claims when scored grader evidence is surface-text only", () => {
    const rawLeakMarkers = [
      "PRIVATE_EXPECTED_VALUE",
      "/private/schema.json",
      "source-id-secret",
      "regex(secret)",
    ];
    const metrics = publicMetricsFixture({
      grader_evidence: {
        version: "grader-evidence-tier-v2",
        tier_counts: {
          structured_or_exact: 0,
          surface_text: 120,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        scored_tier_counts: {
          structured_or_exact: 0,
          surface_text: 120,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        smoke_only_case_n: 0,
        dominant_tier: "surface_text",
        dominant_tier_case_share: 1,
        profile_mix: "single_tier",
        small_profile_cell_warning: false,
        minimum_profile_cell_size: 5,
        notes: rawLeakMarkers,
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.overallClaimStatus).toBe("external_evidence_required");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "insufficient_non_surface_grader_evidence",
          evidence: {
            scoredCaseCount: 120,
            surfaceTextCaseCount: 120,
            mixedCaseCount: 0,
            structuredOrExactCaseCount: 0,
            nonSurfaceGraderEvidenceCaseCount: 0,
            requiredNonSurfaceGraderEvidenceCases: 5,
          },
        }),
      ]),
    );
    for (const marker of rawLeakMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("allows surface-text cases when enough non-surface grader evidence is present", () => {
    const metrics = publicMetricsFixture({
      grader_evidence: {
        version: "grader-evidence-tier-v2",
        tier_counts: {
          structured_or_exact: 5,
          surface_text: 115,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        scored_tier_counts: {
          structured_or_exact: 5,
          surface_text: 115,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        smoke_only_case_n: 0,
        dominant_tier: "surface_text",
        dominant_tier_case_share: 115 / 120,
        profile_mix: "mixed_tiers",
        small_profile_cell_warning: false,
        minimum_profile_cell_size: 5,
        notes: [],
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_constraints_met");
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "insufficient_non_surface_grader_evidence",
    );
    expect(gate.warnings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "surface_text_grader_evidence_present",
        "mechanical_grader_evidence_present",
      ]),
    );
    expect(gate.overallClaimStatus).toBe("external_evidence_required");
  });

  it("blocks public report claims when category non-surface evidence is underpowered", () => {
    const categories = [
      publicCategoryMetricFixture("category_0001", 30),
      surfaceTextCategoryMetricFixture("category_0002", 30),
      surfaceTextCategoryMetricFixture("category_0003", 30),
      surfaceTextCategoryMetricFixture("category_0004", 30),
    ];
    const metrics = publicMetricsFixture({
      grader_evidence: {
        version: "grader-evidence-tier-v2",
        tier_counts: {
          structured_or_exact: 30,
          surface_text: 90,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        scored_tier_counts: {
          structured_or_exact: 30,
          surface_text: 90,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        smoke_only_case_n: 0,
        dominant_tier: "surface_text",
        dominant_tier_case_share: 0.75,
        profile_mix: "mixed_tiers",
        small_profile_cell_warning: false,
        minimum_profile_cell_size: 5,
        notes: [],
      },
      by_category: publicCategoryBreakdownFixture(categories),
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "category_non_surface_grader_evidence_underpowered",
          evidence: {
            categoryCount: 4,
            affectedCategoryCount: 3,
            minNonSurfaceGraderEvidenceCasesPerCategory: 0,
            requiredNonSurfaceGraderEvidenceCasesPerCategory: 5,
          },
        }),
      ]),
    );
    expect(serialized).not.toContain("category_0002");
  });

  it("allows mixed-only public report claims while still warning that graders are mechanical", () => {
    const mixedCategories = [
      mixedCategoryMetricFixture("category_0001", 30),
      mixedCategoryMetricFixture("category_0002", 30),
      mixedCategoryMetricFixture("category_0003", 30),
      mixedCategoryMetricFixture("category_0004", 30),
    ];
    const metrics = publicMetricsFixture({
      grader_evidence: {
        version: "grader-evidence-tier-v2",
        tier_counts: {
          structured_or_exact: 0,
          surface_text: 0,
          mixed: 120,
          smoke_only: 0,
          ungraded: 0,
        },
        scored_tier_counts: {
          structured_or_exact: 0,
          surface_text: 0,
          mixed: 120,
          smoke_only: 0,
          ungraded: 0,
        },
        smoke_only_case_n: 0,
        dominant_tier: "mixed",
        dominant_tier_case_share: 1,
        profile_mix: "single_tier",
        small_profile_cell_warning: false,
        minimum_profile_cell_size: 5,
        notes: [],
      },
      by_category: publicCategoryBreakdownFixture(mixedCategories),
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(
        boundCaseManifestDisclosure(),
        boundRunProvenanceDisclosure(),
        boundCaseSetClaimGateDisclosure(),
      ),
      metrics,
    });

    expect(gate.status).toBe("public_report_constraints_met");
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "insufficient_non_surface_grader_evidence",
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "category_non_surface_grader_evidence_underpowered",
    );
    expect(gate.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "mechanical_grader_evidence_present",
          evidence: expect.objectContaining({
            structuredOrExactCaseCount: 0,
            mixedCaseCount: 120,
          }),
        }),
      ]),
    );
  });

  it("builds an end-to-end public report with constraints-met claim-gate evidence", async () => {
    const secret = "secret-public-gate";
    const difficulties = ["easy", "medium", "hard"] as const;
    const cases = Array.from({ length: 120 }, (_, index) => ({
      id: `case-${secret}-${index}`,
      category: `category-${secret}-${Math.floor(index / 30) + 1}`,
      difficulty: difficulties[index % difficulties.length]!,
      task: `Mention schema for public gate case ${index} without leaking ${secret}`,
      grader: { exact: "schema" },
    }));
    const key = "public-report-hmac-key-32-bytes-ok";
    const caseSetManifestBinding = verifyCaseSetManifestBinding(
      cases,
      JSON.stringify(
        buildCaseSetManifest(cases, {
          intendedUse: "holdout",
          hashMode: { kind: "hmac-sha256", key },
        }),
      ),
      { hmacKey: key, verifiedAt: "2026-06-24T00:00:00.000Z" },
    );
    const report = await runEvaluation(
      cases,
      makeOrchestrator(new AutoPassClient()),
      budget,
      {
        configs: allConfigs,
        bootstrapSamples: 500,
        caseSetManifestBinding,
        runProvenance: runProvenanceFixture(allConfigs),
      },
    );

    const publicReport = buildPublicEvalReport(report);
    const serialized = JSON.stringify(publicReport);

    expect(publicReport.schemaVersion).toBe("frugal-fusion-public-eval-v11");
    expect(publicReport.claimGate).toMatchObject({
      status: "public_report_constraints_met",
      overallClaimStatus: "external_evidence_required",
      directionalComparison: {
        status: "no_clear_difference",
      },
    });
    expect(publicReport.claimGate.blockers).toEqual([]);
    expect(publicReport.disclosure.caseSetManifestBinding).toMatchObject({
      status: "private_report_bound",
      intendedUse: "holdout",
      hashAlgorithm: "hmac-sha256",
      privacyClass: "private_audit_hmac_sha256",
      digestDisclosure: "omitted",
    });
    expect(publicReport.disclosure.caseSetClaimGate).toEqual({
      status: "private_report_constraints_met",
      target: "public_cost_performance",
      scope: "case_set_only",
      overallClaimStatus: "external_evidence_required",
      detailDisclosure: "omitted",
    });
    expect(publicReport.disclosure.runProvenance).toMatchObject({
      status: "private_report_fields_present",
      schemaVersion: "frugal-fusion-run-provenance-v2",
      evaluatedConfigCount: 4,
      config: { digestDisclosure: "omitted", pathDisclosure: "omitted" },
      modelPriceSnapshot: {
        digestDisclosure: "omitted",
        pathDisclosure: "omitted",
      },
      openRouterRequestPolicy: {
        status: "private_report_fields_present",
        content: "openrouter-fixed-baseline-request-policy-v1",
        digestDisclosure: "omitted",
      },
      providerRouting: {
        status: "private_report_fields_present",
        content: "openrouter-provider-routing-policy-v1",
        providerEndpointPinning: "single_provider_endpoint_pinned",
        detailDisclosure: "omitted",
      },
    });
    expect(publicReport.metrics.by_category).toMatchObject({
      available: true,
    });
    expect(publicReport.metrics.scored_n).toBe(120);
    expect(publicReport.metrics.paired_vs_direct.fusion.paired_n).toBe(120);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("direct/model-secret");
    expect(serialized).not.toContain("requestPolicyDigest");
    expect(serialized).not.toContain("X-OpenRouter-Metadata");
    expect(serialized).not.toContain("candidate/a-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("endpoint-secret");
    expect(serialized).not.toContain(caseSetManifestBinding.digestHmacSha256);
  });

  it("blocks public report constraints when pairing, category, and cost evidence are missing", () => {
    const metrics = publicMetricsFixture({
      scored_n: 10,
      scored_trial_n: 10,
      paired_vs_direct: {
        ...record(emptyPublicPairedComparison()),
        fusion: {
          paired_n: 0,
          unpaired_n: 10,
          wins: 0,
          losses: 0,
          ties: 0,
          pass_rate_delta: null,
          harm_rate: null,
        },
      },
      confidence_intervals: {
        ...publicMetricsFixture().confidence_intervals,
        pass_rate_delta_vs_direct: record(null),
      },
      by_category: {
        available: false,
        suppressedReason: "small_scored_case_count_per_category",
        minimumScoredCasesPerCategory: 5,
        recommendedScoredCasesPerCategoryForClaims: 30,
        categoryIdentity: "generated-order-labels-not-anonymous",
      },
      cost_latency: {
        available: false,
        suppressedReason: "small_scored_case_count",
        minimumScoredCases: 30,
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "too_few_scored_cases",
        "category_evidence_unavailable",
        "fusion_pairing_unavailable",
        "fusion_pass_rate_delta_interval_unavailable",
        "cost_latency_suppressed",
      ]),
    );
    expect(JSON.stringify(gate)).not.toContain("secret");
    expect(JSON.stringify(gate)).not.toContain("model-secret");
  });

  it("blocks categories below the claim floor even when public category rows are visible", () => {
    const metrics = publicMetricsFixture({
      by_category: publicCategoryBreakdownFixture([
        {
          ...publicCategoryMetricFixture("category_0001", 29),
          belowRecommendedScoredCases: false,
        },
        publicCategoryMetricFixture("category_0002", 91),
      ]),
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "category_underpowered",
          evidence: expect.objectContaining({
            categoryCount: 2,
            underpoweredCategoryCount: 1,
            minScoredCasesPerCategory: 29,
            requiredScoredCasesPerCategory: 30,
          }),
        }),
        expect.objectContaining({
          code: "category_claim_floor_inconsistent",
          evidence: expect.objectContaining({
            categoryCount: 2,
            inconsistentCategoryCount: 1,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(gate)).not.toContain("category_0001");
  });

  it("blocks internally inconsistent public direct-vs-fusion metrics", () => {
    const metrics = publicMetricsFixture({
      scored_trial_n: 120,
      scored_attempt_n: {
        ...record(0),
        direct: 120,
        fusion: 0,
      },
      task_pass_rate: {
        ...record<number | null>(null),
        direct: 0.72,
        fusion: null,
      },
      paired_vs_direct: {
        ...record(emptyPublicPairedComparison()),
        fusion: {
          paired_n: 121,
          unpaired_n: 0,
          wins: 16,
          losses: 5,
          ties: 100,
          pass_rate_delta: 0.09,
          harm_rate: 0.04,
        },
      },
      confidence_intervals: {
        ...publicMetricsFixture().confidence_intervals,
        task_pass_rate: {
          ...record(null),
          direct: { low: 0.63, high: 0.8 },
          fusion: null,
        },
      },
    });

    const gate = assessPublicReportClaimGate({
      schemaVersion: "frugal-fusion-public-eval-v11",
      configs: allConfigs,
      disclosure: publicDisclosureFixture(),
      metrics,
    });

    expect(gate.status).toBe("public_report_blocked");
    expect(gate.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "fusion_scored_attempts_unavailable",
        "fusion_task_pass_rate_unavailable",
        "fusion_task_pass_rate_interval_unavailable",
        "fusion_pairing_incomplete",
      ]),
    );
  });

  it("verifies a current public report artifact by recomputing its claim gate", () => {
    const report = publicReportArtifactFixture();

    const verification = verifyPublicEvalReportArtifact(report);

    expect(verification).toMatchObject({
      schemaVersion: "frugal-fusion-public-report-verification-v1",
      target: "public_eval_report",
      status: "public_report_verified",
      overallClaimStatus: "external_evidence_required",
      artifact: {
        rootObject: true,
        rootShapeStrict: true,
        claimGateInputAvailable: true,
        embeddedClaimGatePresent: true,
        embeddedClaimGateMatchesRecomputed: true,
      },
      blockers: [],
    });
    expect(verification.claimGate?.blockers).toEqual([]);
  });

  it("blocks public report verification when public case evidence does not match aggregate metrics", () => {
    const report = publicReportArtifactFixture({ cases: [] });

    const verification = verifyPublicEvalReportArtifact(report);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.artifact).toMatchObject({
      rootShapeStrict: true,
      publicFieldsShapeStrict: true,
      claimGateInputAvailable: true,
      embeddedClaimGateMatchesRecomputed: true,
    });
    expect(verification.claimGate?.blockers).toEqual([]);
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_case_metrics_mismatch",
          evidence: {
            publicReportCaseCountMatches: false,
            publicReportScoredCaseCountMatches: false,
            publicReportScoredTrialCountMatches: false,
            publicReportScoredAttemptCountsMatch: false,
            publicReportScoredAttemptCoverageMatches: false,
            publicReportTaskPassRatesMatch: false,
            publicReportFusionPairingMatches: false,
            publicReportFusionHarmMatches: false,
          },
        }),
      ]),
    );
  });

  it("blocks public report verification when public outcome pass flags contradict grader checks", () => {
    const report = publicReportArtifactFixture();
    const forgedReport = JSON.parse(JSON.stringify(report)) as PublicEvalReport;
    const forgedOutcome = forgedReport.cases[0]?.trials[0]?.outcomes.find(
      (outcome) => outcome.configId === "direct",
    );
    if (!forgedOutcome || !forgedOutcome.passed) {
      throw new Error("expected passing direct outcome");
    }
    forgedOutcome.grader = {
      passed: false,
      smokeOnly: false,
      checkCounts: { total: 1, passed: 0, failed: 1 },
      checks: [{ checkIndex: 0, kind: "exact", passed: false }],
    };

    const verification = verifyPublicEvalReportArtifact(forgedReport);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.claimGate?.blockers).toEqual([]);
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_public_fields_malformed",
          evidence: expect.objectContaining({
            publicReportCasesShapeStrict: false,
          }),
        }),
      ]),
    );
  });

  it("blocks public report verification when passing public outcomes have no grader checks", () => {
    const report = publicReportArtifactFixture();
    const forgedReport = JSON.parse(JSON.stringify(report)) as PublicEvalReport;
    const forgedOutcome = forgedReport.cases[0]?.trials[0]?.outcomes.find(
      (outcome) => outcome.configId === "direct",
    );
    if (!forgedOutcome || !forgedOutcome.passed) {
      throw new Error("expected passing direct outcome");
    }
    forgedOutcome.grader = {
      passed: true,
      smokeOnly: false,
      checkCounts: { total: 0, passed: 0, failed: 0 },
      checks: [],
    };

    const verification = verifyPublicEvalReportArtifact(forgedReport);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.claimGate?.blockers).toEqual([]);
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_public_fields_malformed",
          evidence: expect.objectContaining({
            publicReportCasesShapeStrict: false,
          }),
        }),
      ]),
    );
  });

  it("blocks public report verification for stale schema without echoing the raw schema marker", () => {
    const rawMarker = "frugal-fusion-public-eval-v10-PRIVATE-MARKER";
    const report = {
      ...publicReportArtifactFixture(),
      schemaVersion: rawMarker,
    };

    const verification = verifyPublicEvalReportArtifact(report);
    const serialized = JSON.stringify(verification);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.claimGate?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_schema_version_unsupported",
          evidence: { publicReportSchemaVersionKnown: false },
        }),
      ]),
    );
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_claim_gate_mismatch",
        }),
      ]),
    );
    expect(serialized).not.toContain(rawMarker);
  });

  it("blocks public report verification when claim-gate input fields are missing", () => {
    const { metrics: _metrics, ...withoutMetrics } =
      publicReportArtifactFixture();

    const verification = verifyPublicEvalReportArtifact(withoutMetrics);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.artifact).toMatchObject({
      rootObject: true,
      rootShapeStrict: false,
      claimGateInputAvailable: false,
      embeddedClaimGatePresent: true,
    });
    expect(verification.claimGate).toBeNull();
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_root_shape_malformed",
        }),
        expect.objectContaining({
          code: "public_report_claim_gate_input_unavailable",
        }),
      ]),
    );
  });

  it("blocks public report verification when the embedded claim gate is missing", () => {
    const { claimGate: _claimGate, ...withoutClaimGate } =
      publicReportArtifactFixture();

    const verification = verifyPublicEvalReportArtifact(withoutClaimGate);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.artifact).toMatchObject({
      rootShapeStrict: false,
      claimGateInputAvailable: true,
      embeddedClaimGatePresent: false,
      embeddedClaimGateMatchesRecomputed: false,
    });
    expect(verification.claimGate).not.toBeNull();
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_claim_gate_missing",
        }),
      ]),
    );
  });

  it("blocks public report verification when the root carries extra private fields", () => {
    const rawMarker = "PRIVATE-ROOT-FIELD-MARKER";
    const report = {
      ...publicReportArtifactFixture(),
      privateReportDigest: rawMarker,
    };

    const verification = verifyPublicEvalReportArtifact(report);
    const serialized = JSON.stringify(verification);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_root_shape_malformed",
          evidence: expect.objectContaining({
            publicReportRootShapeStrict: false,
          }),
        }),
      ]),
    );
    expect(serialized).not.toContain(rawMarker);
  });

  it("blocks public report verification when nested public artifact fields carry private data", () => {
    const rawMarkers = [
      "PRIVATE-CASE-TASK",
      "PRIVATE-EVALUATION-DESIGN",
      "PRIVATE-CLAIM-READINESS",
    ];
    const report = {
      ...publicReportArtifactFixture(),
      evaluationDesign: {
        trialsPerCase: 1,
        schedule: "case-trial-rotation-v1",
        bootstrapSamples: 500,
        confidenceLevel: 0.95,
        privateSchedule: rawMarkers[1],
      },
      claimReadiness: {
        status: "not_benchmark",
        warnings: [...publicClaimReadinessWarnings, rawMarkers[2]],
      },
      cases: [
        {
          publicId: "case_0001",
          smokeOnly: false,
          task: rawMarkers[0],
          trials: [],
        },
      ],
    } as unknown as PublicEvalReport;

    const verification = verifyPublicEvalReportArtifact(report);
    const serialized = JSON.stringify(verification);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_public_fields_malformed",
          evidence: expect.objectContaining({
            publicReportEvaluationDesignShapeStrict: false,
            publicReportClaimReadinessShapeStrict: false,
            publicReportCasesShapeStrict: false,
          }),
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks malformed public report metric variants without leaking raw suppressed reasons", () => {
    const rawMarkers = [
      "PRIVATE-COST-SUPPRESSED",
      "PRIVATE-CATEGORY-SUPPRESSED",
    ];
    const metrics = publicMetricsFixture({
      by_category: {
        available: false,
        suppressedReason: rawMarkers[1],
        minimumScoredCasesPerCategory: 5,
        recommendedScoredCasesPerCategoryForClaims: 30,
        categoryIdentity: "generated-order-labels-not-anonymous",
      } as unknown as PublicEvalMetrics["by_category"],
      cost_latency: {
        available: false,
        suppressedReason: rawMarkers[0],
        minimumScoredCases: 30,
      } as unknown as PublicEvalMetrics["cost_latency"],
    });
    const report = publicReportArtifactFixture({ metrics });

    const verification = verifyPublicEvalReportArtifact(report);
    const serialized = JSON.stringify(verification);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.claimGate).toBeNull();
    expect(verification.artifact).toMatchObject({
      claimGateInputShapeStrict: false,
      claimGateInputAvailable: false,
    });
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_public_fields_malformed",
          evidence: expect.objectContaining({
            publicReportMetricsShapeStrict: false,
          }),
        }),
        expect.objectContaining({
          code: "public_report_claim_gate_input_unavailable",
        }),
      ]),
    );
    for (const marker of rawMarkers) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("blocks public report verification when the embedded claim gate is stale", () => {
    const report = publicReportArtifactFixture();
    const staleReport = {
      ...report,
      claimGate: {
        ...report.claimGate,
        blockers: [
          {
            code: "PRIVATE-STALE-BLOCKER",
            message: "PRIVATE-STALE-MESSAGE",
          },
        ],
      },
    };

    const verification = verifyPublicEvalReportArtifact(staleReport);
    const serialized = JSON.stringify(verification);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "public_report_claim_gate_mismatch",
          evidence: expect.objectContaining({
            embeddedClaimGateMatchesRecomputed: false,
            embeddedClaimGateBlockerCount: 1,
            recomputedClaimGateBlockerCount: 0,
          }),
        }),
      ]),
    );
    expect(serialized).not.toContain("PRIVATE-STALE-BLOCKER");
    expect(serialized).not.toContain("PRIVATE-STALE-MESSAGE");
  });

  it("blocks public report verification when the recomputed claim gate is blocked", () => {
    const base = publicMetricsFixture();
    const metrics = publicMetricsFixture({
      n: 10,
      scored_n: 10,
      scored_trial_n: 10,
      scored_attempt_n: record(10),
      scored_attempt_coverage: scoredAttemptCoverageRecord(10),
      task_pass_rate: record(1),
      fusion_harm_rate: 0,
      paired_vs_direct: {
        ...record(emptyPublicPairedComparison()),
        fusion: {
          paired_n: 10,
          unpaired_n: 0,
          wins: 0,
          losses: 0,
          ties: 10,
          pass_rate_delta: 0,
          harm_rate: 0,
        },
      },
      position_counts: Object.fromEntries(
        allConfigs.map((config) => [config, { all: [10], scored: [10] }]),
      ) as PublicEvalMetrics["position_counts"],
      grader_evidence: {
        ...base.grader_evidence,
        tier_counts: {
          structured_or_exact: 10,
          surface_text: 0,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
        scored_tier_counts: {
          structured_or_exact: 10,
          surface_text: 0,
          mixed: 0,
          smoke_only: 0,
          ungraded: 0,
        },
      },
      by_category: publicCategoryBreakdownFixture([
        publicCategoryMetricFixture("category_0001", 10),
      ]),
      cost_latency: {
        available: false,
        suppressedReason: "small_scored_case_count",
        minimumScoredCases: 30,
      },
    });
    const report = publicReportArtifactFixture({
      metrics,
      cases: publicCasesFixture(allConfigs, 10, 10, record(10)),
    });

    const verification = verifyPublicEvalReportArtifact(report);

    expect(verification.status).toBe("public_report_blocked");
    expect(verification.artifact).toMatchObject({
      embeddedClaimGateMatchesRecomputed: true,
    });
    expect(verification.blockers).toEqual([]);
    expect(verification.claimGate?.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "too_few_scored_cases",
        "cost_latency_suppressed",
      ]),
    );
  });

  it("returns public-safe verification JSON for invalid public report JSON", () => {
    const verification = publicReportJsonParseFailureVerification();

    expect(verification).toMatchObject({
      schemaVersion: "frugal-fusion-public-report-verification-v1",
      status: "public_report_blocked",
      claimGate: null,
      blockers: [
        {
          code: "public_report_json_parse_failed",
          evidence: { publicReportJsonParseable: false },
        },
      ],
    });
  });

  it("returns public-safe verification JSON for unreadable public report JSON", () => {
    const verification = publicReportJsonReadFailureVerification();

    expect(verification).toMatchObject({
      schemaVersion: "frugal-fusion-public-report-verification-v1",
      status: "public_report_blocked",
      claimGate: null,
      blockers: [
        {
          code: "public_report_json_read_failed",
          evidence: { publicReportJsonReadable: false },
        },
      ],
    });
  });

  it("publishes pseudonymous category breakdowns only above the disclosure floor", async () => {
    const secretCategory = "secret-category-alpha";
    const otherSecretCategory = "secret-category-beta";
    const cases = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `a-${index}`,
        category: secretCategory,
        task: "Mention schema",
        grader: { mustInclude: ["schema"] },
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `b-${index}`,
        category: otherSecretCategory,
        task: "Mention schema",
        grader: { mustInclude: ["schema"] },
      })),
    ];
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient([
          ...Array.from({ length: 5 }, () => ({
            kind: "ok" as const,
            output: { answer: "schema" },
          })),
          ...Array.from({ length: 5 }, () => ({
            kind: "ok" as const,
            output: { answer: "missing" },
          })),
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);
    const byCategory = publicReport.metrics.by_category;

    expect(JSON.stringify(publicReport)).not.toContain(secretCategory);
    expect(JSON.stringify(publicReport)).not.toContain(otherSecretCategory);
    expect(byCategory).toMatchObject({
      available: true,
      categoryIdentity: "generated-order-labels-not-anonymous",
      minimumScoredCasesPerCategory: 5,
      recommendedScoredCasesPerCategoryForClaims: 30,
      confidence_intervals: {
        method: "case_cluster_bootstrap",
        level: 0.95,
        resamples: 500,
        metrics: ["task_pass_rate", "pass_rate_delta_vs_direct"],
        scope: "within_category",
      },
    });
    if (!byCategory.available) throw new Error("expected category breakdown");
    expect(byCategory.categories).toHaveLength(2);
    expect(byCategory.categories[0]).toMatchObject({
      publicCategoryId: "category_0001",
      scored_case_n: 5,
      scored_trial_n: 5,
      scored_attempt_n_by_config: { direct: 5 },
      passed_attempt_n_by_config: { direct: 5 },
      passRateDenominator: "scored_attempts",
      task_pass_rate: { direct: 1 },
      task_pass_rate_interval: { direct: { low: 1, high: 1 } },
      pass_rate_delta_interval_vs_direct: { direct: null },
      pairedDenominator: "case_trials",
      belowRecommendedScoredCases: true,
      claimReadiness: "exploratory_underpowered",
      grader_evidence: {
        version: "grader-evidence-tier-v2",
        tier_counts: { surface_text: 5 },
        dominant_tier: "surface_text",
        dominant_tier_case_share: 1,
        profile_mix: "single_tier",
        small_profile_cell_warning: false,
        minimum_profile_cell_size: 5,
      },
      observed_runtime_check_kind_case_counts: { must_include: 5 },
    });
    expect(byCategory.categories[1]).toMatchObject({
      publicCategoryId: "category_0002",
      scored_case_n: 5,
      task_pass_rate: { direct: 0 },
      task_pass_rate_interval: { direct: { low: 0, high: 0 } },
      pass_rate_delta_interval_vs_direct: { direct: null },
    });
  });

  it("suppresses category breakdowns when any category has too few scored cases", async () => {
    const report = await runEvaluation(
      [
        {
          id: "small-category",
          category: "secret-small",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(buildPublicEvalReport(report).metrics.by_category).toMatchObject({
      available: false,
      suppressedReason: "small_scored_case_count_per_category",
      minimumScoredCasesPerCategory: 5,
    });
  });

  it("suppresses category breakdowns when scored cases are uncategorized", async () => {
    const cases = Array.from({ length: 5 }, (_, index) => ({
      id: `uncategorized-${index}`,
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    }));
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient(
          cases.map(() => ({ kind: "ok", output: { answer: "schema" } })),
        ),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(buildPublicEvalReport(report).metrics.by_category).toMatchObject({
      available: false,
      suppressedReason: "uncategorized_scored_cases",
    });
  });

  it("flags small grader-evidence cells inside otherwise publishable categories", async () => {
    const cases = [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `surface-${index}`,
        category: "mixed-secret-category",
        task: "Mention schema",
        grader: { mustInclude: ["schema"] },
      })),
      {
        id: "structured",
        category: "mixed-secret-category",
        task: "Return JSON",
        grader: { json: { requireValid: true, requiredPaths: ["ok"] } },
      },
    ];
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient([
          ...Array.from({ length: 4 }, () => ({
            kind: "ok" as const,
            output: { answer: "schema" },
          })),
          { kind: "ok", output: { answer: JSON.stringify({ ok: true }) } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const byCategory = buildPublicEvalReport(report).metrics.by_category;

    if (!byCategory.available) throw new Error("expected category breakdown");
    expect(byCategory.categories[0]?.grader_evidence).toMatchObject({
      tier_counts: { structured_or_exact: 1, surface_text: 4 },
      dominant_tier: "surface_text",
      dominant_tier_case_share: 0.8,
      profile_mix: "mixed_tiers",
      small_profile_cell_warning: true,
    });
  });

  it("publishes mixed grader evidence when one case uses both evidence families", async () => {
    const report = await runEvaluation(
      [
        {
          id: "mixed",
          category: "secret-mixed",
          task: "Return ok",
          grader: { exact: "ok", mustInclude: ["ok"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "ok" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);

    expect(publicReport.metrics.grader_evidence).toMatchObject({
      scored_tier_counts: { mixed: 1 },
      dominant_tier: "mixed",
      profile_mix: "single_tier",
      small_profile_cell_warning: true,
    });
    expect(publicReport.metrics.by_category).toMatchObject({
      available: false,
      suppressedReason: "small_scored_case_count_per_category",
    });
  });

  it("matches top-level pass metrics when all scored cases are in one public category", async () => {
    const cases = Array.from({ length: 5 }, (_, index) => ({
      id: `case-${index}`,
      category: "single-secret-category",
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    }));
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: { answer: "schema" } },
          { kind: "ok", output: { answer: "schema" } },
          { kind: "ok", output: { answer: "schema" } },
          { kind: "ok", output: { answer: "missing" } },
          { kind: "ok", output: { answer: "missing" } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);
    const byCategory = publicReport.metrics.by_category;

    if (!byCategory.available) throw new Error("expected category breakdown");
    expect(byCategory.categories[0]?.task_pass_rate.direct).toBe(
      publicReport.metrics.task_pass_rate.direct,
    );
    expect(byCategory.categories[0]?.task_pass_rate_interval.direct).toEqual(
      publicReport.metrics.confidence_intervals.task_pass_rate.direct,
    );
    expect(
      byCategory.categories[0]?.pass_rate_delta_interval_vs_direct.direct,
    ).toBeNull();
    expect(byCategory.categories[0]?.scored_attempt_n_by_config.direct).toBe(
      publicReport.metrics.scored_attempt_n.direct,
    );
  });

  it("matches top-level delta intervals when all scored cases are in one complete public category", async () => {
    const cases = Array.from({ length: 5 }, (_, index) => ({
      id: `case-${index}`,
      category: "single-secret-category",
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    }));
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient(
          Array.from({ length: 10 }, () => ({
            kind: "ok" as const,
            output: { answer: "schema" },
          })),
        ),
      ),
      budget,
      { configs: ["direct", "fusion"] },
    );

    const publicReport = buildPublicEvalReport(report);
    const byCategory = publicReport.metrics.by_category;

    if (!byCategory.available) throw new Error("expected category breakdown");
    expect(
      byCategory.categories[0]?.pass_rate_delta_interval_vs_direct.fusion,
    ).toEqual(
      publicReport.metrics.confidence_intervals.pass_rate_delta_vs_direct
        .fusion,
    );
  });

  it("marks category pass-rate intervals unavailable for configs without category attempts", async () => {
    const cases = Array.from({ length: 5 }, (_, index) => ({
      id: `case-${index}`,
      category: "single-secret-category",
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    }));
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient(
          Array.from({ length: 5 }, () => ({
            kind: "ok" as const,
            output: { answer: "schema" },
          })),
        ),
      ),
      budget,
      { configs: ["direct"] },
    );
    report.configs = ["direct", "fusion"];

    const byCategory = buildPublicEvalReport(report).metrics.by_category;

    if (!byCategory.available) throw new Error("expected category breakdown");
    expect(byCategory.categories[0]?.scored_attempt_n_by_config).toEqual({
      direct: 5,
      fusion: 0,
    });
    expect(byCategory.categories[0]?.task_pass_rate).toEqual({
      direct: 1,
      fusion: null,
    });
    expect(byCategory.categories[0]?.task_pass_rate_interval).toEqual({
      direct: { low: 1, high: 1 },
      fusion: null,
    });
    expect(
      byCategory.categories[0]?.pass_rate_delta_interval_vs_direct,
    ).toEqual({
      direct: null,
      fusion: null,
    });
  });

  it("publishes JSON schema-subset check kinds without schema details", async () => {
    const secretEnum = "PRIVATE-SCHEMA-ENUM";
    const report = await runEvaluation(
      [
        {
          id: "schema",
          task: "Return strict JSON",
          grader: {
            json: {
              schemaSubset: {
                type: "object",
                properties: {
                  decision: { type: "string", enum: [secretEnum] },
                },
                required: ["decision"],
                additionalProperties: false,
              },
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: { answer: JSON.stringify({ decision: secretEnum }) },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);
    const serialized = JSON.stringify(publicReport);

    expect(
      publicReport.cases[0]?.trials[0]?.outcomes[0]?.grader.checks,
    ).toEqual([{ checkIndex: 0, kind: "json_schema_subset", passed: true }]);
    expect(serialized).not.toContain(secretEnum);
    expect(serialized).not.toContain("enum");
    expect(serialized).not.toContain("decision");
  });

  it("publishes choice check kinds without choice labels", async () => {
    const secretChoice = "PRIVATE-APPROVE-LABEL";
    const report = await runEvaluation(
      [
        {
          id: "choice-public",
          task: "Return exactly one allowed label.",
          grader: {
            choice: {
              expected: secretChoice,
              allowed: [secretChoice, "PRIVATE-REJECT-LABEL"],
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: secretChoice } }]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);
    const serialized = JSON.stringify(publicReport);

    expect(
      publicReport.cases[0]?.trials[0]?.outcomes[0]?.grader.checks,
    ).toEqual([
      { checkIndex: 0, kind: "choice_valid", passed: true },
      { checkIndex: 1, kind: "choice_expected", passed: true },
    ]);
    expect(serialized).not.toContain(secretChoice);
    expect(serialized).not.toContain("PRIVATE-REJECT-LABEL");
  });

  it("maps unknown public check kinds to other_check", async () => {
    const report = await runEvaluation(
      [
        {
          id: "case",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );
    const check = report.cases[0]?.outcomes[0]?.grader.checks[0];
    if (!check) throw new Error("missing grader check");
    check.name = "secret_check_kind";

    const publicReport = buildPublicEvalReport(report);

    expect(JSON.stringify(publicReport)).not.toContain("secret_check_kind");
    expect(
      publicReport.cases[0]?.trials[0]?.outcomes[0]?.grader.checks[0]?.kind,
    ).toBe("other_check");
  });

  it("keeps citation check kinds in public reports without details", async () => {
    const report = await runEvaluation(
      [
        {
          id: "citation-public",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: ["S1"],
              requiredSourceIds: ["S1"],
              requiredClaims: [
                {
                  sourceId: "S1",
                  text: "Revenue rose 12%",
                  citationPlacement: "immediate",
                },
              ],
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: { answer: "Revenue rose 12% [S1]." },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);

    expect(
      publicReport.cases[0]?.trials[0]?.outcomes[0]?.grader.checks,
    ).toEqual([
      { checkIndex: 0, kind: "citation_allowed_sources", passed: true },
      { checkIndex: 1, kind: "citation_required_source", passed: true },
      { checkIndex: 2, kind: "citation_required_claim", passed: true },
    ]);
    expect(JSON.stringify(publicReport)).not.toContain("Revenue rose 12%");
    expect(JSON.stringify(publicReport)).not.toContain("S1");
  });

  it("omits private citation failure details from public reports", async () => {
    const report = await runEvaluation(
      [
        {
          id: "citation-public-fail",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: ["S1"],
              requiredClaims: [
                {
                  sourceId: "S1",
                  text: "Revenue rose 12%",
                  citationPlacement: "immediate",
                },
              ],
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              answer:
                "Revenue rose 12%. The release attributed the gain to renewals [S1].",
            },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    const publicReport = buildPublicEvalReport(report);
    const serializedPublicReport = JSON.stringify(publicReport);

    expect(
      publicReport.cases[0]?.trials[0]?.outcomes[0]?.grader.checks,
    ).toEqual([
      { checkIndex: 0, kind: "citation_allowed_sources", passed: true },
      { checkIndex: 1, kind: "citation_required_claim", passed: false },
    ]);
    expect(serializedPublicReport).not.toContain("claim_not_immediately_cited");
    expect(serializedPublicReport).not.toContain("Revenue rose 12%");
    expect(serializedPublicReport).not.toContain("S1");
  });

  it("keeps configured grader evidence counts when all category outcomes fail", async () => {
    const cases = Array.from({ length: 5 }, (_, index) => ({
      id: `failed-${index}`,
      category: "secret-failure-category",
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    }));
    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient(
          cases.map(() => ({
            kind: "error" as const,
            status: "provider_error" as const,
          })),
        ),
      ),
      budget,
      { configs: ["direct"] },
    );

    const byCategory = buildPublicEvalReport(report).metrics.by_category;

    if (!byCategory.available) throw new Error("expected category breakdown");
    expect(byCategory.categories[0]?.grader_evidence).toMatchObject({
      tier_counts: { surface_text: 5 },
      dominant_tier: "surface_text",
      profile_mix: "single_tier",
    });
    expect(
      byCategory.categories[0]?.observed_runtime_check_kind_case_counts,
    ).toEqual({});
  });
});

function makeOrchestrator(client: ModelClient): FrugalFusionOrchestrator {
  return new FrugalFusionOrchestrator({
    client,
    models,
    priceSnapshot: (modelIds) => modelIds.map(snapshot),
  });
}

class AutoPassClient implements ModelClient {
  async generate<T>(request: {
    modelId: string;
    outputSchema: JsonSchema;
  }): Promise<{ output: T; usage: ModelUsage }> {
    return {
      output: outputForSchema(request.outputSchema) as T,
      usage: {
        modelId: request.modelId,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
        latencyMs: 10,
        status: "ok",
      },
    };
  }
}

function outputForSchema(schema: JsonSchema): unknown {
  if (schema.type !== "object") throw new Error("expected object schema");
  const required = new Set(schema.required ?? []);
  if (required.has("claims")) {
    return {
      candidateId: "candidate",
      conclusion: "schema",
      claims: [],
      reasoningOutline: [],
      alternatives: [],
      risks: [],
      unresolved: [],
    };
  }
  if (required.has("ledger")) {
    return {
      answer: "schema",
      ledger: {
        consensusClaimIds: [],
        adoptedClaimIds: [],
        uniqueAdoptedClaimIds: [],
        rejectedClaims: [],
        conflicts: [],
        coverageGaps: [],
        blindSpots: [],
        requiredChecks: [],
      },
    };
  }
  return { answer: "schema" };
}

function snapshot(modelId: string): PriceSnapshotEntry {
  return {
    modelId,
    provider: "provider-secret",
    name: `name-${modelId}`,
    supportedParameters: ["temperature", "top_p", "seed"],
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: new Date().toISOString(),
    source: "config",
  };
}

function publicDisclosureFixture(
  caseSetManifestBinding: PublicEvalReport["disclosure"]["caseSetManifestBinding"] = {
    status: "not_provided",
  },
  runProvenance: PublicEvalReport["disclosure"]["runProvenance"] = {
    status: "not_provided",
  },
  caseSetClaimGate: PublicEvalReport["disclosure"]["caseSetClaimGate"] = {
    status: "not_provided",
  },
): PublicEvalReport["disclosure"] {
  return {
    modelDisclosure: "redacted",
    priceDisclosure: "redacted",
    promptDisclosure: "redacted",
    caseIdentity: "generated-row-labels",
    traceDisclosure: "omitted",
    reproducibilityLevel: "private-audit-only",
    caseSetManifestBinding,
    caseSetClaimGate,
    runProvenance,
    notes: [],
  };
}

function boundCaseManifestDisclosure(): PublicEvalReport["disclosure"]["caseSetManifestBinding"] {
  return {
    status: "private_report_bound",
    schemaVersion: "frugal-fusion-case-set-manifest-v4",
    fingerprintVersion: "case-set-canonical-v3",
    canonicalization: "json-sorted-v1",
    content: "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1",
    intendedUse: "holdout",
    hashAlgorithm: "hmac-sha256",
    privacyClass: "private_audit_hmac_sha256",
    digestDisclosure: "omitted",
  };
}

function boundCaseSetClaimGateDisclosure(): PublicEvalReport["disclosure"]["caseSetClaimGate"] {
  return {
    status: "private_report_constraints_met",
    target: "public_cost_performance",
    scope: "case_set_only",
    overallClaimStatus: "external_evidence_required",
    detailDisclosure: "omitted",
  };
}

function boundRunProvenanceDisclosure(
  evaluatedConfigCount = 4,
  providerEndpointPinning:
    | "single_provider_endpoint_pinned"
    | "not_configured"
    | "fallbacks_allowed"
    | "multiple_provider_endpoints_allowed"
    | "base_provider_slug_only" = "single_provider_endpoint_pinned",
): PublicEvalReport["disclosure"]["runProvenance"] {
  return {
    status: "private_report_fields_present",
    schemaVersion: "frugal-fusion-run-provenance-v2",
    fingerprintVersion: "run-provenance-v2",
    canonicalization: "json-sorted-v1",
    evaluatedConfigCount,
    config: {
      status: "private_report_fields_present",
      content: "resolved-frugal-fusion-config-v2",
      digestDisclosure: "omitted",
      pathDisclosure: "omitted",
    },
    modelPriceSnapshot: {
      status: "private_report_fields_present",
      content: "effective-model-price-snapshot-v1",
      digestDisclosure: "omitted",
      pathDisclosure: "omitted",
    },
    openRouterRequestPolicy: {
      status: "private_report_fields_present",
      content: "openrouter-fixed-baseline-request-policy-v1",
      digestDisclosure: "omitted",
    },
    providerRouting: {
      status: "private_report_fields_present",
      content: "openrouter-provider-routing-policy-v1",
      providerEndpointPinning,
      detailDisclosure: "omitted",
    },
  };
}

function runProvenanceFixture(
  configs: DeliberationMode[] = ["direct", "self_review", "repeated", "fusion"],
) {
  return buildEvalRunProvenance({
    config: {
      ...DEFAULT_CONFIG,
      configId: "secret-config-id",
      models,
      provider: {
        ...DEFAULT_CONFIG.provider,
        allow_fallbacks: false,
        order: ["provider-secret/endpoint-secret"],
      },
    },
    configs,
    configSourceKind: "caller_provided",
    modelPriceEntries: modelIdsForRunProvenance(models, configs).map(
      (modelId) => snapshot(modelId),
    ),
    modelSnapshotSourceKind: "caller_provided",
    invocation: cliEvalInvocationProvenance(),
  });
}

function publicMetricsFixture(
  overrides: Partial<PublicEvalMetrics> = {},
): PublicEvalMetrics {
  const base: PublicEvalMetrics = {
    n: 120,
    scored_n: 120,
    trials_per_case: 1,
    scored_trial_n: 120,
    scored_attempt_n: {
      ...record(0),
      direct: 120,
      self_review: 120,
      repeated: 120,
      fusion: 120,
    },
    scored_attempt_coverage: scoredAttemptCoverageRecord(120),
    task_pass_rate: {
      ...record<number | null>(null),
      direct: 0.75,
      self_review: 0.7667,
      repeated: 0.7833,
      fusion: 0.8333,
    },
    fusion_harm_rate: 0,
    paired_vs_direct: {
      ...record(emptyPublicPairedComparison()),
      fusion: {
        paired_n: 120,
        unpaired_n: 0,
        wins: 10,
        losses: 0,
        ties: 110,
        pass_rate_delta: 0.0833,
        harm_rate: 0,
      },
    },
    position_counts: Object.fromEntries(
      allConfigs.map((config) => [config, { all: [60, 60], scored: [60, 60] }]),
    ) as PublicEvalMetrics["position_counts"],
    confidence_intervals: {
      method: "case_cluster_bootstrap",
      level: 0.95,
      resamples: 500,
      warnings: [],
      task_pass_rate: {
        ...record(null),
        direct: { low: 0.63, high: 0.8 },
        self_review: { low: 0.65, high: 0.82 },
        repeated: { low: 0.68, high: 0.84 },
        fusion: { low: 0.73, high: 0.88 },
      },
      pass_rate_delta_vs_direct: {
        ...record(null),
        fusion: { low: 0.02, high: 0.12 },
      },
    },
    grader_evidence: {
      version: "grader-evidence-tier-v2",
      tier_counts: {
        structured_or_exact: 120,
        surface_text: 0,
        mixed: 0,
        smoke_only: 0,
        ungraded: 0,
      },
      scored_tier_counts: {
        structured_or_exact: 120,
        surface_text: 0,
        mixed: 0,
        smoke_only: 0,
        ungraded: 0,
      },
      smoke_only_case_n: 0,
      dominant_tier: "structured_or_exact",
      dominant_tier_case_share: 1,
      profile_mix: "single_tier",
      small_profile_cell_warning: false,
      minimum_profile_cell_size: 5,
      notes: publicGraderEvidenceNotes,
    },
    by_category: publicCategoryBreakdownFixture([
      publicCategoryMetricFixture("category_0001", 30),
      publicCategoryMetricFixture("category_0002", 30),
      publicCategoryMetricFixture("category_0003", 30),
      publicCategoryMetricFixture("category_0004", 30),
    ]),
    failure_rates: {
      invalid_output_rate: record(0),
      timeout_rate: record(0),
      provider_error_rate: record(0),
      budget_exhaustion_rate: record(0),
      partial_failure_rate: record(0),
      verification_failure_rate: record(0),
      smoke_completion_rate: record(0),
    },
    cost_latency: {
      available: true,
      precision: {
        costUsdDecimals: 4,
        latencyMsBucket: 100,
      },
      cost_per_pass_usd: {
        ...record<number | null>(null),
        direct: 0.0021,
        self_review: 0.0023,
        repeated: 0.0022,
        fusion: 0.0024,
      },
      cost_per_pass_interval_usd: {
        ...record({
          low: null,
          high: null,
          available: false,
          undefinedRate: 1,
        }),
        direct: {
          low: 0.0017,
          high: 0.0028,
          available: true,
          undefinedRate: 0,
        },
        self_review: {
          low: 0.0018,
          high: 0.0029,
          available: true,
          undefinedRate: 0,
        },
        repeated: {
          low: 0.0018,
          high: 0.0028,
          available: true,
          undefinedRate: 0,
        },
        fusion: {
          low: 0.0019,
          high: 0.003,
          available: true,
          undefinedRate: 0,
        },
      },
      mean_cost_per_scored_attempt_usd: {
        ...record<number | null>(null),
        direct: 0.0015,
        self_review: 0.0017,
        repeated: 0.0016,
        fusion: 0.002,
      },
      total_cost_usd: {
        ...record(0),
        direct: 0.18,
        self_review: 0.204,
        repeated: 0.192,
        fusion: 0.24,
      },
      p50_latency_ms: {
        ...record(0),
        direct: 100,
        self_review: 180,
        repeated: 160,
        fusion: 300,
      },
      p95_latency_ms: {
        ...record(0),
        direct: 200,
        self_review: 280,
        repeated: 260,
        fusion: 500,
      },
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

function publicCasesFixture(
  configs: DeliberationMode[] = allConfigs,
  caseCount = 120,
  scoredCaseCount = caseCount,
  passCounts: Record<DeliberationMode, number> = {
    ...record(0),
    direct: 90,
    self_review: 92,
    repeated: 94,
    fusion: 100,
  },
): PublicEvalCase[] {
  return Array.from({ length: caseCount }, (_, index) => {
    const smokeOnly = index >= scoredCaseCount;
    const outcomes = smokeOnly
      ? []
      : configs.map((config) =>
          publicOutcomeFixture(config, index < passCounts[config]),
        );
    const directOutcome = outcomes.find(
      (outcome) => outcome.configId === "direct",
    );
    const fusionOutcome = outcomes.find(
      (outcome) => outcome.configId === "fusion",
    );
    return {
      publicId: `case_${String(index + 1).padStart(4, "0")}`,
      smokeOnly,
      trials: smokeOnly
        ? []
        : [
            {
              trialIndex: 0,
              fusionHarm: Boolean(
                directOutcome?.passed && !fusionOutcome?.passed,
              ),
              outcomes,
            },
          ],
    };
  });
}

function publicOutcomeFixture(
  configId: DeliberationMode,
  passed: boolean,
): PublicEvalCase["trials"][number]["outcomes"][number] {
  return {
    configId,
    status: "completed",
    passed,
    grader: {
      passed,
      smokeOnly: false,
      checkCounts: {
        total: 1,
        passed: passed ? 1 : 0,
        failed: passed ? 0 : 1,
      },
      checks: [{ checkIndex: 0, kind: "exact", passed }],
    },
  };
}

function publicReportArtifactFixture(
  overrides: Partial<PublicEvalReport> = {},
): PublicEvalReport {
  const schemaVersion =
    overrides.schemaVersion ?? "frugal-fusion-public-eval-v11";
  let disclosure = overrides.disclosure;
  if (disclosure === undefined) {
    disclosure = publicDisclosureFixture(
      boundCaseManifestDisclosure(),
      boundRunProvenanceDisclosure(),
      boundCaseSetClaimGateDisclosure(),
    );
    disclosure.notes = publicDisclosureNotes;
  }
  const configs = overrides.configs ?? allConfigs;
  const metrics = overrides.metrics ?? publicMetricsFixture();
  const cases = overrides.cases ?? publicCasesFixture(configs);
  const claimGate =
    overrides.claimGate ??
    assessPublicReportClaimGate({
      schemaVersion,
      configs,
      disclosure,
      metrics,
    });
  return {
    schemaVersion,
    generatedAt: "2026-06-24T00:00:00.000Z",
    disclosure,
    evaluationDesign: {
      trialsPerCase: 1,
      schedule: "case-trial-rotation-v1",
      bootstrapSamples: 500,
      confidenceLevel: 0.95,
    },
    configs,
    claimReadiness: {
      status: "not_benchmark",
      warnings: publicClaimReadinessWarnings,
    },
    claimGate,
    metrics,
    cases,
    ...overrides,
  };
}

function scoredAttemptCoverageRecord(
  scoredTrialCount: number,
): PublicEvalMetrics["scored_attempt_coverage"] {
  return Object.fromEntries(
    allConfigs.map((config) => [
      config,
      {
        expected_scored_case_trial_n: scoredTrialCount,
        observed_scored_attempt_n: scoredTrialCount,
        incomplete_scored_case_trial_n: 0,
        complete: true,
      },
    ]),
  ) as PublicEvalMetrics["scored_attempt_coverage"];
}

function publicCategoryBreakdownFixture(
  categories: Extract<
    PublicEvalMetrics["by_category"],
    { available: true }
  >["categories"],
): Extract<PublicEvalMetrics["by_category"], { available: true }> {
  return {
    available: true,
    categoryIdentity: "generated-order-labels-not-anonymous",
    minimumScoredCasesPerCategory: 5,
    recommendedScoredCasesPerCategoryForClaims: 30,
    confidence_intervals: {
      method: "case_cluster_bootstrap",
      level: 0.95,
      resamples: 500,
      metrics: ["task_pass_rate", "pass_rate_delta_vs_direct"],
      scope: "within_category",
    },
    notes: publicCategoryBreakdownNotes,
    categories,
  };
}

function publicCategoryMetricFixture(
  publicCategoryId: string,
  scoredCaseCount: number,
): Extract<
  PublicEvalMetrics["by_category"],
  { available: true }
>["categories"][number] {
  return {
    publicCategoryId,
    scored_case_n: scoredCaseCount,
    scored_trial_n: scoredCaseCount,
    scored_attempt_n_by_config: {
      ...record(0),
      direct: scoredCaseCount,
      self_review: scoredCaseCount,
      repeated: scoredCaseCount,
      fusion: scoredCaseCount,
    },
    passed_attempt_n_by_config: {
      ...record(0),
      direct: Math.floor(scoredCaseCount * 0.7),
      self_review: Math.floor(scoredCaseCount * 0.72),
      repeated: Math.floor(scoredCaseCount * 0.75),
      fusion: Math.floor(scoredCaseCount * 0.8),
    },
    passRateDenominator: "scored_attempts",
    task_pass_rate: {
      ...record<number | null>(null),
      direct: 0.7,
      self_review: 0.72,
      repeated: 0.75,
      fusion: 0.8,
    },
    task_pass_rate_interval: {
      ...record(null),
      direct: { low: 0.6, high: 0.8 },
      self_review: { low: 0.62, high: 0.82 },
      repeated: { low: 0.65, high: 0.85 },
      fusion: { low: 0.7, high: 0.9 },
    },
    pass_rate_delta_interval_vs_direct: {
      ...record(null),
      self_review: { low: -0.02, high: 0.06 },
      repeated: { low: 0, high: 0.08 },
      fusion: { low: 0.02, high: 0.12 },
    },
    fusion_harm_rate: 0,
    pairedDenominator: "case_trials",
    paired_vs_direct: {
      ...record(emptyPublicPairedComparison()),
      fusion: {
        paired_n: scoredCaseCount,
        unpaired_n: 0,
        wins: 4,
        losses: 1,
        ties: Math.max(0, scoredCaseCount - 5),
        pass_rate_delta: 0.1,
        harm_rate: 1 / scoredCaseCount,
      },
    },
    belowRecommendedScoredCases: scoredCaseCount < 30,
    claimReadiness:
      scoredCaseCount < 30 ? "exploratory_underpowered" : "descriptive_only",
    grader_evidence: {
      version: "grader-evidence-tier-v2",
      tier_counts: {
        structured_or_exact: scoredCaseCount,
        surface_text: 0,
        mixed: 0,
        smoke_only: 0,
        ungraded: 0,
      },
      dominant_tier: "structured_or_exact",
      dominant_tier_case_share: 1,
      profile_mix: "single_tier",
      small_profile_cell_warning: false,
      minimum_profile_cell_size: 5,
    },
    observed_runtime_check_kind_case_counts: {
      json_valid: scoredCaseCount,
    },
  };
}

function surfaceTextCategoryMetricFixture(
  publicCategoryId: string,
  scoredCaseCount: number,
): Extract<
  PublicEvalMetrics["by_category"],
  { available: true }
>["categories"][number] {
  const category = publicCategoryMetricFixture(
    publicCategoryId,
    scoredCaseCount,
  );
  return {
    ...category,
    grader_evidence: {
      version: "grader-evidence-tier-v2",
      tier_counts: {
        structured_or_exact: 0,
        surface_text: scoredCaseCount,
        mixed: 0,
        smoke_only: 0,
        ungraded: 0,
      },
      dominant_tier: "surface_text",
      dominant_tier_case_share: 1,
      profile_mix: "single_tier",
      small_profile_cell_warning: false,
      minimum_profile_cell_size: 5,
    },
    observed_runtime_check_kind_case_counts: {
      must_include: scoredCaseCount,
    },
  };
}

function mixedCategoryMetricFixture(
  publicCategoryId: string,
  scoredCaseCount: number,
): Extract<
  PublicEvalMetrics["by_category"],
  { available: true }
>["categories"][number] {
  const category = publicCategoryMetricFixture(
    publicCategoryId,
    scoredCaseCount,
  );
  return {
    ...category,
    grader_evidence: {
      version: "grader-evidence-tier-v2",
      tier_counts: {
        structured_or_exact: 0,
        surface_text: 0,
        mixed: scoredCaseCount,
        smoke_only: 0,
        ungraded: 0,
      },
      dominant_tier: "mixed",
      dominant_tier_case_share: 1,
      profile_mix: "single_tier",
      small_profile_cell_warning: false,
      minimum_profile_cell_size: 5,
    },
    observed_runtime_check_kind_case_counts: {
      json_valid: scoredCaseCount,
      must_include: scoredCaseCount,
    },
  };
}

function emptyPublicPairedComparison(): PublicEvalMetrics["paired_vs_direct"][DeliberationMode] {
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

function record<T>(value: T): Record<DeliberationMode, T> {
  return Object.fromEntries(
    allConfigs.map((config) => [config, value]),
  ) as Record<DeliberationMode, T>;
}
