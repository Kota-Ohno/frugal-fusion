import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  assessEvalClaimGate,
  buildCaseSetManifest,
  buildCaseSetManifestFromJsonl,
  caseSetFingerprint,
  caseGraderEvidenceTier,
  EVAL_CASE_DIFFICULTIES,
  gradeEvalCaseAnswer,
  passRateDeltaVsDirectBootstrapIntervals,
  parseJsonlCases,
  runEvaluation,
  validateEvalCases,
  verifyCaseSetManifestBinding,
} from "../src/evaluation.js";
import type {
  EvalCase,
  EvalCaseDifficultyCounts,
  EvalCaseResult,
  EvalConfigOutcome,
} from "../src/evaluation.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import { FrugalFusionOrchestrator } from "../src/orchestrator.js";
import {
  buildEvalRunProvenance,
  cliEvalInvocationProvenance,
  modelIdsForRunProvenance,
} from "../src/runProvenance.js";
import type {
  Budget,
  Candidate,
  JsonSchema,
  ModelClient,
  ModelRoleConfig,
  ModelUsage,
  PriceSnapshotEntry,
} from "../src/types.js";
import { FakeModelClient } from "./fakeClient.js";

const execFileAsync = promisify(execFile);

const budget: Budget = {
  maxCostUsd: 0.05,
  maxLatencyMs: 1_000,
  maxCandidates: 2,
  maxCompletionTokens: 600,
  maxRepairRounds: 1,
};

const models: ModelRoleConfig = {
  directModelId: "direct/model",
  selfReviewModelId: "direct/model",
  repeatedModelId: "direct/model",
  candidateModels: ["candidate/a", "candidate/b"],
  aggregatorModelId: "aggregator/model",
};

function claimGateCaseSetJsonl(options: {
  categoryCount: number;
  casesPerCategory: number;
  categoryPrefix?: string;
  difficulty?: "balanced" | "easy_only" | "omitted";
}): string {
  const lines: string[] = [];
  const difficulties = ["easy", "medium", "hard"] as const;
  for (
    let categoryIndex = 0;
    categoryIndex < options.categoryCount;
    categoryIndex += 1
  ) {
    for (
      let caseIndex = 0;
      caseIndex < options.casesPerCategory;
      caseIndex += 1
    ) {
      const id = `case-${categoryIndex + 1}-${caseIndex + 1}`;
      lines.push(
        JSON.stringify({
          id,
          category: `${options.categoryPrefix ?? "category"}-${categoryIndex + 1}`,
          ...(options.difficulty === "omitted"
            ? {}
            : {
                difficulty:
                  options.difficulty === "easy_only"
                    ? "easy"
                    : difficulties[
                        (categoryIndex * options.casesPerCategory + caseIndex) %
                          difficulties.length
                      ],
              }),
          task: `Return ${id}`,
          grader: { exact: id },
        }),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function nonSurfaceGraderEvidenceCountsByCategoryDifficulty(
  cases: EvalCase[],
): Record<string, EvalCaseDifficultyCounts> {
  const counts: Record<string, EvalCaseDifficultyCounts> = {};
  for (const evalCase of cases) {
    if (evalCase.smokeOnly || !evalCase.category || !evalCase.difficulty) {
      continue;
    }
    const tier = caseGraderEvidenceTier(evalCase);
    if (tier !== "structured_or_exact" && tier !== "mixed") continue;
    const categoryCounts = counts[evalCase.category] ?? {
      easy: 0,
      medium: 0,
      hard: 0,
    };
    categoryCounts[evalCase.difficulty] += 1;
    counts[evalCase.category] = categoryCounts;
  }
  return counts;
}

const publicSampleGoldenAnswers: Record<string, string> = {
  "security-privacy-002": JSON.stringify({
    retain_raw_prompt: false,
    metadata: ["hash", "length"],
    rationale: "privacy-preserving prompt metadata",
  }),
  "security-privacy-006": JSON.stringify({
    default: "redacted",
    risks: ["secrets", "debugging context"],
    allowed_when: "opt_in",
  }),
  "cost-budgeting-001": "FAIL_CLOSED",
  "cost-budgeting-005": JSON.stringify({
    numerator: "total_cost",
    denominator: "passing_scored_attempts",
    formula: "total_cost/passing_scored_attempts",
  }),
  "cli-typescript-004": "NO_API_KEY",
  "cli-typescript-006": JSON.stringify({
    checks: ["realpath", "symlink"],
    action: "reject",
  }),
  "data-pipeline-001": JSON.stringify({
    checks: ["schema validation", "failure reporting"],
  }),
  "data-pipeline-005": "REJECT_NON_FINITE",
  "evaluation-design-002": JSON.stringify({
    direct_condition: "direct_passes",
    fusion_condition: "fusion_fails",
    label: "fusion_harm",
  }),
  "evaluation-design-004": JSON.stringify({
    action: "counterbalance",
    rationale: "reduce order bias",
  }),
  "evaluation-design-006": "SAMPLE_NOT_BENCHMARK",
  "operational-planning-001": JSON.stringify({
    owner: "release",
    steps: ["rollback", "monitor"],
  }),
  "operational-planning-005": "STOP_AND_REPORT",
};

describe("runEvaluation", () => {
  it("validates the larger public example case set without model calls", async () => {
    const text = await readFile("examples/cases.public.jsonl", "utf8");
    const cases = parseJsonlCases(text);

    const summary = validateEvalCases(cases);
    const manifest = buildCaseSetManifestFromJsonl(text, {
      sourcePath: "examples/cases.public.jsonl",
      intendedUse: "public_sample",
      includeCaseIds: true,
      includeCategoryLabels: true,
    });
    const checkedInManifest = JSON.parse(
      await readFile("examples/cases.public.manifest.json", "utf8"),
    );

    expect(summary.caseCount).toBe(54);
    expect(summary.scoredCaseCount).toBe(summary.caseCount);
    expect(summary.smokeOnlyCaseCount).toBe(0);
    expect(summary.scoredCasesMissingDifficultyCount).toBe(0);
    expect(summary.scoredDifficultyCounts).toEqual({
      easy: 18,
      medium: 18,
      hard: 18,
    });
    expect(summary.duplicateScoredCaseContentGroupCount).toBe(0);
    expect(summary.duplicateScoredCaseContentCaseCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentPairCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentCaseCount).toBe(0);
    expect(Object.keys(summary.categoryCounts)).toHaveLength(9);
    expect(Object.keys(summary.scoredCategoryCounts)).toHaveLength(9);
    expect(Math.min(...Object.values(summary.categoryCounts))).toBe(6);
    expect(Math.max(...Object.values(summary.categoryCounts))).toBe(6);
    expect(Math.min(...Object.values(summary.scoredCategoryCounts))).toBe(6);
    expect(Math.max(...Object.values(summary.scoredCategoryCounts))).toBe(6);
    for (const counts of Object.values(
      summary.scoredCategoryDifficultyCounts,
    )) {
      expect(counts).toEqual({ easy: 2, medium: 2, hard: 2 });
    }
    expect(summary.uncategorizedCaseCount).toBe(0);
    expect(summary.scoredUncategorizedCaseCount).toBe(0);
    for (const [caseId, answer] of Object.entries(publicSampleGoldenAnswers)) {
      const evalCase = cases.find((item) => item.id === caseId);
      if (!evalCase) throw new Error(`Missing public sample case ${caseId}`);
      const result = gradeEvalCaseAnswer(evalCase, answer);
      expect(result.passed, caseId).toBe(true);
    }
    expect(summary.graderKindCounts.json).toBe(16);
    expect(summary.graderKindCounts.number).toBe(8);
    expect(summary.graderKindCounts.choice).toBe(8);
    expect(summary.graderKindCounts.citations).toBe(6);
    expect(summary.totalConfiguredChecks).toBe(253);
    expect(summary.graderEvidenceTierVersion).toBe("grader-evidence-tier-v2");
    expect(summary.graderEvidenceTierCounts).toEqual({
      structured_or_exact: 38,
      surface_text: 16,
      mixed: 0,
      smoke_only: 0,
      ungraded: 0,
    });
    expect(
      Math.min(
        ...Object.values(summary.scoredCategoryNonSurfaceGraderEvidenceCounts),
      ),
    ).toBeGreaterThanOrEqual(3);
    expect(summary.scoredCategoryNonSurfaceGraderEvidenceCounts).toEqual({
      structured_json: 6,
      numeric_reasoning: 6,
      security_privacy: 3,
      cost_budgeting: 3,
      cli_typescript: 3,
      data_pipeline: 4,
      evaluation_design: 4,
      operational_planning: 3,
      citation_mechanics: 6,
    });
    const nonSurfaceByCategoryDifficulty =
      nonSurfaceGraderEvidenceCountsByCategoryDifficulty(cases);
    expect(Object.keys(nonSurfaceByCategoryDifficulty)).toHaveLength(9);
    for (const counts of Object.values(nonSurfaceByCategoryDifficulty)) {
      for (const difficulty of EVAL_CASE_DIFFICULTIES) {
        expect(counts[difficulty]).toBeGreaterThanOrEqual(1);
      }
    }
    expect(manifest.summary.graderEvidence.tierCounts).toEqual(
      summary.graderEvidenceTierCounts,
    );
    expect(
      manifest.summary.scoredCategoryNonSurfaceGraderEvidenceCounts,
    ).toEqual(summary.scoredCategoryNonSurfaceGraderEvidenceCounts);
    expect(manifest.summary.scoredCategoryBalance).toMatchObject({
      categoryCount: 9,
      minScoredCasesPerCategory: 6,
      maxScoredCasesPerCategory: 6,
      scoredUncategorizedCaseCount: 0,
    });
    expect(manifest.summary.difficultyCoverage).toEqual({
      difficultyCounts: { easy: 18, medium: 18, hard: 18 },
      scoredDifficultyCounts: { easy: 18, medium: 18, hard: 18 },
      scoredCasesMissingDifficultyCount: 0,
      smokeOnlyCasesMissingDifficultyCount: 0,
    });
    expect(manifest.summary.casesWithGraderKind.choice).toBe(8);
    expect(manifest.summary.casesWithGraderKind.citations).toBe(6);
    expect(manifest.rows[0]?.graderEvidenceTier).toBe("structured_or_exact");
    expect(manifest.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "security-privacy-004",
          graderKinds: ["choice"],
          graderEvidenceTier: "structured_or_exact",
        }),
        expect.objectContaining({
          id: "cli-typescript-002",
          graderKinds: ["choice"],
          graderEvidenceTier: "structured_or_exact",
        }),
        expect.objectContaining({
          id: "evaluation-design-003",
          graderKinds: ["choice"],
          graderEvidenceTier: "structured_or_exact",
        }),
      ]),
    );
    expect(manifest).toEqual(checkedInManifest);
    expect(manifest.claimReadiness.status).toBe("not_claim_ready");
  });

  it("marks claim gates as case-set constraints without approving public claims", () => {
    const cases = parseJsonlCases(
      claimGateCaseSetJsonl({ categoryCount: 4, casesPerCategory: 30 }),
    );
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(gate.status).toBe("case_set_constraints_met");
    expect(gate.scope).toBe("case_set_only");
    expect(gate.overallClaimStatus).toBe("external_evidence_required");
    expect(gate.blockers).toEqual([]);
    expect(gate.minimums).toEqual({
      scoredCases: 100,
      scoredCasesPerCategory: 30,
      scoredCasesPerDifficulty: 30,
      scoredCasesPerCategoryDifficulty: 5,
      nonSurfaceGraderEvidenceCases: 5,
      nonSurfaceGraderEvidenceCasesPerDifficulty: 5,
      nonSurfaceGraderEvidenceCasesPerCategory: 5,
    });
    expect(gate.categoryGraderEvidence).toEqual({
      claimEligibleCategoryCount: 4,
      minNonSurfaceGraderEvidenceCasesPerCategory: 30,
      underpoweredClaimEligibleCategoryCount: 0,
    });
    expect(gate.categoryDifficultyCoverage).toEqual({
      claimEligibleCategoryCount: 4,
      minScoredCasesPerCategoryDifficulty: 10,
      underpoweredCategoryDifficultyCellCount: 0,
    });
    expect(gate.difficultyCoverage).toEqual({
      scoredCasesMissingDifficultyCount: 0,
      minScoredCasesPerDifficulty: 40,
      maxScoredCasesPerDifficulty: 40,
      underpoweredDifficultyCount: 0,
    });
    expect(gate.difficultyGraderEvidence).toEqual({
      minNonSurfaceGraderEvidenceCasesPerDifficulty: 40,
      underpoweredDifficultyCount: 0,
    });
    expect(gate.externalEvidenceRequired.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "published_or_archived_manifest",
        "holdout_process_record",
        "private_report_reproduction_package",
        "uncertainty_and_category_analysis",
        "hmac_auditor_key_custody",
      ]),
    );
  });

  it("blocks public claim gates when category difficulty coverage is concentrated", () => {
    const secret = "secret-category-difficulty";
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = Array.from({ length: 120 }, (_, index) => {
      const categoryIndex = Math.floor(index / 30);
      return JSON.stringify({
        id: `case-${index + 1}`,
        category: `${secret}-${categoryIndex + 1}`,
        difficulty:
          categoryIndex < 3
            ? difficulties[categoryIndex]
            : difficulties[index % 3],
        task: `Return item-${index}`,
        grader: { exact: `item-${index}` },
      });
    });
    const cases = parseJsonlCases(`${lines.join("\n")}\n`);
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });
    const serialized = JSON.stringify(gate);

    expect(summary.scoredDifficultyCounts).toEqual({
      easy: 40,
      medium: 40,
      hard: 40,
    });
    expect(gate.status).toBe("case_set_blocked");
    expect(gate.categoryDifficultyCoverage).toEqual({
      claimEligibleCategoryCount: 4,
      minScoredCasesPerCategoryDifficulty: 0,
      underpoweredCategoryDifficultyCellCount: 6,
    });
    expect(gate.blockers).toEqual([
      expect.objectContaining({
        code: "category_difficulty_coverage_underpowered",
        evidence: {
          claimEligibleCategoryCount: 4,
          underpoweredCategoryDifficultyCellCount: 6,
          minScoredCasesPerCategoryDifficulty: 0,
          requiredScoredCasesPerCategoryDifficulty: 5,
        },
      }),
    ]);
    expect(serialized).not.toContain(secret);
  });

  it("does not add category difficulty coverage blockers for ineligible categories", () => {
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = [
      ...Array.from({ length: 90 }, (_, index) =>
        JSON.stringify({
          id: `eligible-${index + 1}`,
          category: `eligible-${Math.floor(index / 30) + 1}`,
          difficulty: difficulties[index % 3],
          task: `Return eligible-${index}`,
          grader: { exact: `eligible-${index}` },
        }),
      ),
      ...Array.from({ length: 29 }, (_, index) =>
        JSON.stringify({
          id: `small-${index + 1}`,
          category: "small-category",
          difficulty: "easy",
          task: `Return small-${index}`,
          grader: { exact: `small-${index}` },
        }),
      ),
    ];
    const cases = parseJsonlCases(`${lines.join("\n")}\n`);
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(gate.status).toBe("case_set_blocked");
    expect(gate.blockers.map((finding) => finding.code)).toEqual([
      "category_underpowered",
    ]);
    expect(gate.categoryDifficultyCoverage).toEqual({
      claimEligibleCategoryCount: 3,
      minScoredCasesPerCategoryDifficulty: 10,
      underpoweredCategoryDifficultyCellCount: 0,
    });
  });

  it("blocks public claim gates when scored cases are missing difficulty metadata", () => {
    const cases = parseJsonlCases(
      claimGateCaseSetJsonl({
        categoryCount: 4,
        casesPerCategory: 30,
        difficulty: "omitted",
      }),
    );
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(summary.scoredCasesMissingDifficultyCount).toBe(120);
    expect(gate.status).toBe("case_set_blocked");
    expect(gate.difficultyCoverage).toEqual({
      scoredCasesMissingDifficultyCount: 120,
      minScoredCasesPerDifficulty: 0,
      maxScoredCasesPerDifficulty: 0,
      underpoweredDifficultyCount: 3,
    });
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_scored_case_difficulty",
          evidence: { scoredCasesMissingDifficultyCount: 120 },
        }),
        expect.objectContaining({
          code: "difficulty_underpowered",
          evidence: {
            underpoweredDifficultyCount: 3,
            minScoredCasesPerDifficulty: 0,
            requiredScoredCasesPerDifficulty: 30,
          },
        }),
      ]),
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "category_difficulty_coverage_underpowered",
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "difficulty_non_surface_grader_evidence_underpowered",
    );
  });

  it("blocks public claim gates when difficulty coverage is underpowered", () => {
    const cases = parseJsonlCases(
      claimGateCaseSetJsonl({
        categoryCount: 4,
        casesPerCategory: 30,
        difficulty: "easy_only",
      }),
    );
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(summary.scoredCasesMissingDifficultyCount).toBe(0);
    expect(summary.scoredDifficultyCounts).toEqual({
      easy: 120,
      medium: 0,
      hard: 0,
    });
    expect(gate.status).toBe("case_set_blocked");
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "difficulty_underpowered",
          evidence: {
            underpoweredDifficultyCount: 2,
            minScoredCasesPerDifficulty: 0,
            requiredScoredCasesPerDifficulty: 30,
          },
        }),
      ]),
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "category_difficulty_coverage_underpowered",
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "difficulty_non_surface_grader_evidence_underpowered",
    );
  });

  it("blocks public claim gates when scored case content is exactly duplicated", () => {
    const secret = "PRIVATE-DUPLICATE-CONTENT";
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = Array.from({ length: 120 }, (_, index) => {
      const isDuplicatePair = index === 0 || index === 30;
      const id = isDuplicatePair
        ? `secret-duplicate-id-${index}`
        : `case-${index + 1}`;
      return JSON.stringify({
        id,
        category: `secret-duplicate-category-${Math.floor(index / 30) + 1}`,
        difficulty:
          index === 0
            ? "easy"
            : index === 30
              ? "hard"
              : difficulties[index % 3],
        task: isDuplicatePair
          ? `Analyze duplicate private holdout margin renewal onboarding backlog variance forecast support invoice timing cohort bridge ${secret}`
          : `Return unique-${index}`,
        constraints: isDuplicatePair
          ? ["same duplicate constraint with enough lexical material"]
          : [],
        grader: {
          exact: isDuplicatePair ? secret : `unique-${index}`,
        },
      });
    });
    const summary = validateEvalCases(parseJsonlCases(`${lines.join("\n")}\n`));
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });
    const serialized = JSON.stringify(gate);

    expect(summary.duplicateScoredCaseContentGroupCount).toBe(1);
    expect(summary.duplicateScoredCaseContentCaseCount).toBe(2);
    expect(summary.nearDuplicateScoredCaseContentPairCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentCaseCount).toBe(0);
    expect(gate.status).toBe("case_set_blocked");
    expect(gate.blockers.map((finding) => finding.code)).toEqual([
      "duplicate_scored_case_content",
    ]);
    expect(gate.blockers[0]?.evidence).toEqual({
      duplicateScoredCaseContentGroupCount: 1,
      duplicateScoredCaseContentCaseCount: 2,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("secret-duplicate-id");
    expect(serialized).not.toContain("secret-duplicate-category");
  });

  it("blocks public claim gates when scored case prompts are high-confidence lexical near duplicates", () => {
    const secret = "PRIVATE-NEAR-DUPLICATE-CONTENT";
    const sharedPrompt =
      "Analyze quarterly operating margin bridge for private rollout cohort across retention expansion support cost invoice timing regional variance renewal risk onboarding backlog forecast";
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = Array.from({ length: 120 }, (_, index) => {
      const isNearDuplicatePair = index === 0 || index === 30;
      return JSON.stringify({
        id: isNearDuplicatePair
          ? `secret-near-duplicate-id-${index}`
          : `case-${index + 1}`,
        category: `secret-near-duplicate-category-${Math.floor(index / 30) + 1}`,
        difficulty: difficulties[index % 3],
        task: isNearDuplicatePair
          ? `${sharedPrompt} ${index === 0 ? "alpha" : "beta"} signal ${secret}`
          : `Return unique-${index}`,
        constraints: isNearDuplicatePair
          ? ["Use the same private planning frame and concise final format"]
          : [],
        grader: {
          exact: isNearDuplicatePair ? `${secret}-${index}` : `unique-${index}`,
        },
      });
    });
    const summary = validateEvalCases(parseJsonlCases(`${lines.join("\n")}\n`));
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });
    const serialized = JSON.stringify(gate);

    expect(summary.duplicateScoredCaseContentGroupCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentPairCount).toBe(1);
    expect(summary.nearDuplicateScoredCaseContentCaseCount).toBe(2);
    expect(gate.status).toBe("case_set_blocked");
    expect(gate.blockers).toEqual([
      expect.objectContaining({
        code: "near_duplicate_scored_case_content",
        evidence: {
          nearDuplicateScoredCaseContentPairCount: 1,
          nearDuplicateScoredCaseContentCaseCount: 2,
          nearDuplicateScoredCaseContentThreshold: 0.9,
          nearDuplicateScoredCaseContentMinUsefulTokenCount: 12,
        },
      }),
    ]);
    for (const forbidden of [
      secret,
      "secret-near-duplicate-id",
      "secret-near-duplicate-category",
      "quarterly operating margin",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("coalesces exact duplicate clusters before counting near-duplicate scored case prompts", () => {
    const secret = "PRIVATE-DUPLICATE-CLUSTER";
    const sharedPrompt =
      "Analyze private renewal cohort margin bridge support invoice timing onboarding backlog forecast retention variance escalation";
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = Array.from({ length: 120 }, (_, index) => {
      const isExactDuplicateCluster = index === 0 || index === 30;
      const isNearDuplicateToCluster = index === 60;
      return JSON.stringify({
        id:
          isExactDuplicateCluster || isNearDuplicateToCluster
            ? `secret-cluster-id-${index}`
            : `case-${index + 1}`,
        category: `secret-cluster-category-${Math.floor(index / 30) + 1}`,
        difficulty: difficulties[index % 3],
        task:
          isExactDuplicateCluster || isNearDuplicateToCluster
            ? `${sharedPrompt} ${isNearDuplicateToCluster ? "beta" : "alpha"} signal ${secret}`
            : `Return unique-${index}`,
        constraints:
          isExactDuplicateCluster || isNearDuplicateToCluster
            ? ["Use the same private planning frame and concise final format"]
            : [],
        grader: {
          exact: isExactDuplicateCluster
            ? secret
            : isNearDuplicateToCluster
              ? `${secret}-near`
              : `unique-${index}`,
        },
      });
    });
    const summary = validateEvalCases(parseJsonlCases(`${lines.join("\n")}\n`));
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(summary.duplicateScoredCaseContentGroupCount).toBe(1);
    expect(summary.duplicateScoredCaseContentCaseCount).toBe(2);
    expect(summary.nearDuplicateScoredCaseContentPairCount).toBe(1);
    expect(summary.nearDuplicateScoredCaseContentCaseCount).toBe(2);
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_scored_case_content",
        }),
        expect.objectContaining({
          code: "near_duplicate_scored_case_content",
          evidence: expect.objectContaining({
            nearDuplicateScoredCaseContentPairCount: 1,
            nearDuplicateScoredCaseContentCaseCount: 2,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(gate)).not.toContain(secret);
    expect(JSON.stringify(gate)).not.toContain("secret-cluster-id");
    expect(JSON.stringify(gate)).not.toContain("secret-cluster-category");
  });

  it("does not block claim gates for duplicate smoke-only content", () => {
    const scoredCases = parseJsonlCases(
      claimGateCaseSetJsonl({ categoryCount: 4, casesPerCategory: 30 }),
    );
    const cases: EvalCase[] = [
      ...scoredCases,
      {
        id: "smoke-duplicate-a",
        task: "Smoke duplicate private lexical holdout margin renewal onboarding backlog variance forecast support invoice timing cohort bridge",
        constraints: ["same smoke near duplicate planning frame"],
        smokeOnly: true,
        grader: { exact: "smoke duplicate answer" },
      },
      {
        id: "smoke-duplicate-b",
        task: "Smoke duplicate private lexical holdout margin renewal onboarding backlog variance forecast support invoice timing cohort bridge",
        constraints: ["same smoke near duplicate planning frame"],
        smokeOnly: true,
        grader: { exact: "smoke duplicate answer" },
      },
    ];
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(summary.duplicateScoredCaseContentGroupCount).toBe(0);
    expect(summary.duplicateScoredCaseContentCaseCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentPairCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentCaseCount).toBe(0);
    expect(gate.status).toBe("case_set_constraints_met");
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "duplicate_scored_case_content",
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "near_duplicate_scored_case_content",
    );
    expect(gate.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "smoke_only_cases_excluded",
          evidence: { smokeOnlyCaseCount: 2 },
        }),
      ]),
    );
  });

  it("does not block public claim gates for short templated scored cases below the near-duplicate token floor", () => {
    const cases = parseJsonlCases(
      claimGateCaseSetJsonl({ categoryCount: 4, casesPerCategory: 30 }),
    );
    cases[0] = {
      ...cases[0]!,
      task: "Return shared alpha 001",
      constraints: ["same short frame"],
      grader: { exact: "short-alpha" },
    };
    cases[30] = {
      ...cases[30]!,
      task: "Return shared alpha 002",
      constraints: ["same short frame"],
      grader: { exact: "short-beta" },
    };
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(summary.nearDuplicateScoredCaseContentPairCount).toBe(0);
    expect(summary.nearDuplicateScoredCaseContentCaseCount).toBe(0);
    expect(gate.status).toBe("case_set_constraints_met");
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "near_duplicate_scored_case_content",
    );
  });

  it("blocks public claim gates when scored case evidence is surface-text only", () => {
    const secret = "PRIVATE-GRADER-VALUE";
    const difficulties = ["easy", "medium", "hard"] as const;
    const cases = parseJsonlCases(
      Array.from({ length: 120 }, (_, index) =>
        JSON.stringify({
          id: `case-${index + 1}`,
          category: `category-${Math.floor(index / 30) + 1}`,
          difficulty: difficulties[index % 3],
          task: `Mention ${secret} for item ${index}`,
          grader: { mustInclude: [secret] },
        }),
      ).join("\n") + "\n",
    );
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("case_set_blocked");
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
    expect(serialized).not.toContain(secret);
  });

  it("blocks public claim gates when non-surface grader evidence is concentrated in one category", () => {
    const secret = "PRIVATE-CATEGORY-GRADER";
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = Array.from({ length: 120 }, (_, index) => {
      const categoryIndex = Math.floor(index / 30);
      return JSON.stringify({
        id: `case-${index + 1}`,
        category: `secret-category-${categoryIndex + 1}`,
        difficulty: difficulties[index % 3],
        task: `Mention ${secret} for item ${index}`,
        grader:
          categoryIndex === 0 ? { exact: "ok" } : { mustInclude: [secret] },
      });
    });
    const cases = parseJsonlCases(`${lines.join("\n")}\n`);
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });
    const serialized = JSON.stringify(gate);

    expect(gate.status).toBe("case_set_blocked");
    expect(gate.categoryGraderEvidence).toEqual({
      claimEligibleCategoryCount: 4,
      minNonSurfaceGraderEvidenceCasesPerCategory: 0,
      underpoweredClaimEligibleCategoryCount: 3,
    });
    expect(gate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "category_non_surface_grader_evidence_underpowered",
          evidence: {
            categoryCount: 4,
            underpoweredCategoryCount: 3,
            minNonSurfaceGraderEvidenceCasesPerCategory: 0,
            requiredNonSurfaceGraderEvidenceCasesPerCategory: 5,
          },
        }),
      ]),
    );
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("secret-category");
  });

  it("blocks public claim gates when non-surface grader evidence is concentrated in one difficulty", () => {
    const secret = "PRIVATE-DIFFICULTY-GRADER";
    const difficulties = ["easy", "medium", "hard"] as const;
    const lines = Array.from({ length: 120 }, (_, index) => {
      const categoryIndex = Math.floor(index / 30);
      const difficulty = difficulties[index % difficulties.length]!;
      const caseInCategory = index % 30;
      const isEasyNonSurface = difficulty === "easy" && caseInCategory < 15;
      return JSON.stringify({
        id: `case-${index + 1}`,
        category: `secret-difficulty-category-${categoryIndex + 1}`,
        difficulty,
        task: `Mention ${secret} for item ${index}`,
        grader: isEasyNonSurface
          ? { exact: `answer-${index}` }
          : { mustInclude: [secret] },
      });
    });
    const cases = parseJsonlCases(`${lines.join("\n")}\n`);
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });
    const serialized = JSON.stringify(gate);

    expect(summary.scoredDifficultyCounts).toEqual({
      easy: 40,
      medium: 40,
      hard: 40,
    });
    expect(summary.scoredDifficultyNonSurfaceGraderEvidenceCounts).toEqual({
      easy: 20,
      medium: 0,
      hard: 0,
    });
    expect(gate.status).toBe("case_set_blocked");
    expect(gate.categoryGraderEvidence).toEqual({
      claimEligibleCategoryCount: 4,
      minNonSurfaceGraderEvidenceCasesPerCategory: 5,
      underpoweredClaimEligibleCategoryCount: 0,
    });
    expect(gate.difficultyGraderEvidence).toEqual({
      minNonSurfaceGraderEvidenceCasesPerDifficulty: 0,
      underpoweredDifficultyCount: 2,
    });
    expect(gate.blockers).toEqual([
      expect.objectContaining({
        code: "difficulty_non_surface_grader_evidence_underpowered",
        evidence: {
          underpoweredDifficultyCount: 2,
          minNonSurfaceGraderEvidenceCasesPerDifficulty: 0,
          requiredNonSurfaceGraderEvidenceCasesPerDifficulty: 5,
        },
      }),
    ]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("secret-difficulty-category");
  });

  it("allows mixed-only claim gates while still warning that graders are mechanical", () => {
    const difficulties = ["easy", "medium", "hard"] as const;
    const cases = parseJsonlCases(
      Array.from({ length: 120 }, (_, index) =>
        JSON.stringify({
          id: `case-${index + 1}`,
          category: `category-${Math.floor(index / 30) + 1}`,
          difficulty: difficulties[index % 3],
          task: `Return the exact JSON answer for item ${index}.`,
          grader: {
            mustInclude: [`ok-${index}`],
            json: { requireValid: true },
          },
        }),
      ).join("\n") + "\n",
    );
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "holdout",
      manifestRequested: true,
      manifestHashAlgorithm: "hmac-sha256",
    });

    expect(gate.status).toBe("case_set_constraints_met");
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "insufficient_non_surface_grader_evidence",
    );
    expect(gate.blockers.map((finding) => finding.code)).not.toContain(
      "category_non_surface_grader_evidence_underpowered",
    );
    expect(gate.categoryGraderEvidence).toEqual({
      claimEligibleCategoryCount: 4,
      minNonSurfaceGraderEvidenceCasesPerCategory: 30,
      underpoweredClaimEligibleCategoryCount: 0,
    });
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

  it("includes citation grader kinds in case-set manifests", () => {
    const secretSourceId = "PRIVATE-CITATION-SOURCE-ID";
    const secretClaim = "Private citation claim text";
    const manifest = buildCaseSetManifest(
      [
        {
          id: "citation-case",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: [secretSourceId],
              requiredSourceIds: [secretSourceId],
              requiredClaims: [{ sourceId: secretSourceId, text: secretClaim }],
            },
          },
        },
      ],
      { intendedUse: "dev" },
    );
    const serialized = JSON.stringify(manifest);

    expect(manifest.schemaVersion).toBe("frugal-fusion-case-set-manifest-v4");
    expect(manifest.summary.casesWithGraderKind.citations).toBe(1);
    expect(
      manifest.summary.graderEvidence.ignoredSmokeOnlyConfiguredGraderKindCounts
        .citations,
    ).toBe(0);
    expect(manifest.summary.graderEvidence.version).toBe(
      "grader-evidence-tier-v2",
    );
    expect(manifest.rows[0]?.graderKinds).toEqual(["citations"]);
    expect(manifest.rows[0]?.graderEvidenceTier).toBe("structured_or_exact");
    expect(manifest.rows[0]?.canonicalRowSha256).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(serialized).not.toContain(secretSourceId);
    expect(serialized).not.toContain(secretClaim);
  });

  it("omits JSON schema-subset literals from case-set manifests while hashing grader values", () => {
    const secretEnum = "PRIVATE-SCHEMA-MANIFEST-ENUM";
    const secretProperty = "privateDecision";
    const manifest = buildCaseSetManifest(
      [
        {
          id: "schema-case",
          task: "Return strict JSON.",
          grader: {
            json: {
              schemaSubset: {
                type: "object",
                properties: {
                  [secretProperty]: { type: "string", enum: [secretEnum] },
                },
                required: [secretProperty],
                additionalProperties: false,
              },
            },
          },
        },
      ],
      { intendedUse: "dev" },
    );
    const serialized = JSON.stringify(manifest);

    expect(manifest.summary.casesWithGraderKind.json).toBe(1);
    expect(manifest.privacy.rowHashesIncludeGraderValues).toBe(true);
    expect(manifest.rows[0]?.graderKinds).toEqual(["json"]);
    expect(manifest.rows[0]?.graderEvidenceTier).toBe("structured_or_exact");
    expect(serialized).not.toContain(secretEnum);
    expect(serialized).not.toContain(secretProperty);
  });

  it("blocks underpowered public claim gates without leaking taxonomy labels", () => {
    const secret = "secret-taxonomy";
    const cases = parseJsonlCases(
      `${JSON.stringify({
        id: "secret-case-id",
        category: secret,
        task: "Return private answer",
        grader: { mustInclude: ["private-answer"] },
      })}\n`,
    );
    const summary = validateEvalCases(cases);
    const gate = assessEvalClaimGate(summary, {
      intendedUse: "public_sample",
      manifestRequested: false,
    });

    expect(gate.status).toBe("case_set_blocked");
    expect(gate.blockers.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "not_holdout",
        "manifest_absent_for_this_assessment",
        "too_few_scored_cases",
        "category_underpowered",
      ]),
    );
    expect(JSON.stringify(gate)).not.toContain(secret);
    expect(JSON.stringify(gate)).not.toContain("secret-case-id");
    expect(JSON.stringify(gate)).not.toContain("private-answer");
  });

  it("uses a canonical case-set fingerprint independent of JSON key order", () => {
    const left = parseJsonlCases(
      '{"id":"case","task":"Mention schema","category":"sample","grader":{"mustInclude":["schema"],"minLength":12}}\n',
    );
    const right = parseJsonlCases(
      '{"grader":{"minLength":12,"mustInclude":["schema"]},"category":"sample","task":"Mention schema","id":"case"}\n',
    );

    expect(caseSetFingerprint(left)).toBe(caseSetFingerprint(right));
  });

  it("includes difficulty in case-set and manifest identity", () => {
    const base: EvalCase = {
      id: "case",
      task: "Mention schema",
      category: "sample",
      difficulty: "easy",
      grader: { mustInclude: ["schema"] },
    };
    const easyCases = [base];
    const hardCases = [{ ...base, difficulty: "hard" as const }];
    const easyManifest = buildCaseSetManifest(easyCases, {
      intendedUse: "public_sample",
    });
    const hardManifest = buildCaseSetManifest(hardCases, {
      intendedUse: "public_sample",
    });

    expect(caseSetFingerprint(easyCases)).not.toBe(
      caseSetFingerprint(hardCases),
    );
    expect(easyManifest.fingerprintVersion).toBe("case-set-canonical-v3");
    expect(easyManifest.fingerprint.content).toBe(
      "validated-eval-case-set-with-hashed-prompts-and-difficulty-v1",
    );
    expect(easyManifest.fingerprint.canonicalSha256).not.toBe(
      hardManifest.fingerprint.canonicalSha256,
    );
    expect(easyManifest.rows[0]?.canonicalRowSha256).not.toBe(
      hardManifest.rows[0]?.canonicalRowSha256,
    );
  });

  it("includes citation placement in private manifest identity without exposing claim text in HMAC manifests", () => {
    const secretClaim = "Private revenue rose 12%";
    const key = "citation-placement-hmac-key-32-bytes";
    const base: EvalCase = {
      id: "citation-placement",
      task: "Use bracket citations.",
      category: "sample",
      grader: {
        citations: {
          allowedSourceIds: ["S1"],
          requiredClaims: [{ sourceId: "S1", text: secretClaim }],
        },
      },
    };
    const immediate: EvalCase = {
      ...base,
      grader: {
        citations: {
          allowedSourceIds: ["S1"],
          requiredClaims: [
            {
              sourceId: "S1",
              text: secretClaim,
              citationPlacement: "immediate",
            },
          ],
        },
      },
    };

    const baseManifest = buildCaseSetManifest([base], {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });
    const immediateManifest = buildCaseSetManifest([immediate], {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });
    const serializedImmediateManifest = JSON.stringify(immediateManifest);

    expect(baseManifest.fingerprint.canonicalHmacSha256).not.toBe(
      immediateManifest.fingerprint.canonicalHmacSha256,
    );
    expect(baseManifest.rows[0]?.canonicalRowHmacSha256).not.toBe(
      immediateManifest.rows[0]?.canonicalRowHmacSha256,
    );
    expect(serializedImmediateManifest).not.toContain(secretClaim);
    expect(serializedImmediateManifest).not.toContain("S1");
    expect(serializedImmediateManifest).not.toContain("sourceId");
    expect(serializedImmediateManifest).not.toContain("requiredClaims");
    expect(serializedImmediateManifest).not.toContain("citationPlacement");
    expect(serializedImmediateManifest).not.toContain("immediate");
    expect(serializedImmediateManifest).not.toContain("within_window");
  });

  it("reports JSONL parse line numbers before validation", () => {
    expect(() => parseJsonlCases('{"id":"ok","task":"Task"}\n{')).toThrow(
      /line 2/,
    );
  });

  it("rejects empty eval case sets through the no-spend validator", () => {
    expect(() => validateEvalCases([])).toThrow(/at least one case/);
  });

  it("rejects unknown eval case fields through the no-spend validator", () => {
    expect(() =>
      validateEvalCases([
        {
          id: "bad-extra",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
          prompt: "unexpected",
        } as never,
      ]),
    ).toThrow(/prompt is not allowed/);
  });

  it("rejects invalid eval case difficulty labels before spend", () => {
    expect(() =>
      validateEvalCases([
        {
          id: "bad-difficulty",
          task: "Mention schema",
          difficulty: "expert",
          grader: { mustInclude: ["schema"] },
        } as never,
      ]),
    ).toThrow(/difficulty must be easy, medium, or hard/);
  });

  it("rejects explicit undefined values before canonical fingerprinting", () => {
    expect(() =>
      validateEvalCases([
        {
          id: "undefined-grader",
          task: "Mention schema",
          grader: { exact: undefined },
        } as never,
      ]),
    ).toThrow(/must not be undefined/);
  });

  it("validates supplied smoke-only grader shape", () => {
    expect(() =>
      validateEvalCases([
        {
          id: "smoke-typo",
          task: "Smoke",
          smokeOnly: true,
          grader: { typo: true } as never,
        },
      ]),
    ).toThrow(/typo is not allowed/);
  });

  it("classifies smoke-only cases as smoke evidence even with configured graders", () => {
    const summary = validateEvalCases([
      {
        id: "smoke-with-grader",
        task: "Smoke",
        smokeOnly: true,
        grader: { mustInclude: ["secret-token"] },
      },
    ]);

    expect(summary.graderEvidenceTierCounts).toEqual({
      structured_or_exact: 0,
      surface_text: 0,
      mixed: 0,
      smoke_only: 1,
      ungraded: 0,
    });
    expect(summary.smokeOnlyCasesWithConfiguredGraderCount).toBe(1);
    expect(summary.ignoredSmokeOnlyConfiguredGraderKindCounts).toMatchObject({
      mustInclude: 1,
    });
    expect(summary.ignoredSmokeOnlyConfiguredCheckCount).toBe(1);
    expect(summary.graderKindCounts.mustInclude).toBe(0);
    expect(summary.totalConfiguredChecks).toBe(0);
  });

  it("classifies a single case with structured and surface checks as mixed evidence", () => {
    const text =
      '{"id":"mixed","task":"Return ok","grader":{"exact":"ok","mustInclude":["ok"]}}\n';
    const cases = parseJsonlCases(text);
    const summary = validateEvalCases(cases);
    const manifest = buildCaseSetManifestFromJsonl(text);

    expect(summary.graderEvidenceTierCounts).toEqual({
      structured_or_exact: 0,
      surface_text: 0,
      mixed: 1,
      smoke_only: 0,
      ungraded: 0,
    });
    expect(manifest.rows[0]?.graderEvidenceTier).toBe("mixed");
  });

  it("builds deterministic private-audit HMAC manifests without unsalted digest fields", () => {
    const secret = "sk-or-v1-private-answer";
    const text = `${JSON.stringify({
      id: "secret-case-id",
      category: "secret-category",
      task: `Return ${secret}`,
      grader: { exact: secret },
    })}\n`;
    const cases = parseJsonlCases(text);
    const keyA = "lRLbLCRCGUtnZ2TyN5sJ5gEkJ58dAyMVBKwQiYMbTwg=";
    const keyB = "WRt1U0DcnP9smYHF0mQ4sH1T7iDmt+kyklYp3YTdypY=";

    const manifestA = buildCaseSetManifestFromJsonl(text, {
      hashMode: { kind: "hmac-sha256", key: keyA },
    });
    const manifestAgain = buildCaseSetManifestFromJsonl(text, {
      hashMode: { kind: "hmac-sha256", key: keyA },
    });
    const manifestB = buildCaseSetManifestFromJsonl(text, {
      hashMode: { kind: "hmac-sha256", key: keyB },
    });
    const changedGraderManifest = buildCaseSetManifestFromJsonl(
      `${JSON.stringify({
        id: "secret-case-id",
        category: "secret-category",
        task: `Return ${secret}`,
        grader: { exact: "different-private-answer" },
      })}\n`,
      { hashMode: { kind: "hmac-sha256", key: keyA } },
    );

    expect(manifestA).toEqual(manifestAgain);
    expect(manifestA.fingerprint).toMatchObject({
      algorithm: "hmac-sha256",
      canonicalHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifestA.fingerprint).not.toHaveProperty("canonicalSha256");
    expect(manifestA.source).toMatchObject({
      rawFileHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifestA.source).not.toHaveProperty("rawFileSha256");
    expect(manifestA.privacy).toMatchObject({
      rowHashesCanLinkPublicCases: false,
      rowHashesIncludeGraderValues: true,
      rowHashesAreUnsalted: false,
      rowHashesAreKeyed: true,
      hashPrivacy: "private_audit_hmac_sha256",
      structuralMetadataVisible: true,
    });
    expect(manifestA.rows[0]).toMatchObject({
      canonicalRowHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      rawLineHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifestA.rows[0]).not.toHaveProperty("canonicalRowSha256");
    expect(manifestA.rows[0]).not.toHaveProperty("rawLineSha256");
    expect(manifestA.fingerprint.canonicalHmacSha256).not.toBe(
      manifestB.fingerprint.canonicalHmacSha256,
    );
    expect(manifestA.source.rawFileHmacSha256).not.toBe(
      manifestB.source.rawFileHmacSha256,
    );
    expect(manifestA.rows[0]?.canonicalRowHmacSha256).not.toBe(
      manifestB.rows[0]?.canonicalRowHmacSha256,
    );
    expect(manifestA.rows[0]?.rawLineHmacSha256).not.toBe(
      manifestB.rows[0]?.rawLineHmacSha256,
    );
    expect(manifestA.fingerprint.canonicalHmacSha256).not.toBe(
      changedGraderManifest.fingerprint.canonicalHmacSha256,
    );
    expect(manifestA.rows[0]?.canonicalRowHmacSha256).not.toBe(
      changedGraderManifest.rows[0]?.canonicalRowHmacSha256,
    );
    expect(caseSetFingerprint(cases)).toMatch(/^[a-f0-9]{64}$/);
    for (const forbidden of [secret, keyA, keyB, "secret-category"]) {
      expect(JSON.stringify(manifestA)).not.toContain(forbidden);
    }
  });

  it("verifies SHA public-sample manifest bindings and records them in private reports", async () => {
    const cases: EvalCase[] = [
      {
        id: "public-case",
        task: "Mention schema",
        category: "public-category",
        grader: { mustInclude: ["schema"] },
      },
    ];
    const manifest = buildCaseSetManifest(cases, {
      intendedUse: "public_sample",
    });
    const binding = verifyCaseSetManifestBinding(
      cases,
      JSON.stringify(manifest),
      { verifiedAt: "2026-06-24T00:00:00.000Z" },
    );

    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      {
        configs: ["direct"],
        caseSetManifestBinding: binding,
      },
    );

    expect(binding).toMatchObject({
      status: "verified",
      intendedUse: "public_sample",
      hashAlgorithm: "sha256",
      privacyClass: "public_or_frozen_sha256",
      digestDisclosure: "private_report_only",
    });
    expect(report.caseSetHash).toBe(caseSetFingerprint(cases));
    expect(report.caseSetHash).not.toBe(binding.digestSha256);
    expect(report.caseSetManifestBinding).toEqual(binding);
    expect(report.caseSetClaimGate).toMatchObject({
      target: "public_cost_performance",
      scope: "case_set_only",
      manifest: {
        requested: true,
        hashAlgorithm: "sha256",
      },
    });
  });

  it("rejects SHA manifests that include category or row labels without disclosure flags", () => {
    const cases: EvalCase[] = [
      {
        id: "public-case",
        task: "Mention schema",
        category: "PRIVATE_CATEGORY",
        grader: { exact: "schema" },
      },
    ];
    const manifest = buildCaseSetManifest(cases, {
      intendedUse: "public_sample",
    });
    const leakySummaryManifest = {
      ...manifest,
      summary: {
        ...manifest.summary,
        scoredCategoryNonSurfaceGraderEvidenceCounts: {
          PRIVATE_CATEGORY: 1,
        },
      },
    };
    const leakyRowManifest = {
      ...manifest,
      rows: [
        {
          ...manifest.rows[0]!,
          id: "public-case",
          category: "PRIVATE_CATEGORY",
        },
      ],
    };

    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(leakySummaryManifest)),
    ).toThrow(/invalid_manifest_summary/);
    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(leakyRowManifest)),
    ).toThrow(/invalid_manifest_rows/);
  });

  it("verifies HMAC holdout manifest bindings without retaining unkeyed case-set hashes", async () => {
    const key = "holdout-binding-hmac-key-32-bytes";
    const cases: EvalCase[] = [
      {
        id: "holdout-case",
        task: "Mention schema",
        category: "holdout-category",
        grader: { mustInclude: ["schema"] },
      },
    ];
    const manifest = buildCaseSetManifest(cases, {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });
    const binding = verifyCaseSetManifestBinding(
      cases,
      JSON.stringify(manifest),
      { hmacKey: key, verifiedAt: "2026-06-24T00:00:00.000Z" },
    );

    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      {
        configs: ["direct"],
        caseSetManifestBinding: binding,
      },
    );

    expect(binding).toMatchObject({
      status: "verified",
      intendedUse: "holdout",
      hashAlgorithm: "hmac-sha256",
      privacyClass: "private_audit_hmac_sha256",
      digestDisclosure: "private_report_only",
    });
    expect(report.caseSetHash).toBeNull();
    expect(report.caseSetManifestBinding).toEqual(binding);
    expect(report.caseSetClaimGate).toMatchObject({
      target: "public_cost_performance",
      scope: "case_set_only",
      manifest: {
        requested: true,
        hashAlgorithm: "hmac-sha256",
      },
    });
    expect(JSON.stringify(report)).not.toContain(caseSetFingerprint(cases));
    expect(JSON.stringify(report)).not.toContain(key);
  });

  it("rejects caller-supplied case-set claim gates before model calls", async () => {
    const key = "forged-claim-gate-hmac-key-32-bytes";
    const cases: EvalCase[] = [
      {
        id: "blocked-holdout-case",
        task: "Mention schema",
        category: "holdout-category",
        grader: { mustInclude: ["schema"] },
      },
    ];
    const manifest = buildCaseSetManifest(cases, {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });
    const binding = verifyCaseSetManifestBinding(
      cases,
      JSON.stringify(manifest),
      { hmacKey: key, verifiedAt: "2026-06-24T00:00:00.000Z" },
    );
    const forgedPassingGate = {
      ...assessEvalClaimGate(validateEvalCases(cases), {
        intendedUse: binding.intendedUse,
        manifestRequested: true,
        manifestHashAlgorithm: binding.hashAlgorithm,
      }),
      status: "case_set_constraints_met",
      blockers: [],
    } as const;
    const client = new FakeModelClient([
      { kind: "ok", output: { answer: "schema" } },
    ]);

    await expect(
      runEvaluation(cases, makeOrchestrator(client), budget, {
        configs: ["direct"],
        caseSetManifestBinding: binding,
        caseSetClaimGate: forgedPassingGate,
      } as Parameters<typeof runEvaluation>[3] & {
        caseSetClaimGate: typeof forgedPassingGate;
      }),
    ).rejects.toThrow(/caseSetClaimGate is derived/);
    expect(client.calls).toEqual([]);
  });

  it("rejects malformed or mismatched manifest bindings before evaluation", () => {
    const key = "manifest-binding-hmac-key-32-bytes";
    const cases = [
      {
        id: "case",
        task: "Mention schema",
        category: "category",
        grader: { mustInclude: ["schema"] },
      },
    ];
    const changedCases = [
      {
        ...cases[0]!,
        grader: { mustInclude: ["different"] },
      },
    ];
    const mismatched = buildCaseSetManifest(changedCases, {
      intendedUse: "public_sample",
    });
    const shaHoldout = buildCaseSetManifest(cases, {
      intendedUse: "holdout",
    });
    const hmacHoldout = buildCaseSetManifest(cases, {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });
    const relabeledHmacHoldout = {
      ...buildCaseSetManifest(cases, {
        intendedUse: "dev",
        hashMode: { kind: "hmac-sha256", key },
      }),
      intendedUse: "holdout",
    };
    const leakyHmacHoldout = {
      ...hmacHoldout,
      rows: [
        {
          ...hmacHoldout.rows[0]!,
          id: "secret-id",
          category: "secret-category",
          canonicalRowSha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      ],
    };

    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(mismatched)),
    ).toThrow(/digest_mismatch/);
    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(shaHoldout)),
    ).toThrow(/sha256_holdout_manifest_rejected/);
    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(hmacHoldout)),
    ).toThrow(/hmac_key_required/);
    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(hmacHoldout), {
        hmacKey: "wrong-manifest-binding-key-32-bytes",
      }),
    ).toThrow(/digest_mismatch/);
    expect(() =>
      verifyCaseSetManifestBinding(
        cases,
        JSON.stringify(relabeledHmacHoldout),
        {
          hmacKey: key,
        },
      ),
    ).toThrow(/digest_mismatch/);
    expect(() =>
      verifyCaseSetManifestBinding(cases, JSON.stringify(leakyHmacHoldout), {
        hmacKey: key,
      }),
    ).toThrow(/invalid_manifest_rows/);
    expect(() =>
      verifyCaseSetManifestBinding(
        cases,
        JSON.stringify({
          schemaVersion: "frugal-fusion-case-set-manifest-v3",
          fingerprint: { algorithm: "sha256", canonicalSha256: "ABC" },
        }),
      ),
    ).toThrow(/invalid_manifest/);
  });

  it("rejects weak HMAC manifest keys in the builder", () => {
    expect(() =>
      buildCaseSetManifestFromJsonl(
        '{"id":"case","task":"Task","grader":{"exact":"ok"}}\n',
        { hashMode: { kind: "hmac-sha256", key: "short" } },
      ),
    ).toThrow(/at least 32 bytes/);
  });

  it("rejects HMAC disclosure and mixed digest options in the exported builder", () => {
    const text = '{"id":"case","task":"Task","grader":{"exact":"ok"}}\n';
    const hmacMode = {
      hashMode: {
        kind: "hmac-sha256" as const,
        key: "lRLbLCRCGUtnZ2TyN5sJ5gEkJ58dAyMVBKwQiYMbTwg=",
      },
    };

    expect(() =>
      buildCaseSetManifestFromJsonl(text, {
        ...hmacMode,
        sourcePath: "private.jsonl",
      }),
    ).toThrow(/do not allow source labels/);
    expect(() =>
      buildCaseSetManifestFromJsonl(text, {
        ...hmacMode,
        includeCaseIds: true,
      }),
    ).toThrow(/do not allow source labels/);
    expect(() =>
      buildCaseSetManifestFromJsonl(text, {
        ...hmacMode,
        includeCategoryLabels: true,
      }),
    ).toThrow(/do not allow source labels/);
    expect(() =>
      buildCaseSetManifest(parseJsonlCases(text), {
        ...hmacMode,
        rawFileSha256: "0".repeat(64),
      }),
    ).toThrow(/raw SHA-256/);
    expect(() =>
      buildCaseSetManifest(parseJsonlCases(text), {
        rawFileHmacSha256: "0".repeat(64),
      }),
    ).toThrow(/HMAC source digests/);
  });

  it("rejects null smoke-only graders as malformed", () => {
    expect(() =>
      validateEvalCases([
        {
          id: "smoke-null",
          task: "Smoke",
          smokeOnly: true,
          grader: null,
        } as never,
      ]),
    ).toThrow(/grader must be an object/);
  });

  it("runs validate-cases without API key, model snapshot, or private category labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const secret = "sk-or-v1-secret";
    await writeFile(
      file,
      `${JSON.stringify({
        id: "case-1",
        category: "private_taxonomy",
        task: "Mention schema",
        grader: { mustInclude: ["schema", secret] },
      })}\n`,
    );

    try {
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      const manifestOut = join(dir, "manifest.json");
      const { stdout } = await execFileAsync(
        "node_modules/.bin/tsx",
        ["src/cli.ts", "validate-cases", file, "--manifest-out", manifestOut],
        { cwd: process.cwd(), env },
      );
      const summary = JSON.parse(stdout) as {
        categoryBalance: { categoryCount: number };
        privacy: { categoryLabels: string };
      };
      const manifestText = await readFile(manifestOut, "utf8");

      expect(summary.categoryBalance.categoryCount).toBe(1);
      expect(summary.privacy.categoryLabels).toBe("omitted");
      expect(stdout).not.toContain("private_taxonomy");
      expect(stdout).not.toContain(secret);
      expect(manifestText).not.toContain("private_taxonomy");
      expect(manifestText).not.toContain(secret);
      expect(manifestText).not.toContain(file);
      expect(JSON.parse(manifestText)).toMatchObject({
        intendedUse: "dev",
        summary: {
          scoredCategoryBalance: {
            categoryCount: 1,
            minScoredCasesPerCategory: 1,
            maxScoredCasesPerCategory: 1,
            scoredUncategorizedCaseCount: 0,
          },
          graderEvidence: {
            version: "grader-evidence-tier-v2",
            tierCounts: {
              surface_text: 1,
            },
          },
        },
        source: {
          rawFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        privacy: {
          includesCaseIds: false,
          includesCategoryLabels: false,
          rowHashesIncludeGraderValues: true,
          rowHashesAreUnsalted: true,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports claim-gate blockers as parseable public JSON with exit code 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    const secret = "sk-or-v1-claim-secret";
    await writeFile(
      file,
      `${JSON.stringify({
        id: "secret-claim-id",
        category: "private_claim_taxonomy",
        task: `Mention ${secret}`,
        grader: { mustInclude: [secret] },
      })}\n`,
    );

    try {
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      let failure: { code?: number; stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--manifest-out",
            manifestOut,
            "--claim-gate",
            "public_cost_performance",
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error("Expected claim gate to block");
      } catch (error) {
        failure = error as typeof failure;
      }

      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toBe("");
      const output = JSON.parse(failure.stdout ?? "") as {
        claimGate: {
          status: string;
          overallClaimStatus: string;
          blockers: Array<{ code: string }>;
        };
        privacy: { categoryLabels: string };
      };
      expect(output.claimGate.status).toBe("case_set_blocked");
      expect(output.claimGate.overallClaimStatus).toBe(
        "external_evidence_required",
      );
      expect(output.claimGate.blockers.map((finding) => finding.code)).toEqual(
        expect.arrayContaining([
          "not_holdout",
          "too_few_scored_cases",
          "category_underpowered",
        ]),
      );
      expect(output.privacy.categoryLabels).toBe("omitted");
      for (const forbidden of [
        secret,
        "secret-claim-id",
        "private_claim_taxonomy",
        file,
      ]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
      await expect(readFile(manifestOut, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects private summaries before reading files when claim gates are requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    await writeFile(
      file,
      '{"id":"leaky-duplicate","category":"secret","task":"Task","grader":{"exact":"ok"}}\n{"id":"leaky-duplicate","category":"secret","task":"Task","grader":{"exact":"ok"}}\n',
    );

    try {
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--claim-gate",
            "public_cost_performance",
            "--private",
          ],
          { cwd: process.cwd(), env: { ...process.env } },
        );
        throw new Error("Expected --private --claim-gate to be rejected");
      } catch (error) {
        const failure = error as { stderr?: string };
        expect(failure.stderr ?? "").toContain(
          "--private cannot be combined with --claim-gate",
        );
        expect(failure.stderr ?? "").not.toContain("leaky-duplicate");
        expect(failure.stderr ?? "").not.toContain("Duplicate eval case id");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects claim-gate disclosure flags before reading private files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    await writeFile(file, "{");

    try {
      await expect(
        execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--claim-gate",
            "public_cost_performance",
            "--source-label",
            "private-holdout.jsonl",
          ],
          { cwd: process.cwd(), env: { ...process.env } },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Claim gates do not allow"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports claim-gate validation failures without leaking case identifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const secret = "PRIVATE-SOURCE-123";
    await writeFile(
      file,
      `${JSON.stringify({
        id: secret,
        category: "private-category",
        task: "Task",
        grader: { exact: "ok" },
      })}\n${JSON.stringify({
        id: secret,
        category: "private-category",
        task: "Task",
        grader: { exact: "ok" },
      })}\n`,
    );

    try {
      let failure: { code?: number; stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--claim-gate",
            "public_cost_performance",
          ],
          { cwd: process.cwd(), env: { ...process.env } },
        );
        throw new Error("Expected claim-gate validation failure");
      } catch (error) {
        failure = error as typeof failure;
      }

      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toBe("");
      const output = JSON.parse(failure.stdout ?? "") as {
        claimGate: { status: string; blockers: Array<{ code: string }> };
      };
      expect(output.claimGate.status).toBe("case_set_blocked");
      expect(output.claimGate.blockers.map((finding) => finding.code)).toEqual([
        "case_file_parse_or_validation_failed",
      ]);
      for (const forbidden of [
        secret,
        "private-category",
        "Duplicate eval case id",
        "exact",
        file,
      ]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks SHA-256 holdout claim gates because private holdouts require HMAC manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    await writeFile(
      file,
      claimGateCaseSetJsonl({ categoryCount: 4, casesPerCategory: 30 }),
    );

    try {
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      let failure: { code?: number; stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--manifest-out",
            manifestOut,
            "--intended-use",
            "holdout",
            "--claim-gate",
            "public_cost_performance",
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error("Expected SHA-256 holdout claim gate to block");
      } catch (error) {
        failure = error as typeof failure;
      }
      const summary = JSON.parse(failure.stdout ?? "") as {
        claimGate: {
          status: string;
          overallClaimStatus: string;
          blockers: Array<{ code: string }>;
          manifest: { hashAlgorithm: string };
        };
      };

      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toBe("");
      expect(summary.claimGate.status).toBe("case_set_blocked");
      expect(summary.claimGate.overallClaimStatus).toBe(
        "external_evidence_required",
      );
      expect(summary.claimGate.blockers.map((finding) => finding.code)).toEqual(
        ["holdout_manifest_requires_hmac"],
      );
      expect(summary.claimGate.manifest.hashAlgorithm).toBe("sha256");
      await expect(readFile(manifestOut, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks duplicate scored case content in HMAC claim gates without leaking raw case data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    const envName = "FF_DUPLICATE_CLAIM_GATE_HMAC_KEY_TEST";
    const key = "lRLbLCRCGUtnZ2TyN5sJ5gEkJ58dAyMVBKwQiYMbTwg=";
    const secret = "PRIVATE-DUPLICATE-CLAIM-GATE";
    const difficulties = ["easy", "medium", "hard"] as const;
    await writeFile(
      file,
      Array.from({ length: 120 }, (_, index) => {
        const isDuplicatePair = index === 0 || index === 30;
        return JSON.stringify({
          id: isDuplicatePair
            ? `private-duplicate-id-${index}`
            : `case-${index + 1}`,
          category: `private-duplicate-category-${Math.floor(index / 30) + 1}`,
          difficulty:
            index === 0
              ? "easy"
              : index === 30
                ? "hard"
                : difficulties[index % 3],
          task: isDuplicatePair
            ? `Return ${secret}`
            : `Return unique cli ${index}`,
          grader: { exact: isDuplicatePair ? secret : `unique cli ${index}` },
        });
      }).join("\n") + "\n",
    );

    try {
      const env: NodeJS.ProcessEnv = { ...process.env, [envName]: key };
      delete env.OPENROUTER_API_KEY;
      let failure: { code?: number; stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--manifest-out",
            manifestOut,
            "--intended-use",
            "holdout",
            "--manifest-hmac-key-env",
            envName,
            "--claim-gate",
            "public_cost_performance",
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error(
          "Expected duplicate scored content claim gate to block",
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      const summary = JSON.parse(failure.stdout ?? "") as {
        claimGate: {
          status: string;
          blockers: Array<{ code: string; evidence?: Record<string, number> }>;
        };
      };

      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toBe("");
      expect(summary.claimGate.status).toBe("case_set_blocked");
      expect(summary.claimGate.blockers).toEqual([
        expect.objectContaining({
          code: "duplicate_scored_case_content",
          evidence: {
            duplicateScoredCaseContentGroupCount: 1,
            duplicateScoredCaseContentCaseCount: 2,
          },
        }),
      ]);
      for (const forbidden of [
        secret,
        "private-duplicate-id",
        "private-duplicate-category",
        file,
        manifestOut,
        key,
        envName,
      ]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
      expect(failure.stdout ?? "").not.toMatch(/[a-f0-9]{64}/);
      await expect(readFile(manifestOut, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks near-duplicate scored case prompts in HMAC claim gates without leaking raw case data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    const envName = "FF_NEAR_DUPLICATE_CLAIM_GATE_HMAC_KEY_TEST";
    const key = "lRLbLCRCGUtnZ2TyN5sJ5gEkJ58dAyMVBKwQiYMbTwg=";
    const secret = "PRIVATE-NEAR-DUPLICATE-CLAIM-GATE";
    const sharedPrompt =
      "Analyze quarterly operating margin bridge for private rollout cohort across retention expansion support cost invoice timing regional variance renewal risk onboarding backlog forecast";
    const difficulties = ["easy", "medium", "hard"] as const;
    await writeFile(
      file,
      Array.from({ length: 120 }, (_, index) => {
        const isNearDuplicatePair = index === 0 || index === 30;
        return JSON.stringify({
          id: isNearDuplicatePair
            ? `private-near-duplicate-id-${index}`
            : `case-${index + 1}`,
          category: `private-near-duplicate-category-${Math.floor(index / 30) + 1}`,
          difficulty: difficulties[index % 3],
          task: isNearDuplicatePair
            ? `${sharedPrompt} ${index === 0 ? "alpha" : "beta"} signal ${secret}`
            : `Return unique near cli ${index}`,
          constraints: isNearDuplicatePair
            ? ["Use the same private planning frame and concise final format"]
            : [],
          grader: {
            exact: isNearDuplicatePair
              ? `${secret}-${index}`
              : `unique near cli ${index}`,
          },
        });
      }).join("\n") + "\n",
    );

    try {
      const env: NodeJS.ProcessEnv = { ...process.env, [envName]: key };
      delete env.OPENROUTER_API_KEY;
      let failure: { code?: number; stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--manifest-out",
            manifestOut,
            "--intended-use",
            "holdout",
            "--manifest-hmac-key-env",
            envName,
            "--claim-gate",
            "public_cost_performance",
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error(
          "Expected near-duplicate scored content claim gate to block",
        );
      } catch (error) {
        failure = error as typeof failure;
      }
      const summary = JSON.parse(failure.stdout ?? "") as {
        claimGate: {
          status: string;
          blockers: Array<{ code: string; evidence?: Record<string, number> }>;
        };
      };

      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toBe("");
      expect(summary.claimGate.status).toBe("case_set_blocked");
      expect(summary.claimGate.blockers).toEqual([
        expect.objectContaining({
          code: "near_duplicate_scored_case_content",
          evidence: {
            nearDuplicateScoredCaseContentPairCount: 1,
            nearDuplicateScoredCaseContentCaseCount: 2,
            nearDuplicateScoredCaseContentThreshold: 0.9,
            nearDuplicateScoredCaseContentMinUsefulTokenCount: 12,
          },
        }),
      ]);
      for (const forbidden of [
        secret,
        "private-near-duplicate-id",
        "private-near-duplicate-category",
        "quarterly operating margin",
        file,
        manifestOut,
        key,
        envName,
      ]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
      expect(failure.stdout ?? "").not.toMatch(/[a-f0-9]{64}/);
      await expect(readFile(manifestOut, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs HMAC claim gates without leaking keys, env names, paths, or labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    const envName = "FF_CLAIM_GATE_HMAC_KEY_TEST";
    const key = "lRLbLCRCGUtnZ2TyN5sJ5gEkJ58dAyMVBKwQiYMbTwg=";
    await writeFile(
      file,
      claimGateCaseSetJsonl({
        categoryCount: 4,
        casesPerCategory: 30,
        categoryPrefix: "secret-category",
      }),
    );

    try {
      const env: NodeJS.ProcessEnv = { ...process.env, [envName]: key };
      delete env.OPENROUTER_API_KEY;
      const { stdout, stderr } = await execFileAsync(
        "node_modules/.bin/tsx",
        [
          "src/cli.ts",
          "validate-cases",
          file,
          "--manifest-out",
          manifestOut,
          "--intended-use",
          "holdout",
          "--manifest-hmac-key-env",
          envName,
          "--claim-gate",
          "public_cost_performance",
        ],
        { cwd: process.cwd(), env },
      );
      const summary = JSON.parse(stdout) as {
        claimGate: {
          status: string;
          manifest: { hashAlgorithm: string };
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
          warnings: Array<{ code: string }>;
          externalEvidenceRequired: Array<{ code: string }>;
        };
      };
      const manifestText = await readFile(manifestOut, "utf8");
      const manifest = JSON.parse(manifestText);

      expect(summary.claimGate.status).toBe("case_set_constraints_met");
      expect(summary.claimGate.manifest.hashAlgorithm).toBe("hmac-sha256");
      expect(summary.claimGate.categoryGraderEvidence).toEqual({
        claimEligibleCategoryCount: 4,
        minNonSurfaceGraderEvidenceCasesPerCategory: 30,
        underpoweredClaimEligibleCategoryCount: 0,
      });
      expect(summary.claimGate.categoryDifficultyCoverage).toEqual({
        claimEligibleCategoryCount: 4,
        minScoredCasesPerCategoryDifficulty: 10,
        underpoweredCategoryDifficultyCellCount: 0,
      });
      expect(summary.claimGate.warnings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["private_auditor_verifiable_only"]),
      );
      expect(
        summary.claimGate.externalEvidenceRequired.map((item) => item.code),
      ).toEqual(expect.arrayContaining(["hmac_auditor_key_custody"]));
      expect(manifest.fingerprint).toMatchObject({
        algorithm: "hmac-sha256",
        canonicalHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(manifest.fingerprint).not.toHaveProperty("canonicalSha256");

      for (const forbidden of [
        key,
        envName,
        "secret-category",
        "case-1-1",
        file,
        manifestOut,
      ]) {
        expect(stdout).not.toContain(forbidden);
        expect(stderr).not.toContain(forbidden);
        expect(manifestText).not.toContain(forbidden);
      }
      expect(stdout).not.toContain(
        "scoredCategoryNonSurfaceGraderEvidenceCounts",
      );
      expect(manifestText).not.toContain(
        "scoredCategoryNonSurfaceGraderEvidenceCounts",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes HMAC manifests without leaking keys, env names, paths, or labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    const secret = "sk-or-v1-hmac-private";
    const envName = "FF_MANIFEST_HMAC_KEY_TEST";
    const key = "lRLbLCRCGUtnZ2TyN5sJ5gEkJ58dAyMVBKwQiYMbTwg=";
    await writeFile(
      file,
      `${JSON.stringify({
        id: "secret-id",
        category: "secret-category",
        task: `Return ${secret}`,
        grader: { mustInclude: [secret] },
      })}\n`,
    );

    try {
      const env: NodeJS.ProcessEnv = { ...process.env, [envName]: key };
      delete env.OPENROUTER_API_KEY;
      const { stdout, stderr } = await execFileAsync(
        "node_modules/.bin/tsx",
        [
          "src/cli.ts",
          "validate-cases",
          file,
          "--manifest-out",
          manifestOut,
          "--manifest-hmac-key-env",
          envName,
        ],
        { cwd: process.cwd(), env },
      );
      const manifestText = await readFile(manifestOut, "utf8");
      const manifest = JSON.parse(manifestText);

      expect(manifest).toMatchObject({
        fingerprint: {
          algorithm: "hmac-sha256",
          canonicalHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        privacy: {
          includesCaseIds: false,
          includesCategoryLabels: false,
          rowHashesAreUnsalted: false,
          rowHashesAreKeyed: true,
          hashPrivacy: "private_audit_hmac_sha256",
        },
      });
      expect(manifest.fingerprint).not.toHaveProperty("canonicalSha256");
      expect(manifest.source).not.toHaveProperty("rawFileSha256");
      expect(manifest.rows[0]).not.toHaveProperty("canonicalRowSha256");
      expect(manifest.rows[0]).not.toHaveProperty("rawLineSha256");

      for (const forbidden of [
        secret,
        key,
        envName,
        "secret-category",
        "secret-id",
        file,
        manifestOut,
      ]) {
        expect(stdout).not.toContain(forbidden);
        expect(stderr).not.toContain(forbidden);
        expect(manifestText).not.toContain(forbidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe HMAC manifest disclosure flags and weak CLI keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestOut = join(dir, "manifest.json");
    const envName = "FF_MANIFEST_HMAC_WEAK_TEST";
    await writeFile(
      file,
      '{"id":"case","category":"secret","task":"Task","grader":{"exact":"ok"}}\n',
    );

    try {
      await expect(
        execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--manifest-out",
            manifestOut,
            "--manifest-hmac-key-env",
            envName,
          ],
          { cwd: process.cwd(), env: { ...process.env, [envName]: "short" } },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("at least 32 bytes"),
      });
      for (const forbiddenFlag of [
        "--public-category-labels",
        "--public-case-ids",
        "--private",
      ]) {
        await expect(
          execFileAsync(
            "node_modules/.bin/tsx",
            [
              "src/cli.ts",
              "validate-cases",
              file,
              "--manifest-out",
              manifestOut,
              "--manifest-hmac-key-env",
              envName,
              forbiddenFlag,
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                [envName]: "WRt1U0DcnP9smYHF0mQ4sH1T7iDmt+kyklYp3YTdypY=",
              },
            },
          ),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("HMAC manifests do not allow"),
        });
      }
      await expect(
        execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "validate-cases",
            file,
            "--manifest-out",
            manifestOut,
            "--manifest-hmac-key-env",
            envName,
            "--source-label",
            "private.jsonl",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              [envName]: "WRt1U0DcnP9smYHF0mQ4sH1T7iDmt+kyklYp3YTdypY=",
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("HMAC manifests do not allow"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects eval case-manifest mismatches before requiring an API key without leaking private data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestFile = join(dir, "manifest.json");
    const secret = "PRIVATE-MANIFEST-BINDING";
    const cases = [
      {
        id: `case-${secret}`,
        category: `category-${secret}`,
        task: `Mention ${secret}`,
        grader: { mustInclude: [secret] },
      },
    ];
    const changedCases = [
      {
        ...cases[0]!,
        grader: { mustInclude: ["different"] },
      },
    ];
    const manifest = buildCaseSetManifest(changedCases, {
      intendedUse: "public_sample",
    });
    await writeFile(
      file,
      `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    try {
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      let failure: { stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "eval",
            file,
            "--case-manifest",
            manifestFile,
            "--config",
            "examples/frugal-fusion.config.json",
            "--models",
            "missing-models.json",
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error("Expected manifest mismatch to fail");
      } catch (error) {
        failure = error as typeof failure;
      }

      expect(failure.stderr ?? "").toContain(
        "Case manifest binding failed: digest_mismatch",
      );
      expect(failure.stderr ?? "").not.toContain("OPENROUTER_API_KEY");
      for (const forbidden of [
        secret,
        file,
        manifestFile,
        manifest.fingerprint.canonicalSha256,
        "category-PRIVATE",
      ]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects blocked public case-set claim gates before requiring an API key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestFile = join(dir, "manifest.json");
    const publicOut = join(dir, "public.json");
    const envName = "FRUGAL_FUSION_PUBLIC_GATE_HMAC_KEY";
    const key = "public-gate-preflight-hmac-key-32-bytes";
    const secret = "PRIVATE-PREFLIGHT-CLAIM-GATE";
    const cases: EvalCase[] = [
      {
        id: `case-${secret}`,
        category: `category-${secret}`,
        task: `Mention ${secret}`,
        grader: { mustInclude: [secret] },
      },
    ];
    const manifest = buildCaseSetManifest(cases, {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });
    await writeFile(
      file,
      `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    try {
      const env: NodeJS.ProcessEnv = { ...process.env, [envName]: key };
      delete env.OPENROUTER_API_KEY;
      let failure: { stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "eval",
            file,
            "--case-manifest",
            manifestFile,
            "--case-manifest-hmac-key-env",
            envName,
            "--public-out",
            publicOut,
            "--config",
            "examples/frugal-fusion.config.json",
            "--models",
            "missing-models.json",
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error("Expected public claim-gate preflight to fail");
      } catch (error) {
        failure = error as typeof failure;
      }

      expect(failure.stderr ?? "").toContain(
        "Case-set claim gate failed before model spend",
      );
      expect(failure.stderr ?? "").not.toContain("OPENROUTER_API_KEY");
      expect(failure.stderr ?? "").not.toContain("missing-models.json");
      for (const forbidden of [secret, file, manifestFile]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
      await expect(readFile(publicOut, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unpinned manifest-bound public evals before requiring an API key or model snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const originalCwd = process.cwd();
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const envName = "FRUGAL_FUSION_STATIC_PUBLIC_GATE_HMAC_KEY";
    const originalHmacKey = process.env[envName];
    const key = "static-public-gate-hmac-key-32-ok";
    const secret = "PRIVATE-STATIC-PUBLIC-GATE";
    let runtimeBuilt = false;

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      process.env[envName] = key;
      const casesText = claimGateCaseSetJsonl({
        categoryCount: 4,
        casesPerCategory: 30,
        categoryPrefix: `category-${secret}`,
        difficulty: "balanced",
      });
      const cases = parseJsonlCases(casesText);
      const manifest = buildCaseSetManifest(cases, {
        intendedUse: "holdout",
        hashMode: { kind: "hmac-sha256", key },
      });
      await writeFile("cases.jsonl", casesText);
      await writeFile("manifest.json", `${JSON.stringify(manifest)}\n`);

      let errorMessage = "";
      await expect(
        runCli(
          [
            "eval",
            "cases.jsonl",
            "--case-manifest",
            "manifest.json",
            "--case-manifest-hmac-key-env",
            envName,
            "--public-out",
            "public.json",
            "--models",
            "missing-models.json",
          ],
          {
            buildOrchestrator: async () => {
              runtimeBuilt = true;
              throw new Error("static public gate must not build runtime");
            },
          },
        ),
      ).rejects.toThrow(/Public-report static preflight failed/);
      try {
        await runCli(
          [
            "eval",
            "cases.jsonl",
            "--case-manifest",
            "manifest.json",
            "--case-manifest-hmac-key-env",
            envName,
            "--public-out",
            "public.json",
            "--models",
            "missing-models.json",
          ],
          {
            buildOrchestrator: async () => {
              runtimeBuilt = true;
              throw new Error("static public gate must not build runtime");
            },
          },
        );
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toBe(
        "Public-report static preflight failed before model spend: provider_endpoint_pinning_missing.",
      );
      for (const forbidden of [
        secret,
        key,
        envName,
        "cases.jsonl",
        "manifest.json",
        "missing-models.json",
        "category-PRIVATE",
      ]) {
        expect(errorMessage).not.toContain(forbidden);
      }
      let failure: { stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "eval",
            join(dir, "cases.jsonl"),
            "--case-manifest",
            join(dir, "manifest.json"),
            "--case-manifest-hmac-key-env",
            envName,
            "--public-out",
            join(dir, "public.json"),
            "--models",
            "missing-models.json",
          ],
          { cwd: originalCwd, env: { ...process.env } },
        );
        throw new Error("Expected static public gate to fail");
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure.stderr ?? "").toContain(
        "Public-report static preflight failed before model spend: provider_endpoint_pinning_missing.",
      );
      expect(failure.stdout ?? "").toBe("");
      for (const forbidden of [
        secret,
        key,
        envName,
        join(dir, "cases.jsonl"),
        join(dir, "manifest.json"),
        "missing-models.json",
        "category-PRIVATE",
      ]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }

      expect(runtimeBuilt).toBe(false);
      await expect(readFile("public.json", "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(originalCwd);
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      if (originalHmacKey === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalHmacKey;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects underpowered public bootstrap settings before requiring an API key or model snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const originalCwd = process.cwd();
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const envName = "FRUGAL_FUSION_STATIC_BOOTSTRAP_HMAC_KEY";
    const originalHmacKey = process.env[envName];
    const key = "static-bootstrap-gate-hmac-key-32-ok";
    const secret = "PRIVATE-STATIC-BOOTSTRAP-GATE";
    let runtimeBuilt = false;

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      process.env[envName] = key;
      const casesText = claimGateCaseSetJsonl({
        categoryCount: 4,
        casesPerCategory: 30,
        categoryPrefix: `category-${secret}`,
        difficulty: "balanced",
      });
      const cases = parseJsonlCases(casesText);
      const manifest = buildCaseSetManifest(cases, {
        intendedUse: "holdout",
        hashMode: { kind: "hmac-sha256", key },
      });
      await writeFile("cases.jsonl", casesText);
      await writeFile("manifest.json", `${JSON.stringify(manifest)}\n`);
      await writeFile(
        "config.json",
        `${JSON.stringify({
          ...DEFAULT_CONFIG,
          configId: "static-bootstrap-gate-test",
          models,
          provider: {
            ...DEFAULT_CONFIG.provider,
            allow_fallbacks: false,
            order: ["provider-secret/endpoint-secret"],
          },
        })}\n`,
      );

      let errorMessage = "";
      await expect(
        runCli(
          [
            "eval",
            "cases.jsonl",
            "--case-manifest",
            "manifest.json",
            "--case-manifest-hmac-key-env",
            envName,
            "--public-out",
            "public.json",
            "--config",
            "config.json",
            "--models",
            "missing-models.json",
            "--bootstrap-samples",
            "499",
          ],
          {
            buildOrchestrator: async () => {
              runtimeBuilt = true;
              throw new Error("static public gate must not build runtime");
            },
          },
        ),
      ).rejects.toThrow(/Public-report static preflight failed/);
      try {
        await runCli(
          [
            "eval",
            "cases.jsonl",
            "--case-manifest",
            "manifest.json",
            "--case-manifest-hmac-key-env",
            envName,
            "--public-out",
            "public.json",
            "--config",
            "config.json",
            "--models",
            "missing-models.json",
            "--bootstrap-samples",
            "499",
          ],
          {
            buildOrchestrator: async () => {
              runtimeBuilt = true;
              throw new Error("static public gate must not build runtime");
            },
          },
        );
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toBe(
        "Public-report static preflight failed before model spend: confidence_interval_resamples_underpowered.",
      );
      for (const forbidden of [
        key,
        secret,
        envName,
        "cases.jsonl",
        "manifest.json",
        "config.json",
        "missing-models.json",
        "provider-secret/endpoint-secret",
      ]) {
        expect(errorMessage).not.toContain(forbidden);
      }

      expect(runtimeBuilt).toBe(false);
      await expect(readFile("public.json", "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(originalCwd);
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      if (originalHmacKey === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalHmacKey;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps package bin metadata aligned with the TypeScript build output", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin?: Record<string, string>;
    };
    const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8")) as {
      compilerOptions?: { outDir?: string };
    };

    expect(packageJson.bin?.["frugal-fusion"]).toBe(
      `./${tsconfig.compilerOptions?.outDir ?? "dist"}/src/cli.js`,
    );
  });

  it("runs the CLI entrypoint through a symlinked source path", async () => {
    const link = join(
      process.cwd(),
      "src",
      `.cli-entrypoint-${process.pid}-${Date.now()}.ts`,
    );
    await symlink("cli.ts", link);

    try {
      await expect(
        execFileAsync("node_modules/.bin/tsx", [link], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Usage:"),
      });
    } finally {
      await rm(link, { force: true });
    }
  });

  it("throws usage from the in-process CLI runner instead of exiting", async () => {
    await expect(runCli([])).rejects.toThrow(/Usage:/);
  });

  it("prints CLI help without API keys, model calls, or filesystem side effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-help-"));
    const originalCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const logs: string[] = [];
    const errors: string[] = [];
    let runtimeBuilt = false;

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      console.log = (value?: unknown) => {
        logs.push(String(value ?? ""));
      };
      console.error = (value?: unknown) => {
        errors.push(String(value ?? ""));
      };

      for (const args of [
        ["--help"],
        ["-h"],
        ["models", "--help"],
        ["ask", "--help"],
        ["validate-cases", "--help"],
        ["validate-cases", "-h"],
        ["verify-public-report", "--help"],
        ["verify-public-report", "-h"],
        ["eval", "--help"],
        ["eval", "-h"],
      ]) {
        logs.length = 0;
        errors.length = 0;

        await expect(
          runCli(args, {
            buildOrchestrator: async () => {
              runtimeBuilt = true;
              throw new Error("help must not build runtime");
            },
          }),
        ).resolves.toBe(0);

        expect(logs.join("\n")).toContain("Usage:");
        expect(errors).toHaveLength(0);
      }

      expect(runtimeBuilt).toBe(false);
      await expect(
        readFile(join(dir, ".frugal-fusion", "models.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(originalCwd);
      console.log = originalLog;
      console.error = originalError;
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints CLI help from the executable entrypoint with exit code 0", async () => {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;

    for (const args of [
      ["src/cli.ts", "--help"],
      ["src/cli.ts", "validate-cases", "--help"],
      ["src/cli.ts", "verify-public-report", "--help"],
      ["src/cli.ts", "eval", "--help"],
    ]) {
      const { stdout, stderr } = await execFileAsync(
        "node_modules/.bin/tsx",
        args,
        { cwd: process.cwd(), env },
      );

      expect(stdout).toContain("Usage:");
      expect(stderr).toBe("");
    }
  });

  it("verifies malformed public reports without API keys, runtime construction, or raw marker leakage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-verify-public-"));
    const originalCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const logs: string[] = [];
    const errors: string[] = [];
    const rawMarker = "PRIVATE-VERIFY-REPORT-MARKER";
    let runtimeBuilt = false;

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      console.log = (value?: unknown) => {
        logs.push(String(value ?? ""));
      };
      console.error = (value?: unknown) => {
        errors.push(String(value ?? ""));
      };
      const dependencies = {
        buildOrchestrator: async () => {
          runtimeBuilt = true;
          throw new Error("verify-public-report must not build runtime");
        },
      };

      await writeFile("invalid.json", `{ "private": "${rawMarker}" `);
      await expect(
        runCli(["verify-public-report", "invalid.json"], dependencies),
      ).resolves.toBe(2);
      const invalidOutput = JSON.parse(logs.join("\n")) as {
        status: string;
        claimGate: unknown;
        blockers: Array<{ code: string }>;
      };
      expect(invalidOutput.status).toBe("public_report_blocked");
      expect(invalidOutput.claimGate).toBeNull();
      expect(invalidOutput.blockers.map((item) => item.code)).toEqual([
        "public_report_json_parse_failed",
      ]);
      expect(logs.join("\n")).not.toContain(rawMarker);
      expect(errors).toHaveLength(0);

      logs.length = 0;
      await expect(
        runCli(["verify-public-report", "missing.json"], dependencies),
      ).resolves.toBe(2);
      const readFailureOutput = JSON.parse(logs.join("\n")) as {
        status: string;
        claimGate: unknown;
        blockers: Array<{ code: string }>;
      };
      expect(readFailureOutput.status).toBe("public_report_blocked");
      expect(readFailureOutput.claimGate).toBeNull();
      expect(readFailureOutput.blockers.map((item) => item.code)).toEqual([
        "public_report_json_read_failed",
      ]);
      expect(errors).toHaveLength(0);

      logs.length = 0;
      await writeFile(
        "malformed.json",
        `${JSON.stringify({ privateReportDigest: rawMarker })}\n`,
      );
      await expect(
        runCli(["verify-public-report", "malformed.json"], dependencies),
      ).resolves.toBe(2);
      const malformedOutput = JSON.parse(logs.join("\n")) as {
        status: string;
        artifact: { rootObject: boolean; rootShapeStrict: boolean };
        blockers: Array<{ code: string }>;
      };
      expect(malformedOutput.status).toBe("public_report_blocked");
      expect(malformedOutput.artifact).toMatchObject({
        rootObject: true,
        rootShapeStrict: false,
      });
      expect(malformedOutput.blockers.map((item) => item.code)).toEqual(
        expect.arrayContaining([
          "public_report_root_shape_malformed",
          "public_report_claim_gate_input_unavailable",
          "public_report_claim_gate_missing",
        ]),
      );
      expect(logs.join("\n")).not.toContain(rawMarker);
      expect(errors).toHaveLength(0);
      expect(runtimeBuilt).toBe(false);
    } finally {
      process.chdir(originalCwd);
      console.log = originalLog;
      console.error = originalError;
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits aggregate eval preflight without API key, model calls, or private labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-preflight-"));
    const originalCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const logs: string[] = [];
    const errors: string[] = [];
    let runtimeBuilt = false;
    const secret = "PRIVATE-PREFLIGHT";
    const config = {
      ...DEFAULT_CONFIG,
      configId: "preflight-test",
      models,
      budget,
    };
    const modelSnapshot = modelIdsForRunProvenance(config.models, [
      "direct",
      "self_review",
      "repeated",
      "fusion",
    ]).map(snapshot);

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      console.log = (value?: unknown) => {
        logs.push(String(value));
      };
      console.error = (value?: unknown) => {
        errors.push(String(value));
      };
      await writeFile(
        "cases.jsonl",
        [
          JSON.stringify({
            id: `case-${secret}`,
            category: `category-${secret}`,
            task: `Mention schema without leaking ${secret}`,
            grader: { mustInclude: ["schema"] },
          }),
          JSON.stringify({
            id: `smoke-${secret}`,
            category: `category-${secret}`,
            task: `Smoke ${secret}`,
            smokeOnly: true,
          }),
        ].join("\n") + "\n",
      );
      await writeFile("config.json", `${JSON.stringify(config)}\n`);
      await writeFile("models.json", `${JSON.stringify(modelSnapshot)}\n`);

      await runCli(
        [
          "eval",
          "cases.jsonl",
          "--preflight",
          "--models",
          "models.json",
          "--config",
          "config.json",
          "--trials",
          "3",
          "--preflight-out",
          "preflight.json",
        ],
        {
          buildOrchestrator: async () => {
            runtimeBuilt = true;
            throw new Error("preflight must not build runtime");
          },
        },
      );

      const stdout = logs.join("\n");
      const stderr = errors.join("\n");
      const fileText = await readFile("preflight.json", "utf8");
      const plan = JSON.parse(stdout) as {
        schemaVersion: string;
        scope: string;
        privacy: { omitted: string[] };
        evaluationDesign: {
          caseCount: number;
          scoredCaseCount: number;
          smokeOnlyCaseCount: number;
          trialsPerCase: number;
          caseTrialCount: number;
          configCaseTrialCount: number;
        };
        plannedCallAttempts: {
          maximumIfPrerequisitesSucceed: number;
          byConfig: Record<string, number>;
          byStage: Record<string, number>;
        };
        completionTokenCeiling: { totalMaxTokens: number };
        cost: {
          configuredRunBudgetCeilingUsd: number;
          completionCostUpperBoundUsd: number;
          promptEstimate: {
            scope: string;
            unestimatedPromptCosts: string;
          };
        };
        modelPriceSnapshot: {
          effectiveModelCount: number;
          modelIdentifierDisclosure: string;
        };
      };

      expect(runtimeBuilt).toBe(false);
      expect(stderr).toBe("Wrote eval preflight plan");
      expect(JSON.parse(fileText)).toEqual(plan);
      expect(plan).toMatchObject({
        schemaVersion: "frugal-fusion-eval-preflight-v1",
        scope: "local_no_spend_eval_preflight",
        evaluationDesign: {
          caseCount: 2,
          scoredCaseCount: 1,
          smokeOnlyCaseCount: 1,
          trialsPerCase: 3,
          caseTrialCount: 6,
          configCaseTrialCount: 24,
        },
        plannedCallAttempts: {
          maximumIfPrerequisitesSucceed: 54,
          byConfig: {
            direct: 6,
            self_review: 12,
            repeated: 18,
            fusion: 18,
          },
          byStage: {
            direct: 6,
            self_review_draft: 6,
            self_review_final: 6,
            repeated_sample: 12,
            candidate: 12,
            aggregator: 12,
          },
        },
        completionTokenCeiling: { totalMaxTokens: 14_400 },
        modelPriceSnapshot: {
          effectiveModelCount: 4,
          modelIdentifierDisclosure: "omitted",
        },
      });
      expect(plan.cost.configuredRunBudgetCeilingUsd).toBe(1.2);
      expect(plan.cost.completionCostUpperBoundUsd).toBeGreaterThan(0);
      expect(plan.cost.promptEstimate).toMatchObject({
        scope: "known_initial_request_prompts_only",
        unestimatedPromptCosts:
          "self_review_final_and_aggregator_prompts_depend_on_generated_outputs",
      });
      expect(plan.privacy.omitted).toEqual(
        expect.arrayContaining([
          "case_ids",
          "category_labels",
          "task_text",
          "manifest_digests",
          "model_ids",
          "price_rows",
        ]),
      );
      for (const forbidden of [
        secret,
        `case-${secret}`,
        `category-${secret}`,
        "direct/model",
        "candidate/a",
        "candidate/b",
        "aggregator/model",
        "preflight.json",
      ]) {
        expect(stdout).not.toContain(forbidden);
        expect(fileText).not.toContain(forbidden);
        expect(stderr).not.toContain(forbidden);
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails eval preflight guards before spend with aggregate-only errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-preflight-"));
    const originalCwd = process.cwd();
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const secret = "PRIVATE-PREFLIGHT-GUARD";
    const config = {
      ...DEFAULT_CONFIG,
      configId: "preflight-guard-test",
      models,
      budget,
    };
    const modelSnapshot = modelIdsForRunProvenance(config.models, [
      "direct",
      "self_review",
      "repeated",
      "fusion",
    ]).map(snapshot);

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      await writeFile(
        "cases.jsonl",
        `${JSON.stringify({
          id: `case-${secret}`,
          category: `category-${secret}`,
          task: `Mention schema without leaking ${secret}`,
          grader: { mustInclude: ["schema"] },
        })}\n`,
      );
      await writeFile("config.json", `${JSON.stringify(config)}\n`);
      await writeFile("models.json", `${JSON.stringify(modelSnapshot)}\n`);

      let guardError: unknown;
      try {
        await runCli([
          "eval",
          "cases.jsonl",
          "--preflight",
          "--models",
          "models.json",
          "--config",
          "config.json",
          "--max-planned-call-attempts",
          "8",
        ]);
      } catch (error) {
        guardError = error;
      }
      expect(guardError).toBeInstanceOf(Error);
      const message =
        guardError instanceof Error ? guardError.message : String(guardError);
      expect(message).toMatch(/planned call attempts 9 > 8/);
      expect(message).not.toContain(secret);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects eval preflight output paths that alias input files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-preflight-"));
    const originalCwd = process.cwd();
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const caseText = `${JSON.stringify({
      id: "case",
      task: "Mention schema",
      grader: { mustInclude: ["schema"] },
    })}\n`;
    const config = {
      ...DEFAULT_CONFIG,
      configId: "preflight-output-alias-test",
      models,
      budget,
    };
    const modelSnapshot = modelIdsForRunProvenance(config.models, [
      "direct",
      "self_review",
      "repeated",
      "fusion",
    ]).map(snapshot);

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      await writeFile("cases.jsonl", caseText);
      await writeFile("config.json", `${JSON.stringify(config)}\n`);
      await writeFile("models.json", `${JSON.stringify(modelSnapshot)}\n`);

      await expect(
        runCli([
          "eval",
          "cases.jsonl",
          "--preflight",
          "--models",
          "models.json",
          "--config",
          "config.json",
          "--preflight-out",
          "cases.jsonl",
        ]),
      ).rejects.toThrow(/must not refer to an input/);
      expect(await readFile("cases.jsonl", "utf8")).toBe(caseText);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes eval preflight validation and model-snapshot failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-preflight-"));
    const originalCwd = process.cwd();
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const secretCaseId = "PRIVATE-CASE-ID-123";
    const secretModelId = "private/aggregator-model";
    const config = {
      ...DEFAULT_CONFIG,
      configId: "preflight-sanitize-test",
      models: {
        ...models,
        aggregatorModelId: secretModelId,
      },
      budget,
    };

    try {
      process.chdir(dir);
      delete process.env.OPENROUTER_API_KEY;
      await writeFile(
        "bad-cases.jsonl",
        `${JSON.stringify({
          id: secretCaseId,
          task: "This scored case is missing a deterministic grader.",
        })}\n`,
      );
      await writeFile(
        "cases.jsonl",
        `${JSON.stringify({
          id: "case",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        })}\n`,
      );
      await writeFile("config.json", `${JSON.stringify(config)}\n`);
      await writeFile(
        "models.json",
        `${JSON.stringify([
          snapshot(models.directModelId),
          snapshot(models.candidateModels[0]),
          snapshot(models.candidateModels[1]),
        ])}\n`,
      );

      let manifestError: unknown;
      try {
        await runCli([
          "eval",
          "cases.jsonl",
          "--preflight",
          "--case-manifest",
          "PRIVATE-manifest.json",
        ]);
      } catch (error) {
        manifestError = error;
      }
      expect(manifestError).toBeInstanceOf(Error);
      const manifestMessage =
        manifestError instanceof Error
          ? manifestError.message
          : String(manifestError);
      expect(manifestMessage).toBe(
        "Case manifest could not be loaded or verified",
      );
      expect(manifestMessage).not.toContain("PRIVATE-manifest.json");

      let validationError: unknown;
      try {
        await runCli([
          "eval",
          "bad-cases.jsonl",
          "--preflight",
          "--models",
          "models.json",
          "--config",
          "config.json",
        ]);
      } catch (error) {
        validationError = error;
      }
      expect(validationError).toBeInstanceOf(Error);
      const validationMessage =
        validationError instanceof Error
          ? validationError.message
          : String(validationError);
      expect(validationMessage).toBe(
        "Evaluation case file parsing or validation failed",
      );
      expect(validationMessage).not.toContain(secretCaseId);

      let modelError: unknown;
      try {
        await runCli([
          "eval",
          "cases.jsonl",
          "--preflight",
          "--models",
          "models.json",
          "--config",
          "config.json",
        ]);
      } catch (error) {
        modelError = error;
      }
      expect(modelError).toBeInstanceOf(Error);
      const message =
        modelError instanceof Error ? modelError.message : String(modelError);
      expect(message).toBe(
        "Preflight model snapshot, budget, or planning inputs are invalid",
      );
      for (const forbidden of [
        secretCaseId,
        secretModelId,
        "bad-cases.jsonl",
      ]) {
        expect(message).not.toContain(forbidden);
      }
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes private and public manifest-bound reports through the CLI success path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const originalCwd = process.cwd();
    const originalLog = console.log;
    const envName = "FRUGAL_FUSION_CLI_SUCCESS_HMAC_KEY";
    const originalHmacKey = process.env[envName];
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    const key = "cli-success-hmac-key-32-bytes-ok";
    const secret = "PRIVATE-CLI-SUCCESS";
    let verifyRuntimeBuilt = false;
    const difficulties = ["easy", "medium", "hard"] as const;
    const cases: EvalCase[] = Array.from({ length: 120 }, (_, index) => ({
      id: `case-${secret}-${index}`,
      category: `category-${secret}-${Math.floor(index / 30) + 1}`,
      difficulty: difficulties[index % difficulties.length]!,
      task: `Mention schema for CLI success case ${index} without leaking ${secret}`,
      grader: { exact: "schema" },
    }));
    const manifest = buildCaseSetManifest(cases, {
      intendedUse: "holdout",
      hashMode: { kind: "hmac-sha256", key },
    });

    try {
      process.chdir(dir);
      console.log = () => undefined;
      process.env[envName] = key;
      delete process.env.OPENROUTER_API_KEY;
      await writeFile(
        "cases.jsonl",
        `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
      await writeFile("manifest.json", `${JSON.stringify(manifest)}\n`);

      const config = {
        ...DEFAULT_CONFIG,
        configId: "cli-success-test",
        models,
        budget,
        provider: {
          ...DEFAULT_CONFIG.provider,
          allow_fallbacks: false,
          order: ["provider-secret/endpoint-secret"],
        },
      };
      const registry = new ModelRegistry(
        modelIdsForRunProvenance(config.models, [
          "direct",
          "self_review",
          "repeated",
          "fusion",
        ]).map(snapshot),
      );
      await writeFile("config.json", `${JSON.stringify(config)}\n`);
      await runCli(
        [
          "eval",
          "cases.jsonl",
          "--case-manifest",
          "manifest.json",
          "--case-manifest-hmac-key-env",
          envName,
          "--public-out",
          "public.json",
          "--config",
          "config.json",
        ],
        {
          buildOrchestrator: async () => ({
            config,
            registry,
            configSourceKind: "default_config",
            orchestrator: new FrugalFusionOrchestrator({
              client: new CliAutoPassClient(),
              models: config.models,
              sampling: config.sampling,
              configId: config.configId,
              promptVersion: config.promptVersion,
              priceSnapshot: (modelIds) => modelIds.map(snapshot),
            }),
          }),
        },
      );
      await expect(
        runCli(["verify-public-report", "public.json"], {
          buildOrchestrator: async () => {
            verifyRuntimeBuilt = true;
            throw new Error("verify-public-report must not build runtime");
          },
        }),
      ).resolves.toBe(0);

      const privateReportText = await readFile(
        join(dir, ".frugal-fusion", "eval-result.json"),
        "utf8",
      );
      const publicReportText = await readFile(join(dir, "public.json"), "utf8");
      const privateReport = JSON.parse(privateReportText) as {
        caseSetHash: string | null;
        caseSetManifestBinding?: {
          hashAlgorithm: string;
          privacyClass: string;
          digestHmacSha256?: string;
        };
        caseSetClaimGate?: { status: string };
        runProvenance?: unknown;
      };
      const publicReport = JSON.parse(publicReportText) as {
        schemaVersion: string;
        claimGate: {
          status: string;
          overallClaimStatus: string;
          blockers: unknown[];
          externalEvidenceRequired: Array<{ code: string }>;
        };
        disclosure: {
          reproducibilityLevel: string;
          caseSetClaimGate: { status: string };
          caseSetManifestBinding: { status: string; digestDisclosure: string };
          runProvenance: {
            status: string;
            providerRouting?: {
              status: string;
              providerEndpointPinning: string;
              detailDisclosure: string;
            };
          };
        };
      };

      expect(privateReport.caseSetHash).toBeNull();
      expect(privateReport.caseSetManifestBinding).toMatchObject({
        hashAlgorithm: "hmac-sha256",
        privacyClass: "private_audit_hmac_sha256",
      });
      expect(privateReport.caseSetClaimGate).toMatchObject({
        status: "case_set_constraints_met",
      });
      expect(privateReport.runProvenance).toBeDefined();
      expect(verifyRuntimeBuilt).toBe(false);
      expect(publicReport).toMatchObject({
        schemaVersion: "frugal-fusion-public-eval-v11",
        claimGate: {
          status: "public_report_constraints_met",
          overallClaimStatus: "external_evidence_required",
          blockers: [],
        },
        disclosure: {
          reproducibilityLevel: "private-audit-only",
          caseSetClaimGate: { status: "private_report_constraints_met" },
          caseSetManifestBinding: {
            status: "private_report_bound",
            digestDisclosure: "omitted",
          },
          runProvenance: {
            status: "private_report_fields_present",
            providerRouting: {
              status: "private_report_fields_present",
              providerEndpointPinning: "single_provider_endpoint_pinned",
              detailDisclosure: "omitted",
            },
          },
        },
      });
      expect(
        publicReport.claimGate.externalEvidenceRequired.map(
          (item) => item.code,
        ),
      ).toEqual(
        expect.arrayContaining([
          "frozen_manifest_bound_to_report",
          "holdout_process_record",
          "private_reproduction_package",
        ]),
      );
      for (const forbidden of [
        secret,
        key,
        envName,
        manifest.fingerprint.canonicalHmacSha256,
        privateReport.caseSetManifestBinding?.digestHmacSha256 ?? "",
        "case-PRIVATE",
        "category-PRIVATE",
        "provider-secret/endpoint-secret",
      ]) {
        expect(publicReportText).not.toContain(forbidden);
      }
    } finally {
      console.log = originalLog;
      if (originalHmacKey === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = originalHmacKey;
      }
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes eval validation failures when public or manifest outputs are involved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frugal-fusion-"));
    const file = join(dir, "cases.jsonl");
    const manifestFile = join(dir, "manifest.json");
    const secret = "PRIVATE-EVAL-DUPLICATE";
    await writeFile(
      file,
      `${JSON.stringify({
        id: secret,
        task: "Task",
        grader: { exact: "ok" },
      })}\n${JSON.stringify({
        id: secret,
        task: "Task",
        grader: { exact: "ok" },
      })}\n`,
    );
    await writeFile(manifestFile, "{}\n");

    try {
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      let failure: { stdout?: string; stderr?: string };
      try {
        await execFileAsync(
          "node_modules/.bin/tsx",
          [
            "src/cli.ts",
            "eval",
            file,
            "--case-manifest",
            manifestFile,
            "--public-out",
            join(dir, "public.json"),
          ],
          { cwd: process.cwd(), env },
        );
        throw new Error("Expected eval validation failure");
      } catch (error) {
        failure = error as typeof failure;
      }

      expect(failure.stderr ?? "").toContain(
        "Evaluation case file parsing or validation failed",
      );
      for (const forbidden of [secret, "Duplicate eval case id", file]) {
        expect(failure.stdout ?? "").not.toContain(forbidden);
        expect(failure.stderr ?? "").not.toContain(forbidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects public output paths that would overwrite private reports before requiring an API key", async () => {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;

    await expect(
      execFileAsync(
        "node_modules/.bin/tsx",
        [
          "src/cli.ts",
          "eval",
          "missing-cases.jsonl",
          "--case-manifest",
          "missing-manifest.json",
          "--public-out",
          ".frugal-fusion/eval-result.json",
        ],
        { cwd: process.cwd(), env },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("private report path"),
    });
  });

  it("rejects invalid ask modes before requiring an API key", async () => {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;

    await expect(
      execFileAsync(
        "node_modules/.bin/tsx",
        ["src/cli.ts", "ask", "Task", "--mode", "surprise"],
        { cwd: process.cwd(), env },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--mode must be auto"),
    });
  });

  it("does not retain prompt or answer text in reports by default", async () => {
    const secretTask =
      "Private customer Acme-Internal-Launch needs schema validation";
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "ok",
          output: { answer: "Acme-Internal-Launch schema failure" },
        },
      ]),
    );

    const report = await runEvaluation(
      [
        {
          id: "secret-case",
          task: secretTask,
          smokeOnly: true,
        },
      ],
      orchestrator,
      budget,
      { configs: ["direct"] },
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Acme-Internal-Launch");
    expect(report.traces[0]?.request).not.toHaveProperty("task");
    expect(report.traces[0]?.request).not.toHaveProperty("taskRaw");
    expect(report.traces[0]?.request).toHaveProperty("taskHash");
    expect(report.cases[0]?.outcomes[0]?.result).not.toHaveProperty("answer");
  });

  it("continues after a failed config and records the failure rate", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "error", status: "invalid_output", message: "bad json" },
        { kind: "ok", output: { answer: "schema failure" } },
      ]),
    );

    const report = await runEvaluation(
      [{ id: "case-1", task: "Check schema failure", smokeOnly: true }],
      orchestrator,
      budget,
      { configs: ["direct"], trialsPerCase: 2 },
    );

    expect(report.cases[0]?.outcomes[0]?.status).toBe("failed");
    expect(report.cases[0]?.outcomes[1]?.status).toBe("completed");
    expect(report.cases[0]?.outcomes[1]?.trialIndex).toBe(1);
    expect(report.metrics.invalid_output_rate.direct).toBe(0.5);
  });

  it("does not retain raw failure messages in case outcomes by default", async () => {
    const secret = "Acme-Private sk-or-v1-secret";
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "error",
          status: "invalid_output",
          message: `failed for ${secret}`,
        },
      ]),
    );

    const report = await runEvaluation(
      [{ id: "secret-failure", task: "Smoke failure", smokeOnly: true }],
      orchestrator,
      budget,
      { configs: ["direct"] },
    );

    expect(report.cases[0]?.outcomes[0]?.failure?.message).toBe(
      "Model call failed with status: invalid_output",
    );
    expect(JSON.stringify(report)).not.toContain("Acme-Private");
    expect(JSON.stringify(report)).not.toContain("sk-or-v1-secret");
  });

  it("retains sanitized call trace for failed panel attempts", async () => {
    const report = await runEvaluation(
      [{ id: "panel-failure", task: "Smoke panel", smokeOnly: true }],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "error", status: "invalid_output", costUsd: 0.002 },
          { kind: "error", status: "invalid_output", costUsd: 0.003 },
        ]),
      ),
      budget,
      { configs: ["fusion"] },
    );

    expect(report.cases[0]?.outcomes[0]?.failure?.callTrace).toEqual([
      expect.objectContaining({ status: "invalid_output", usageIndex: 0 }),
      expect.objectContaining({ status: "invalid_output", usageIndex: 1 }),
    ]);
    expect(JSON.stringify(report)).not.toContain("rawResponseId");
  });

  it("rejects duplicate configs so repetition goes through trials", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);

    await expect(
      runEvaluation(
        [{ id: "case-1", task: "Check schema", smokeOnly: true }],
        orchestrator,
        budget,
        { configs: ["direct", "direct"] },
      ),
    ).rejects.toThrow(/Duplicate evaluation config/);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects run provenance that does not match evaluated configs before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);
    const provenance = buildEvalRunProvenance({
      config: {
        ...DEFAULT_CONFIG,
        models,
      },
      configs: ["fusion"],
      configSourceKind: "caller_provided",
      modelPriceEntries: modelIdsForRunProvenance(models, ["fusion"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "caller_provided",
    });

    await expect(
      runEvaluation(
        [{ id: "case-1", task: "Check schema", smokeOnly: true }],
        orchestrator,
        budget,
        { configs: ["direct"], runProvenance: provenance },
      ),
    ).rejects.toThrow(/runProvenance\.evaluatedConfigs/);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects malformed run provenance invocation before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);
    const provenance = buildEvalRunProvenance({
      config: {
        ...DEFAULT_CONFIG,
        models,
      },
      configs: ["direct"],
      configSourceKind: "caller_provided",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "caller_provided",
      invocation: cliEvalInvocationProvenance(),
    });
    (provenance.invocation as Record<string, unknown>).rawArgv = [
      "--case-manifest",
      "/private/holdout.jsonl",
    ];

    await expect(
      runEvaluation(
        [{ id: "case-1", task: "Check schema", smokeOnly: true }],
        orchestrator,
        budget,
        { configs: ["direct"], runProvenance: provenance },
      ),
    ).rejects.toThrow(/runProvenance\.invocation/);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects malformed run provenance fingerprints before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);
    const provenance = buildEvalRunProvenance({
      config: {
        ...DEFAULT_CONFIG,
        models,
      },
      configs: ["direct"],
      configSourceKind: "caller_provided",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "caller_provided",
    });
    provenance.config.resolvedConfigDigest.sha256 = "not-a-sha";

    await expect(
      runEvaluation(
        [{ id: "case-1", task: "Check schema", smokeOnly: true }],
        orchestrator,
        budget,
        { configs: ["direct"], runProvenance: provenance },
      ),
    ).rejects.toThrow(/runProvenance\.config\.resolvedConfigDigest/);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects malformed run provenance model counts before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);
    const provenance = buildEvalRunProvenance({
      config: {
        ...DEFAULT_CONFIG,
        models,
      },
      configs: ["direct"],
      configSourceKind: "caller_provided",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "caller_provided",
    });
    provenance.modelPriceSnapshot.effectiveModelCount = -1;

    await expect(
      runEvaluation(
        [{ id: "case-1", task: "Check schema", smokeOnly: true }],
        orchestrator,
        budget,
        { configs: ["direct"], runProvenance: provenance },
      ),
    ).rejects.toThrow(/runProvenance\.modelPriceSnapshot/);
    expect(client.calls).toHaveLength(0);
  });

  it("stores normalized run provenance instead of caller objects with inherited serializers", async () => {
    const marker =
      "--case-manifest /private/holdout.jsonl FRUGAL_FUSION_MANIFEST_HMAC_KEY PRIVATE-ARGV";
    const provenance = buildEvalRunProvenance({
      config: {
        ...DEFAULT_CONFIG,
        models,
      },
      configs: ["direct"],
      configSourceKind: "caller_provided",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "caller_provided",
      invocation: cliEvalInvocationProvenance(),
    });
    Object.setPrototypeOf(provenance.invocation!, {
      toJSON: () => ({ leaked: marker }),
    });

    const report = await runEvaluation(
      [{ id: "case-1", task: "Check schema", smokeOnly: true }],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "ok" } }]),
      ),
      budget,
      { configs: ["direct"], runProvenance: provenance },
    );

    expect(report.runProvenance?.invocation).toEqual(
      cliEvalInvocationProvenance(),
    );
    const serialized = JSON.stringify(report.runProvenance);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("--case-manifest");
    expect(serialized).not.toContain("FRUGAL_FUSION_MANIFEST_HMAC_KEY");
    expect(serialized).not.toContain("/private/");
  });

  it("validates trial count before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);

    await expect(
      runEvaluation(
        [{ id: "case-1", task: "Check schema", smokeOnly: true }],
        orchestrator,
        budget,
        { configs: ["direct"], trialsPerCase: 0 },
      ),
    ).rejects.toThrow(/trialsPerCase/);
    expect(client.calls).toHaveLength(0);
  });

  it("excludes smoke-only cases from task pass rate", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: { answer: "smoke completed" } },
        { kind: "ok", output: { answer: "missing keyword" } },
      ]),
    );

    const report = await runEvaluation(
      [
        { id: "smoke", task: "Smoke case", smokeOnly: true },
        {
          id: "graded",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        },
      ],
      orchestrator,
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    expect(report.metrics.smoke_completion_rate.direct).toBe(1);
    expect(report.metrics.confidence_intervals.task_pass_rate.direct).toEqual({
      low: 0,
      high: 0,
    });
  });

  it("marks confidence intervals unavailable when no scored cases exist", async () => {
    const report = await runEvaluation(
      [{ id: "smoke", task: "Smoke case", smokeOnly: true }],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: { answer: "smoke completed" } },
        ]),
      ),
      budget,
      { configs: ["direct"], bootstrapSamples: 10 },
    );

    expect(report.metrics.scored_n).toBe(0);
    expect(report.metrics.task_pass_rate.direct).toBeNull();
    expect(
      report.metrics.confidence_intervals.task_pass_rate.direct,
    ).toBeNull();
    expect(report.metrics.confidence_intervals.cost_per_pass.direct).toEqual({
      low: null,
      high: null,
      available: false,
      zeroPassResamples: 0,
      undefinedRate: 1,
    });
  });

  it("validates graders before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);

    await expect(
      runEvaluation(
        [{ id: "bad-regex", task: "Task", grader: { regex: ["["] } }],
        orchestrator,
        budget,
        { configs: ["direct"] },
      ),
    ).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it("rejects malformed grader fields before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);

    await expect(
      runEvaluation(
        [
          {
            id: "bad-grader",
            task: "Task",
            grader: { mustInclude: "schema" } as never,
          },
        ],
        orchestrator,
        budget,
        { configs: ["direct"] },
      ),
    ).rejects.toThrow(/mustInclude/);
    expect(client.calls).toHaveLength(0);
  });

  it("includes constraints in case-set hash and trace metadata without retaining text", async () => {
    const reportA = await runEvaluation(
      [
        {
          id: "case",
          task: "Mention schema",
          constraints: ["short"],
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );
    const reportB = await runEvaluation(
      [
        {
          id: "case",
          task: "Mention schema",
          constraints: ["long"],
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(reportA.caseSetHash).not.toBe(reportB.caseSetHash);
    expect(reportA.traces[0]?.request.constraintsCount).toBe(1);
    expect(reportA.traces[0]?.request).toHaveProperty("constraintsHash");
    expect(JSON.stringify(reportA)).not.toContain("short");
  });

  it("does not change execution seed material for grader, category, or difficulty-only edits", async () => {
    const reportA = await runEvaluation(
      [
        {
          id: "case",
          task: "Mention schema",
          category: "alpha",
          difficulty: "easy",
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );
    const reportB = await runEvaluation(
      [
        {
          id: "case",
          task: "Mention schema",
          category: "beta",
          difficulty: "hard",
          grader: {
            mustInclude: ["schema"],
            mustNotInclude: ["forbidden"],
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: "schema" } }]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(reportA.caseSetHash).not.toBe(reportB.caseSetHash);
    expect(reportA.traces[0]?.request.seedMaterialHash).toBe(
      reportB.traces[0]?.request.seedMaterialHash,
    );
  });

  it("drops provider generation ids from retained reports by default", async () => {
    const report = await runEvaluation(
      [
        {
          id: "case",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: { answer: "schema" },
            rawResponseId: "gen-secret",
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(JSON.stringify(report)).not.toContain("gen-secret");
    expect(report.cases[0]?.outcomes[0]?.result?.rawResponseIds).toEqual([]);
  });

  it("supports normalized exact graders", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: { answer: "  Schema   Failure  " } },
      ]),
    );

    const report = await runEvaluation(
      [
        {
          id: "exact",
          task: "Return schema failure",
          grader: { exactNormalized: "schema failure" },
        },
      ],
      orchestrator,
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1);
    expect(report.metrics.scored_n).toBe(1);
    expect(report.cases[0]?.fusionHarm).toBe(false);
  });

  it("supports strict whole-answer choice graders", async () => {
    const report = await runEvaluation(
      [
        {
          id: "choice-pass",
          task: "Return exactly approve or reject.",
          grader: {
            choice: { expected: "approve", allowed: ["approve", "reject"] },
          },
        },
        {
          id: "choice-wrong",
          task: "Return exactly approve or reject.",
          grader: {
            choice: { expected: "approve", allowed: ["approve", "reject"] },
          },
        },
        {
          id: "choice-invalid",
          task: "Return exactly approve or reject.",
          grader: {
            choice: { expected: "approve", allowed: ["approve", "reject"] },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: { answer: "  APPROVE  " } },
          { kind: "ok", output: { answer: "reject" } },
          { kind: "ok", output: { answer: "I choose approve." } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1 / 3);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      { name: "choice_valid", passed: true },
      { name: "choice_expected", passed: true },
    ]);
    expect(report.cases[1]?.outcomes[0]?.grader.checks).toEqual([
      { name: "choice_valid", passed: true },
      { name: "choice_expected", passed: false, details: "wrong_choice" },
    ]);
    expect(report.cases[2]?.outcomes[0]?.grader.checks).toEqual([
      { name: "choice_valid", passed: false, details: "choice_not_allowed" },
      {
        name: "choice_expected",
        passed: false,
        details: "choice_not_allowed",
      },
    ]);
  });

  it("counts choice graders in summaries, manifests, and smoke-only ignored evidence", () => {
    const cases: EvalCase[] = [
      {
        id: "choice-scored",
        task: "Return exactly route_a or route_b.",
        grader: {
          choice: { expected: "route_a", allowed: ["route_a", "route_b"] },
        },
      },
      {
        id: "choice-smoke",
        task: "Smoke choice validation",
        smokeOnly: true,
        grader: {
          choice: { expected: "route_a", allowed: ["route_a", "route_b"] },
        },
      },
    ];

    const summary = validateEvalCases(cases);
    const manifest = buildCaseSetManifest(cases);

    expect(summary.graderKindCounts.choice).toBe(1);
    expect(summary.totalConfiguredChecks).toBe(2);
    expect(summary.graderEvidenceTierCounts.structured_or_exact).toBe(1);
    expect(summary.graderEvidenceTierCounts.smoke_only).toBe(1);
    expect(summary.ignoredSmokeOnlyConfiguredGraderKindCounts.choice).toBe(1);
    expect(summary.ignoredSmokeOnlyConfiguredCheckCount).toBe(2);
    expect(manifest.summary.casesWithGraderKind.choice).toBe(1);
    expect(manifest.summary.totalConfiguredChecks).toBe(2);
    expect(manifest.rows[0]?.graderKinds).toContain("choice");
    expect(manifest.rows[1]?.ignoredSmokeOnlyGraderKinds).toContain("choice");
  });

  it("validates choice graders before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);

    const invalidChoiceGraders: Array<{
      choice: unknown;
      expectedError: RegExp;
    }> = [
      {
        choice: "approve",
        expectedError: /grader\.choice must be an object/,
      },
      {
        choice: { expected: "approve", allowed: ["approve"], alias: "yes" },
        expectedError: /grader\.choice\.alias is not allowed/,
      },
      {
        choice: { expected: 1, allowed: ["approve"] },
        expectedError: /grader\.choice\.expected must be string/,
      },
      {
        choice: { expected: "approve", allowed: ["approve", 1] },
        expectedError: /grader\.choice\.allowed must be an array of strings/,
      },
      {
        choice: { expected: "approve", allowed: [] },
        expectedError: /grader\.choice\.allowed has invalid length/,
      },
      {
        choice: {
          expected: "choice-0",
          allowed: Array.from({ length: 51 }, (_, index) => `choice-${index}`),
        },
        expectedError: /grader\.choice\.allowed has invalid length/,
      },
      {
        choice: { expected: "approve", allowed: ["approve", "   "] },
        expectedError: /grader\.choice\.allowed\[1\] must be non-empty/,
      },
      {
        choice: { expected: "x".repeat(201), allowed: ["x".repeat(201)] },
        expectedError: /grader\.choice\.expected is too long/,
      },
      {
        choice: { expected: "approve", allowed: ["approve", "x".repeat(201)] },
        expectedError: /grader\.choice\.allowed\[1\] is too long/,
      },
    ];

    for (const { choice, expectedError } of invalidChoiceGraders) {
      await expect(
        runEvaluation(
          [
            {
              id: "bad-choice-shape",
              task: "Return a label.",
              grader: {
                choice,
              },
            } as unknown as EvalCase,
          ],
          orchestrator,
          budget,
          { configs: ["direct"] },
        ),
      ).rejects.toThrow(expectedError);
      expect(client.calls).toHaveLength(0);
    }

    await expect(
      runEvaluation(
        [
          {
            id: "bad-choice",
            task: "Return a label.",
            grader: {
              choice: {
                expected: "approve",
                allowed: ["approve", " APPROVE "],
              },
            },
          },
        ],
        orchestrator,
        budget,
        { configs: ["direct"] },
      ),
    ).rejects.toThrow(/duplicate normalized choices/);
    expect(client.calls).toHaveLength(0);

    await expect(
      runEvaluation(
        [
          {
            id: "missing-expected",
            task: "Return a label.",
            grader: {
              choice: { expected: "defer", allowed: ["approve", "reject"] },
            },
          },
        ],
        orchestrator,
        budget,
        { configs: ["direct"] },
      ),
    ).rejects.toThrow(/expected must be one of allowed/);
    expect(client.calls).toHaveLength(0);
  });

  it("supports strict JSON path graders", async () => {
    const report = await runEvaluation(
      [
        {
          id: "json",
          task: "Return only JSON",
          grader: {
            json: {
              requireValid: true,
              requiredPaths: ["decision", "steps[0]"],
              equals: { decision: "defer", risk: null, ok: true },
              includes: { rationale: "schema" },
              arrayMinLength: { steps: 2 },
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              answer: JSON.stringify({
                decision: "defer",
                risk: null,
                ok: true,
                rationale: "Schema is missing",
                steps: ["validate", "report"],
              }),
            },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1);
    expect(
      report.cases[0]?.outcomes[0]?.grader.checks.map((check) => check.name),
    ).toEqual([
      "json_valid",
      "json_required_path",
      "json_required_path",
      "json_equals",
      "json_equals",
      "json_equals",
      "json_includes",
      "json_array_min_length",
    ]);
  });

  it("fails JSON graders without throwing when the answer is not strict JSON", async () => {
    const report = await runEvaluation(
      [
        {
          id: "bad-json",
          task: "Return only JSON",
          grader: {
            json: {
              requireValid: true,
              requiredPaths: ["decision"],
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: { answer: '```json\n{"decision":"ok"}\n```' } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      { name: "json_valid", passed: false, details: "json_parse_failed" },
      { name: "json_check", passed: false, details: "json_parse_failed" },
    ]);
  });

  it("supports JSON schema-subset graders with symbolic diagnostics", async () => {
    const secretEnum = "PRIVATE-APPROVE-CODE";
    const cases: EvalCase[] = [
      {
        id: "schema-pass",
        task: "Return a decision object",
        grader: {
          json: {
            schemaSubset: {
              type: "object",
              properties: {
                decision: { type: "string", enum: [secretEnum] },
                score: { type: "integer", minimum: 0, maximum: 10 },
              },
              required: ["decision", "score"],
              additionalProperties: false,
            },
          },
        },
      },
      {
        id: "schema-fail",
        task: "Return a decision object",
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
      {
        id: "schema-bad-json",
        task: "Return strict JSON",
        grader: {
          json: {
            schemaSubset: {
              type: "object",
              properties: { decision: { type: "string" } },
              required: ["decision"],
              additionalProperties: false,
            },
          },
        },
      },
    ];

    const report = await runEvaluation(
      cases,
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              answer: JSON.stringify({ decision: secretEnum, score: 7 }),
            },
          },
          {
            kind: "ok",
            output: { answer: JSON.stringify({ decision: "wrong" }) },
          },
          { kind: "ok", output: { answer: "```json\n{}\n```" } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1 / 3);
    expect(report.cases.map((evalCase) => evalCase.graderEvidenceTier)).toEqual(
      ["structured_or_exact", "structured_or_exact", "structured_or_exact"],
    );
    expect(
      report.cases.map((evalCase) => evalCase.outcomes[0]?.grader.checks[0]),
    ).toEqual([
      { name: "json_schema_subset", passed: true },
      {
        name: "json_schema_subset",
        passed: false,
        details: "schema_subset_mismatch",
      },
      {
        name: "json_schema_subset",
        passed: false,
        details: "json_parse_failed",
      },
    ]);
    expect(JSON.stringify(report.cases[1]?.outcomes[0]?.grader)).not.toContain(
      secretEnum,
    );
  });

  it("supports finite numeric graders with absolute tolerance and regex extraction", async () => {
    const report = await runEvaluation(
      [
        {
          id: "numeric",
          task: "Compute total",
          grader: {
            number: {
              expected: 42,
              tolerance: 0.01,
              min: 40,
              max: 45,
              extractionRegex: "^total=([0-9.]+)$",
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: { answer: "total=42.005" } },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      {
        name: "number_expected",
        passed: true,
        details: "absolute_tolerance",
      },
      { name: "number_min", passed: true },
      { name: "number_max", passed: true },
    ]);
  });

  it("supports citation mechanics graders without semantic entailment claims", async () => {
    const report = await runEvaluation(
      [
        {
          id: "citations",
          task: "Use the supplied source snippets and cite them with brackets.",
          grader: {
            citations: {
              allowedSourceIds: ["S1", "S2"],
              requiredSourceIds: ["S1"],
              minCitedSources: 2,
              requiredClaims: [{ sourceId: "S1", text: "Revenue rose 12%" }],
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              answer: "Revenue rose 12% [S1]. Margin improved [S2].",
            },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1);
    expect(report.cases[0]?.graderEvidenceTier).toBe("structured_or_exact");
    expect(
      report.cases[0]?.outcomes[0]?.grader.checks.map((check) => check.name),
    ).toEqual([
      "citation_allowed_sources",
      "citation_required_source",
      "citation_min_sources",
      "citation_required_claim",
    ]);
  });

  it("supports immediate citation placement for required citation claims", async () => {
    const report = await runEvaluation(
      [
        {
          id: "immediate-citation",
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
            output: { answer: "Revenue rose 12% [S1]." },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(1);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      {
        name: "citation_allowed_sources",
        passed: true,
      },
      {
        name: "citation_required_claim",
        passed: true,
      },
    ]);
  });

  it("keeps bounded-window citation placement as the default and explicit mode", async () => {
    const report = await runEvaluation(
      [
        {
          id: "default-window-citation",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: ["S1"],
              requiredClaims: [
                {
                  sourceId: "S1",
                  text: "Revenue rose 12%",
                },
              ],
            },
          },
        },
        {
          id: "explicit-window-citation",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: ["S1"],
              requiredClaims: [
                {
                  sourceId: "S1",
                  text: "Revenue rose 12%",
                  citationPlacement: "within_window",
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

    expect(report.metrics.task_pass_rate.direct).toBe(1);
    expect(
      report.cases.map(
        (evalCase) => evalCase.outcomes[0]?.grader.checks[1]?.passed,
      ),
    ).toEqual([true, true]);
  });

  it("fails immediate citation placement when prose or punctuation intervenes", async () => {
    const secretClaim = "Internal revenue rose 12%";
    const report = await runEvaluation(
      [
        {
          id: "delayed-citation",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: ["S1"],
              requiredClaims: [
                {
                  sourceId: "S1",
                  text: secretClaim,
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
              answer: `${secretClaim}. According to the release note [S1].`,
            },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      {
        name: "citation_allowed_sources",
        passed: true,
      },
      {
        name: "citation_required_claim",
        passed: false,
        details: "claim_not_immediately_cited",
      },
    ]);
    expect(
      JSON.stringify(report.cases[0]?.outcomes[0]?.grader.checks),
    ).not.toContain(secretClaim);
  });

  it("fails citation graders for unknown sources and uncited required claims", async () => {
    const secretSource = "PRIVATE-SOURCE";
    const secretClaim = "Internal revenue rose 12%";
    const report = await runEvaluation(
      [
        {
          id: "bad-citations",
          task: "Use bracket citations.",
          grader: {
            citations: {
              allowedSourceIds: [secretSource, "S2"],
              requiredSourceIds: [secretSource],
              minCitedSources: 2,
              requiredClaims: [{ sourceId: secretSource, text: secretClaim }],
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              answer: `${secretClaim}. Margin improved [S2]. Extra [S3].`,
            },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      {
        name: "citation_allowed_sources",
        passed: false,
        details: "unknown_source",
      },
      {
        name: "citation_required_source",
        passed: false,
        details: "missing_required_source",
      },
      {
        name: "citation_min_sources",
        passed: false,
        details: "too_few_sources",
      },
      {
        name: "citation_required_claim",
        passed: false,
        details: "claim_not_cited",
      },
    ]);
    const serializedChecks = JSON.stringify(
      report.cases[0]?.outcomes[0]?.grader.checks,
    );
    expect(serializedChecks).not.toContain(secretSource);
    expect(serializedChecks).not.toContain(secretClaim);
  });

  it("fails malformed bracket citations instead of extracting nested tokens", async () => {
    const malformedAnswers = [
      "Revenue rose 12% [[S1]].",
      "Revenue rose 12% [].",
      "Revenue rose 12% [S1",
      "Revenue rose 12% [S1\n].",
      "Revenue rose 12% [S1 ].",
      "Revenue rose 12% [S1]. Extra [].",
    ];
    const report = await runEvaluation(
      malformedAnswers.map((_, index) => ({
        id: `malformed-citation-${index}`,
        task: "Use bracket citations.",
        grader: {
          citations: {
            allowedSourceIds: ["S1"],
            requiredSourceIds: ["S1"],
            requiredClaims: [{ sourceId: "S1", text: "Revenue rose 12%" }],
          },
        },
      })),
      makeOrchestrator(
        new FakeModelClient(
          malformedAnswers.map((answer) => ({
            kind: "ok" as const,
            output: { answer },
          })),
        ),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    for (const evalCase of report.cases) {
      expect(evalCase.outcomes[0]?.grader.checks[0]).toEqual({
        name: "citation_allowed_sources",
        passed: false,
        details: "malformed_citation",
      });
    }
  });

  it("does not leak expected or extracted values through grader details", async () => {
    const secret = "sk-or-v1-secret";
    const report = await runEvaluation(
      [
        {
          id: "secret-grader",
          task: "Return JSON",
          grader: {
            json: {
              equals: { token: secret },
              includes: { message: secret },
            },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: {
              answer: JSON.stringify({ token: "wrong", message: "wrong" }),
            },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("validates structured graders before spending model calls", async () => {
    const cyclicSchema: Record<string, unknown> = { type: "array" };
    cyclicSchema.items = cyclicSchema;
    const tooDeepSchema = Array.from({ length: 12 }).reduce<unknown>(
      (items) => ({ type: "array", items }),
      { type: "string" },
    );
    const cases: EvalCase[] = [
      {
        id: "bad-path",
        task: "Task",
        grader: { json: { requiredPaths: ["__proto__.polluted"] } },
      },
      {
        id: "bad-number",
        task: "Task",
        grader: { number: { expected: 1, tolerance: -1 } },
      },
      {
        id: "bad-regex-capture",
        task: "Task",
        grader: {
          number: { expected: 1, extractionRegex: "^value=(\\d+)-(\\d+)$" },
        },
      },
      {
        id: "unsafe-regex",
        task: "Task",
        grader: { regex: ["(a+)+$"] },
      },
      {
        id: "ambiguous-regex",
        task: "Task",
        grader: { regex: ["^(a|aa)+$"] },
      },
      {
        id: "ambiguous-number-regex",
        task: "Task",
        grader: {
          number: { expected: 1, extractionRegex: "^(a|aa)+([0-9])$" },
        },
      },
      {
        id: "empty-include",
        task: "Task",
        grader: { mustInclude: [""] },
      },
      {
        id: "empty-json-include",
        task: "Task",
        grader: { json: { includes: { rationale: "" } } },
      },
      {
        id: "huge-exact",
        task: "Task",
        grader: { exact: "x".repeat(201) },
      },
      {
        id: "huge-json-equals",
        task: "Task",
        grader: { json: { equals: { value: "x".repeat(201) } } },
      },
      {
        id: "schema-unsupported-keyword",
        task: "Task",
        grader: {
          json: {
            schemaSubset: {
              type: "string",
              pattern: "^ok$",
            } as never,
          },
        },
      },
      {
        id: "schema-object-needs-additional-properties",
        task: "Task",
        grader: {
          json: {
            schemaSubset: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            } as never,
          },
        },
      },
      {
        id: "schema-required-unknown-property",
        task: "Task",
        grader: {
          json: {
            schemaSubset: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["missing"],
              additionalProperties: false,
            },
          },
        },
      },
      {
        id: "schema-inherited-type",
        task: "Task",
        grader: {
          json: {
            schemaSubset: Object.create({
              type: "string",
            }) as never,
          },
        },
      },
      {
        id: "schema-too-many-properties",
        task: "Task",
        grader: {
          json: {
            schemaSubset: {
              type: "object",
              properties: Object.fromEntries(
                Array.from({ length: 101 }, (_, index) => [
                  `field${index}`,
                  { type: "string" },
                ]),
              ),
              additionalProperties: false,
            },
          },
        },
      },
      {
        id: "schema-too-many-enum-values",
        task: "Task",
        grader: {
          json: {
            schemaSubset: {
              type: "string",
              enum: Array.from({ length: 51 }, (_, index) => `value${index}`),
            },
          },
        },
      },
      {
        id: "schema-too-deep",
        task: "Task",
        grader: {
          json: {
            schemaSubset: tooDeepSchema as never,
          },
        },
      },
      {
        id: "schema-cyclic",
        task: "Task",
        grader: {
          json: {
            schemaSubset: cyclicSchema as never,
          },
        },
      },
      {
        id: "citation-allowlist-only",
        task: "Task",
        grader: { citations: { allowedSourceIds: ["S1"] } },
      },
      {
        id: "citation-bad-id",
        task: "Task",
        grader: {
          citations: { allowedSourceIds: ["bad id"], minCitedSources: 1 },
        },
      },
      {
        id: "citation-duplicate-id",
        task: "Task",
        grader: {
          citations: { allowedSourceIds: ["S1", "S1"], minCitedSources: 1 },
        },
      },
      {
        id: "citation-unknown-required",
        task: "Task",
        grader: {
          citations: {
            allowedSourceIds: ["S1"],
            requiredSourceIds: ["S2"],
          },
        },
      },
      {
        id: "citation-too-many-min",
        task: "Task",
        grader: {
          citations: {
            allowedSourceIds: ["S1"],
            minCitedSources: 2,
          },
        },
      },
      {
        id: "citation-unknown-claim-source",
        task: "Task",
        grader: {
          citations: {
            allowedSourceIds: ["S1"],
            requiredClaims: [{ sourceId: "S2", text: "claim" }],
          },
        },
      },
      {
        id: "citation-bad-placement",
        task: "Task",
        grader: {
          citations: {
            allowedSourceIds: ["S1"],
            requiredClaims: [
              {
                sourceId: "S1",
                text: "claim",
                citationPlacement: "secret-placement" as never,
              },
            ],
          },
        },
      },
    ];

    for (const evalCase of cases) {
      const client = new FakeModelClient([]);
      await expect(
        runEvaluation([evalCase], makeOrchestrator(client), budget, {
          configs: ["direct"],
        }),
      ).rejects.toThrow();
      expect(client.calls).toHaveLength(0);
    }
  });

  it("fails oversized answers before detailed grading", async () => {
    const secret = "sk-or-v1-secret";
    const report = await runEvaluation(
      [
        {
          id: "huge-answer",
          task: "Return a huge answer",
          grader: {
            mustInclude: [secret],
            json: { requireValid: true },
          },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "ok",
            output: { answer: `${"x".repeat(20_001)}${secret}` },
          },
        ]),
      ),
      budget,
      { configs: ["direct"] },
    );

    expect(report.metrics.task_pass_rate.direct).toBe(0);
    expect(report.cases[0]?.outcomes[0]?.grader.checks).toEqual([
      { name: "answer_size", passed: false, details: "answer_too_large" },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("caps retained outputs when output retention is enabled", async () => {
    const longAnswer = "x".repeat(50_000);
    const report = await runEvaluation(
      [
        {
          id: "retained-huge-answer",
          task: "Return a huge answer",
          grader: { maxLength: 10 },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([{ kind: "ok", output: { answer: longAnswer } }]),
      ),
      budget,
      { configs: ["direct"], retainOutputs: true },
    );

    const result = report.cases[0]?.outcomes[0]?.result;
    expect(result?.answer).toHaveLength(10_000);
    expect(result?.retention?.answer).toMatchObject({
      truncated: true,
      originalLength: 50_000,
      retainedLength: 10_000,
    });
    expect(result?.retention?.answer?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records trial-aware paired metrics, position counts, and bootstrap intervals", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: { answer: "schema" } },
        { kind: "ok", output: candidate("a1", "schema") },
        { kind: "ok", output: candidate("b1", "schema") },
        {
          kind: "ok",
          output: {
            answer: "missing",
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
          },
        },
        { kind: "ok", output: candidate("a2", "schema") },
        { kind: "ok", output: candidate("b2", "schema") },
        {
          kind: "ok",
          output: {
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
          },
        },
        { kind: "ok", output: { answer: "missing" } },
      ]),
    );

    const report = await runEvaluation(
      [
        {
          id: "paired",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        },
      ],
      orchestrator,
      budget,
      {
        configs: ["direct", "fusion"],
        trialsPerCase: 2,
        bootstrapSamples: 20,
      },
    );

    expect(report.evaluationDesign.trialsPerCase).toBe(2);
    expect(report.metrics.scored_trial_n).toBe(2);
    expect(report.metrics.scored_attempt_n.direct).toBe(2);
    expect(report.metrics.task_pass_rate.direct).toBe(0.5);
    expect(report.metrics.task_pass_rate.fusion).toBe(0.5);
    expect(report.metrics.fusion_harm_rate).toBe(0.5);
    expect(report.metrics.paired_vs_direct.fusion).toMatchObject({
      paired_n: 2,
      wins: 1,
      losses: 1,
      ties: 0,
      pass_rate_delta: 0,
      harm_rate: 0.5,
    });
    expect(report.metrics.position_counts.direct.all).toEqual([1, 1]);
    expect(report.metrics.position_counts.fusion.scored).toEqual([1, 1]);
    expect(report.metrics.confidence_intervals.task_pass_rate.direct).toEqual({
      low: 0.5,
      high: 0.5,
    });
    expect(
      report.metrics.confidence_intervals.pass_rate_delta_vs_direct.fusion,
    ).toEqual({ low: 0, high: 0 });
    expect(report.traces[0]?.trialIndex).toBe(0);
    expect(report.traces[0]?.request).toHaveProperty("seedMaterialHash");
    expect(JSON.stringify(report.traces[0]?.request)).not.toContain("trial-0");
  });

  it("marks paired metrics unavailable when direct is not in the config set", async () => {
    const report = await runEvaluation(
      [
        {
          id: "fusion-only",
          task: "Mention schema",
          grader: { mustInclude: ["schema"] },
        },
      ],
      makeOrchestrator(
        new FakeModelClient([
          { kind: "ok", output: candidate("a", "schema") },
          { kind: "ok", output: candidate("b", "schema") },
          {
            kind: "ok",
            output: {
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
            },
          },
        ]),
      ),
      budget,
      { configs: ["fusion"], bootstrapSamples: 10 },
    );

    expect(report.metrics.fusion_harm_rate).toBeNull();
    expect(report.metrics.paired_vs_direct.fusion).toMatchObject({
      paired_n: 0,
      unpaired_n: 1,
      pass_rate_delta: null,
      mean_cost_delta_usd: null,
      harm_rate: null,
    });
    expect(
      report.metrics.confidence_intervals.pass_rate_delta_vs_direct.fusion,
    ).toBeNull();
  });

  it("does not bootstrap direct deltas when trial pairing coverage is duplicated or missing", () => {
    const outcome = (
      configId: EvalConfigOutcome["configId"],
      passed: boolean,
      executionOrder: number,
    ): EvalConfigOutcome => ({
      configId,
      trialIndex: 0,
      status: "completed",
      passed,
      grader: { passed, smokeOnly: false, checks: [] },
      executionOrder,
    });
    const result = (
      id: string,
      caseIndex: number,
      outcomes: EvalConfigOutcome[],
    ): EvalCaseResult => ({
      id,
      caseIndex,
      smokeOnly: false,
      graderEvidenceTier: "surface_text",
      executionSchedule: ["direct", "fusion"],
      trials: [
        {
          trialIndex: 0,
          executionSchedule: ["direct", "fusion"],
          outcomes,
          fusionHarm: false,
        },
      ],
      outcomes,
      fusionHarm: false,
    });

    const intervals = passRateDeltaVsDirectBootstrapIntervals(
      [
        result("duplicate-direct", 0, [
          outcome("direct", true, 0),
          outcome("direct", false, 1),
          outcome("fusion", true, 2),
        ]),
        result("missing-direct", 1, [outcome("fusion", false, 0)]),
      ],
      ["direct", "fusion"],
      20,
    );

    expect(intervals.direct).toBeNull();
    expect(intervals.fusion).toBeNull();
  });

  it("sanitizes degraded result failure messages in retained case outcomes", async () => {
    const secret = "Acme-Private sk-or-v1-secret";
    const report = await runEvaluation(
      [{ id: "degraded", task: "Smoke degraded", smokeOnly: true }],
      makeOrchestrator(
        new FakeModelClient([
          {
            kind: "error",
            status: "provider_error",
            message: `failed for ${secret}`,
          },
          { kind: "ok", output: candidate("b", "schema") },
          {
            kind: "ok",
            output: {
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
            },
          },
        ]),
      ),
      budget,
      { configs: ["fusion"] },
    );

    expect(report.cases[0]?.outcomes[0]?.result?.failures[0]?.message).toBe(
      "Model call failed with status: provider_error",
    );
    expect(JSON.stringify(report)).not.toContain("Acme-Private");
    expect(JSON.stringify(report)).not.toContain("sk-or-v1-secret");
  });
});

class CliAutoPassClient implements ModelClient {
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

function makeOrchestrator(client: ModelClient): FrugalFusionOrchestrator {
  return new FrugalFusionOrchestrator({
    client,
    models,
    priceSnapshot: (modelIds) => modelIds.map(snapshot),
  });
}

function snapshot(modelId: string): PriceSnapshotEntry {
  return {
    modelId,
    supportedParameters: ["temperature", "top_p", "seed"],
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: new Date().toISOString(),
    source: "config",
  };
}

export function candidate(id: string, conclusion: string): Candidate {
  return {
    candidateId: id,
    conclusion,
    claims: [
      {
        claimId: `${id}-1`,
        text: conclusion,
        evidenceIds: [],
        confidence: 0.8,
      },
    ],
    reasoningOutline: ["compact"],
    alternatives: [],
    risks: [],
    unresolved: [],
  };
}
