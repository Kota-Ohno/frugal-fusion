#!/usr/bin/env node
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  assessEvalClaimGate,
  buildCaseSetManifestFromJsonl,
  runEvaluation,
  parseJsonlCases,
  validateEvalCases,
  verifyCaseSetManifestBinding,
} from "./evaluation.js";
import { buildEvalPreflightPlan } from "./evalPreflight.js";
import type {
  EvalClaimGateAssessment,
  EvalClaimGateManifestHashAlgorithm,
  EvalClaimGateTarget,
  EvalCaseSetManifestOptions,
  EvalCaseManifestIntendedUse,
  EvalCaseValidationSummary,
} from "./evaluation.js";
import { ModelRegistry } from "./modelRegistry.js";
import { OpenRouterClient } from "./openRouterClient.js";
import { FrugalFusionOrchestrator } from "./orchestrator.js";
import {
  buildPublicEvalReport,
  publicReportJsonParseFailureVerification,
  publicReportJsonReadFailureVerification,
  verifyPublicEvalReportArtifact,
} from "./publicReport.js";
import {
  buildEvalRunProvenance,
  cliEvalInvocationProvenance,
  modelIdsForRunProvenance,
} from "./runProvenance.js";
import type { PublicEvalReport } from "./publicReport.js";
import type { DeliberationMode } from "./types.js";
import type { DeliberationRequest } from "./types.js";

type CliRuntime = {
  orchestrator: FrugalFusionOrchestrator;
  config: Awaited<ReturnType<typeof loadConfig>>;
  registry: ModelRegistry;
  configSourceKind: "default_config" | "config_file";
};

type CliConfigAndRegistry = Omit<CliRuntime, "orchestrator">;

export type CliDependencies = {
  buildOrchestrator?: (args: string[]) => Promise<CliRuntime>;
};

export async function runCli(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const [command, ...args] = argv;
  const buildRuntime = dependencies.buildOrchestrator ?? buildOrchestrator;
  if (command === undefined) usage();
  if (isHelpFlag(command)) {
    console.log(topLevelHelpText());
    return 0;
  }
  if (command === "models") {
    if (isHelpRequested(args)) {
      console.log(modelsHelpText());
      return 0;
    }
    const out = readOption(args, "--out") ?? ".frugal-fusion/models.json";
    const registry = await ModelRegistry.fromOpenRouter(requireApiKey());
    await writeJson(out, registry.snapshot());
    console.log(`Wrote model snapshot to ${out}`);
    return 0;
  }

  if (command === "ask") {
    if (isHelpRequested(args)) {
      console.log(askHelpText());
      return 0;
    }
    const task = args[0];
    if (!task) usage();
    const mode = readModeOption(args, "--mode") ?? "fusion";
    const { orchestrator, config } = await buildRuntime(args);
    const result = await orchestrator.run({
      task,
      mode,
      verification: "none",
      budget: config.budget,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "validate-cases") {
    if (isHelpRequested(args)) {
      console.log(validateCasesHelpText());
      return 0;
    }
    const file = args[0];
    if (!file) usage();
    const manifestOut = readOption(args, "--manifest-out");
    const manifestHmacKeyEnv = readOption(args, "--manifest-hmac-key-env");
    const claimGateTarget = readClaimGateTarget(args);
    if (claimGateTarget !== undefined && hasOption(args, "--private")) {
      throw new Error("--private cannot be combined with --claim-gate");
    }
    if (claimGateTarget !== undefined) {
      rejectClaimGateDisclosureFlags(args);
    }
    if (manifestHmacKeyEnv !== undefined && !manifestOut) {
      throw new Error("--manifest-hmac-key-env requires --manifest-out");
    }
    const intendedUse =
      manifestOut || claimGateTarget !== undefined
        ? readManifestIntendedUse(args)
        : "dev";
    let manifestHashAlgorithm: EvalClaimGateManifestHashAlgorithm | undefined;
    const manifestHashMode =
      manifestHmacKeyEnv === undefined
        ? undefined
        : {
            kind: "hmac-sha256" as const,
            key: readManifestHmacKey(manifestHmacKeyEnv),
          };
    if (manifestHashMode) {
      rejectHmacDisclosureFlags(args);
    }
    if (manifestOut) {
      manifestHashAlgorithm =
        manifestHashMode === undefined ? "sha256" : "hmac-sha256";
    }
    let text = "";
    let summary: EvalCaseValidationSummary;
    try {
      text = await readFile(file, "utf8");
      const cases = parseJsonlCases(text);
      summary = validateEvalCases(cases, {
        requireScored: !hasOption(args, "--allow-smoke-only"),
      });
    } catch (error) {
      if (claimGateTarget !== undefined) {
        console.log(
          JSON.stringify(publicClaimGateInputFailure(claimGateTarget), null, 2),
        );
        return 2;
      }
      throw error;
    }
    const claimGate =
      claimGateTarget === undefined
        ? undefined
        : assessEvalClaimGate(summary, {
            target: claimGateTarget,
            intendedUse,
            ...(manifestOut
              ? {
                  manifestRequested: true,
                  manifestHashAlgorithm: requireManifestHashAlgorithm(
                    manifestHashAlgorithm,
                  ),
                }
              : { manifestRequested: false }),
          });
    if (claimGate?.status === "case_set_blocked") {
      console.log(
        JSON.stringify(publicValidationSummary(summary, claimGate), null, 2),
      );
      return 2;
    }
    if (manifestOut) {
      if (await sameOutputPath(manifestOut, file)) {
        throw new Error("--manifest-out must not refer to the input case file");
      }
      const manifestOptions: Omit<
        EvalCaseSetManifestOptions,
        "rows" | "rawFileSha256" | "rawFileHmacSha256"
      > = {
        intendedUse,
        includeCaseIds: hasOption(args, "--public-case-ids"),
        includeCategoryLabels: hasOption(args, "--public-category-labels"),
      };
      if (manifestHashMode) manifestOptions.hashMode = manifestHashMode;
      const sourceLabel = readOption(args, "--source-label");
      if (sourceLabel !== undefined) manifestOptions.sourcePath = sourceLabel;
      await writeJson(
        manifestOut,
        buildCaseSetManifestFromJsonl(text, manifestOptions),
      );
      console.error(
        manifestHashMode !== undefined || claimGateTarget !== undefined
          ? "Wrote case-set manifest"
          : `Wrote case-set manifest to ${manifestOut}`,
      );
    }
    console.log(
      JSON.stringify(
        hasOption(args, "--private")
          ? summary
          : publicValidationSummary(summary, claimGate),
        null,
        2,
      ),
    );
    return 0;
  }

  if (command === "verify-public-report") {
    if (isHelpRequested(args)) {
      console.log(verifyPublicReportHelpText());
      return 0;
    }
    const file = args[0];
    if (!file) usage();
    let publicReport: unknown;
    try {
      publicReport = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.log(
          JSON.stringify(publicReportJsonParseFailureVerification(), null, 2),
        );
        return 2;
      }
      console.log(
        JSON.stringify(publicReportJsonReadFailureVerification(), null, 2),
      );
      return 2;
    }
    const verification = verifyPublicEvalReportArtifact(publicReport);
    console.log(JSON.stringify(verification, null, 2));
    return verification.status === "public_report_verified" ? 0 : 2;
  }

  if (command === "eval") {
    if (isHelpRequested(args)) {
      console.log(evalHelpText());
      return 0;
    }
    const file = args[0];
    if (!file) usage();
    const preflight = hasOption(args, "--preflight");
    const preflightOut = readOption(args, "--preflight-out");
    const explicitOut = hasOption(args, "--out");
    const out = readOption(args, "--out") ?? ".frugal-fusion/eval-result.json";
    const publicOut = readOption(args, "--public-out");
    if (preflight && (explicitOut || publicOut !== undefined)) {
      throw new Error(
        "--preflight does not write evaluation reports; use --preflight-out for the preflight JSON",
      );
    }
    if (preflightOut !== undefined && !preflight) {
      throw new Error("--preflight-out requires --preflight");
    }
    const caseManifest = readOption(args, "--case-manifest");
    const caseManifestHmacKeyEnv = readOption(
      args,
      "--case-manifest-hmac-key-env",
    );
    if (caseManifestHmacKeyEnv !== undefined && caseManifest === undefined) {
      throw new Error("--case-manifest-hmac-key-env requires --case-manifest");
    }
    const shouldWritePrivateReport =
      explicitOut || !publicOut || caseManifest !== undefined;
    if (
      publicOut &&
      (shouldWritePrivateReport || !explicitOut) &&
      (await sameOutputPath(publicOut, out))
    ) {
      throw new Error("--public-out must not refer to the private report path");
    }
    let cases: ReturnType<typeof parseJsonlCases>;
    let caseValidationSummary: EvalCaseValidationSummary;
    try {
      cases = parseJsonlCases(await readFile(file, "utf8"));
      caseValidationSummary = validateEvalCases(cases);
    } catch (error) {
      if (preflight || caseManifest !== undefined || publicOut !== undefined) {
        throw new Error("Evaluation case file parsing or validation failed");
      }
      throw error;
    }
    let caseSetManifestBinding:
      | ReturnType<typeof verifyCaseSetManifestBinding>
      | undefined;
    try {
      caseSetManifestBinding =
        caseManifest === undefined
          ? undefined
          : verifyCaseSetManifestBinding(
              cases,
              await readFile(caseManifest, "utf8"),
              caseManifestHmacKeyEnv === undefined
                ? {}
                : { hmacKey: readManifestHmacKey(caseManifestHmacKeyEnv) },
            );
    } catch (error) {
      if (preflight) {
        throw new Error("Case manifest could not be loaded or verified");
      }
      throw error;
    }
    const caseSetClaimGate =
      caseSetManifestBinding === undefined
        ? undefined
        : assessEvalClaimGate(caseValidationSummary, {
            intendedUse: caseSetManifestBinding.intendedUse,
            manifestRequested: true,
            manifestHashAlgorithm: caseSetManifestBinding.hashAlgorithm,
          });
    if (
      publicOut !== undefined &&
      caseSetClaimGate?.status === "case_set_blocked"
    ) {
      throw new Error(
        "Case-set claim gate failed before model spend; fix the holdout or run validate-cases --claim-gate public_cost_performance for details.",
      );
    }
    if (preflight) {
      let loaded: CliConfigAndRegistry;
      try {
        loaded = await loadConfigAndRegistry(args);
      } catch {
        throw new Error(
          "Preflight config or model snapshot could not be loaded or parsed",
        );
      }
      const { config, registry } = loaded;
      if (preflightOut !== undefined) {
        await rejectPreflightOutputInputAliases(preflightOut, args, {
          caseFile: file,
          ...(caseManifest === undefined ? {} : { caseManifest }),
        });
      }
      const configs: DeliberationMode[] = [...DEFAULT_EVAL_CONFIGS];
      const trialsPerCase = readEvalTrialsPerCase(args);
      const guards = readPreflightGuards(args);
      let plan: ReturnType<typeof buildEvalPreflightPlan>;
      try {
        plan = buildEvalPreflightPlan({
          cases,
          summary: caseValidationSummary,
          config,
          registry,
          configs,
          trialsPerCase,
          ...(caseSetManifestBinding === undefined
            ? {}
            : { caseSetManifestBinding }),
          ...(caseSetClaimGate === undefined ? {} : { caseSetClaimGate }),
          guards,
        });
      } catch (error) {
        throw sanitizePreflightPlanningError(error);
      }
      if (preflightOut !== undefined) {
        try {
          await writeJson(preflightOut, plan);
        } catch {
          throw new Error("Preflight output could not be written");
        }
        console.error("Wrote eval preflight plan");
      }
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    const { orchestrator, config, registry, configSourceKind } =
      await buildRuntime(args);
    const configs: DeliberationMode[] = [...DEFAULT_EVAL_CONFIGS];
    const evalOptions: Parameters<typeof runEvaluation>[3] = {
      retainRawPrompt: config.retainRawPrompt,
      retainOutputs: config.retainOutputs,
      retainProviderIds: config.retainProviderIds,
      configs,
    };
    if (shouldWritePrivateReport) {
      evalOptions.runProvenance = buildEvalRunProvenance({
        config,
        configs,
        configSourceKind,
        modelPriceEntries: registry.snapshot(
          modelIdsForRunProvenance(config.models, configs),
        ),
        modelSnapshotSourceKind: "models_file",
        invocation: cliEvalInvocationProvenance(),
      });
    }
    if (caseSetManifestBinding !== undefined) {
      evalOptions.caseSetManifestBinding = caseSetManifestBinding;
    }
    const trials = readIntegerOption(args, "--trials");
    if (trials !== undefined) evalOptions.trialsPerCase = trials;
    const bootstrapSamples = readIntegerOption(args, "--bootstrap-samples");
    if (bootstrapSamples !== undefined)
      evalOptions.bootstrapSamples = bootstrapSamples;
    const report = await runEvaluation(
      cases,
      orchestrator,
      config.budget,
      evalOptions,
    );
    if (shouldWritePrivateReport) {
      await writeJson(out, report);
      console.log(`Wrote private evaluation report to ${out}`);
    }
    let publicReport: PublicEvalReport | undefined;
    if (publicOut) {
      publicReport = buildPublicEvalReport(report);
      await writeJson(publicOut, publicReport);
      console.log(`Wrote public evaluation report to ${publicOut}`);
    }
    console.log(
      JSON.stringify(
        publicReport ? publicReport.metrics : report.metrics,
        null,
        2,
      ),
    );
    return 0;
  }

  usage();
}

const DEFAULT_EVAL_CONFIGS: DeliberationMode[] = [
  "direct",
  "self_review",
  "repeated",
  "fusion",
];

async function buildOrchestrator(args: string[]): Promise<CliRuntime> {
  const { config, registry, configSourceKind } =
    await loadConfigAndRegistry(args);
  const client = new OpenRouterClient({
    apiKey: requireApiKey(),
    registry,
    title: "Frugal Fusion MVP",
    provider: config.provider,
  });
  return {
    config,
    registry,
    configSourceKind,
    orchestrator: new FrugalFusionOrchestrator({
      client,
      models: config.models,
      sampling: config.sampling,
      configId: config.configId,
      promptVersion: config.promptVersion,
      priceSnapshot: (modelIds) => registry.snapshot(modelIds),
    }),
  };
}

async function loadConfigAndRegistry(
  args: string[],
): Promise<CliConfigAndRegistry> {
  const configPath = readOption(args, "--config");
  const config = await loadConfig(configPath);
  const modelsFile =
    readOption(args, "--models") ?? ".frugal-fusion/models.json";
  const registry = ModelRegistry.fromJson(await readFile(modelsFile, "utf8"));
  return {
    config,
    registry,
    configSourceKind:
      configPath === undefined ? "default_config" : "config_file",
  };
}

async function rejectPreflightOutputInputAliases(
  preflightOut: string,
  args: string[],
  paths: { caseFile: string; caseManifest?: string },
): Promise<void> {
  const inputPaths = [
    paths.caseFile,
    paths.caseManifest,
    readOption(args, "--models") ?? ".frugal-fusion/models.json",
    readOption(args, "--config"),
  ].filter((path): path is string => path !== undefined);
  for (const inputPath of inputPaths) {
    if (await sameOutputPath(preflightOut, inputPath)) {
      throw new Error(
        "--preflight-out must not refer to an input case, manifest, model, or config file",
      );
    }
  }
}

function requireApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
  return apiKey;
}

function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function hasOption(args: string[], option: string): boolean {
  return args.includes(option);
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isHelpRequested(args: string[]): boolean {
  return args.some(isHelpFlag);
}

function readIntegerOption(args: string[], option: string): number | undefined {
  const value = readOption(args, option);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new Error(`${option} must be an integer`);
  return parsed;
}

function readNumberOption(args: string[], option: string): number | undefined {
  const value = readOption(args, option);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${option} must be a finite number`);
  return parsed;
}

function requireNonNegativeIntegerOption(
  args: string[],
  option: string,
): number {
  const parsed = readIntegerOption(args, option);
  if (parsed === undefined) {
    throw new Error(`${option} requires a value`);
  }
  if (parsed < 0) throw new Error(`${option} must be non-negative`);
  return parsed;
}

function requireNonNegativeNumberOption(
  args: string[],
  option: string,
): number {
  const parsed = readNumberOption(args, option);
  if (parsed === undefined) {
    throw new Error(`${option} requires a value`);
  }
  if (parsed < 0) throw new Error(`${option} must be non-negative`);
  return parsed;
}

function readEvalTrialsPerCase(args: string[]): number {
  const trials = readIntegerOption(args, "--trials") ?? 1;
  if (trials < 1 || trials > 100) {
    throw new Error("--trials must be between 1 and 100");
  }
  return trials;
}

function readPreflightGuards(
  args: string[],
): NonNullable<Parameters<typeof buildEvalPreflightPlan>[0]["guards"]> {
  return {
    ...(readIntegerOption(args, "--max-planned-call-attempts") === undefined
      ? {}
      : {
          maxPlannedCallAttempts: requireNonNegativeIntegerOption(
            args,
            "--max-planned-call-attempts",
          ),
        }),
    ...(readNumberOption(args, "--max-planned-completion-cost-usd") ===
    undefined
      ? {}
      : {
          maxPlannedCompletionCostUsd: requireNonNegativeNumberOption(
            args,
            "--max-planned-completion-cost-usd",
          ),
        }),
  };
}

function sanitizePreflightPlanningError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.startsWith("Preflight guard failed:")) return error;
    if (error.message.startsWith("--trials")) return error;
  }
  return new Error(
    "Preflight model snapshot, budget, or planning inputs are invalid",
  );
}

function readModeOption(
  args: string[],
  option: string,
): DeliberationRequest["mode"] | undefined {
  const mode = readOption(args, option);
  if (mode === undefined) return undefined;
  if (
    mode !== "auto" &&
    mode !== "direct" &&
    mode !== "self_review" &&
    mode !== "repeated" &&
    mode !== "fusion"
  ) {
    throw new Error(
      `${option} must be auto, direct, self_review, repeated, or fusion`,
    );
  }
  return mode;
}

function readManifestHmacKey(envName: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(
      "--manifest-hmac-key-env must name an environment variable",
    );
  }
  const key = process.env[envName];
  if (key === undefined) throw new Error("Manifest HMAC key is required");
  if (key.trim().length === 0 || Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("Manifest HMAC key must be at least 32 bytes");
  }
  return key;
}

function rejectHmacDisclosureFlags(args: string[]): void {
  if (
    hasOption(args, "--source-label") ||
    hasOption(args, "--public-case-ids") ||
    hasOption(args, "--public-category-labels") ||
    hasOption(args, "--private")
  ) {
    throw new Error(
      "HMAC manifests do not allow source labels, public case IDs, public category labels, or private summaries",
    );
  }
}

function rejectClaimGateDisclosureFlags(args: string[]): void {
  if (
    hasOption(args, "--source-label") ||
    hasOption(args, "--public-case-ids") ||
    hasOption(args, "--public-category-labels")
  ) {
    throw new Error(
      "Claim gates do not allow source labels, public case IDs, or public category labels",
    );
  }
}

function readManifestIntendedUse(args: string[]): EvalCaseManifestIntendedUse {
  const intendedUse = readOption(args, "--intended-use") ?? "dev";
  if (
    intendedUse !== "dev" &&
    intendedUse !== "public_sample" &&
    intendedUse !== "holdout"
  ) {
    throw new Error("--intended-use must be dev, public_sample, or holdout");
  }
  return intendedUse;
}

function readClaimGateTarget(args: string[]): EvalClaimGateTarget | undefined {
  const target = readOption(args, "--claim-gate");
  if (target === undefined) return undefined;
  if (target !== "public_cost_performance") {
    throw new Error("--claim-gate must be public_cost_performance");
  }
  return target;
}

function requireManifestHashAlgorithm(
  algorithm: EvalClaimGateManifestHashAlgorithm | undefined,
): EvalClaimGateManifestHashAlgorithm {
  if (algorithm === undefined) {
    throw new Error("Internal error: manifest hash algorithm was not resolved");
  }
  return algorithm;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function canonicalOutputPath(
  path: string,
  symlinkDepth = 0,
): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    // The output file may not exist yet.
  }
  if (symlinkDepth < 8) {
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        return await canonicalOutputPath(
          resolve(dirname(absolute), target),
          symlinkDepth + 1,
        );
      }
    } catch {
      // The output path may not exist yet or may be an unresolvable symlink.
    }
  }
  let parent = dirname(absolute);
  try {
    parent = await realpath(parent);
  } catch {
    // The output directory may not exist yet; the resolved parent is still a
    // stable enough guard for ordinary relative-path aliases.
  }
  return join(parent, basename(absolute));
}

async function sameOutputPath(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    canonicalOutputPath(left),
    canonicalOutputPath(right),
  ]);
  if (leftPath === rightPath) return true;
  try {
    const [leftStat, rightStat] = await Promise.all([
      stat(resolve(left)),
      stat(resolve(right)),
    ]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function publicValidationSummary(
  summary: EvalCaseValidationSummary,
  claimGate?: EvalClaimGateAssessment,
): unknown {
  const categoryCounts = Object.values(summary.categoryCounts);
  const scoredCategoryCounts = Object.values(summary.scoredCategoryCounts);
  const output = {
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
    categoryDifficultyCoverage: claimGate?.categoryDifficultyCoverage ?? null,
    difficultyCoverage: {
      difficultyCounts: summary.difficultyCounts,
      scoredDifficultyCounts: summary.scoredDifficultyCounts,
      scoredCasesMissingDifficultyCount:
        summary.scoredCasesMissingDifficultyCount,
      smokeOnlyCasesMissingDifficultyCount:
        summary.smokeOnlyCasesMissingDifficultyCount,
    },
    graderKindCounts: summary.graderKindCounts,
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
    privacy: {
      categoryLabels: "omitted",
      usePrivateFlagForLocalTaxonomy: true,
    },
  };
  if (claimGate !== undefined) {
    return {
      ...output,
      claimGate,
    };
  }
  return output;
}

function publicClaimGateInputFailure(target: EvalClaimGateTarget): unknown {
  return {
    claimGate: {
      target,
      scope: "case_set_only",
      status: "case_set_blocked",
      overallClaimStatus: "external_evidence_required",
      blockers: [
        {
          code: "case_file_parse_or_validation_failed",
          message:
            "The case file could not be parsed or validated. Details are omitted in claim-gate mode to keep CI output public-safe.",
        },
      ],
      warnings: [
        {
          code: "no_spend_case_set_only",
          message:
            "This gate checks only case-set hygiene before spend; it cannot approve public performance claims, model outputs, pricing, or tuning isolation.",
        },
      ],
      externalEvidenceRequired: [
        {
          code: "valid_case_set_required",
          message:
            "Fix the case file locally, then rerun the public claim gate.",
        },
      ],
    },
  };
}

function topLevelHelpText(): string {
  return `Usage:
  pnpm tsx src/cli.ts models --out .frugal-fusion/models.json
  pnpm tsx src/cli.ts ask "task" --mode fusion --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json
  pnpm tsx src/cli.ts validate-cases examples/cases.public.jsonl [--private] [--allow-smoke-only] [--claim-gate public_cost_performance] [--manifest-out examples/cases.public.manifest.json --intended-use public_sample --source-label examples/cases.public.jsonl --public-category-labels --public-case-ids] [--manifest-hmac-key-env FRUGAL_FUSION_MANIFEST_HMAC_KEY]
  pnpm tsx src/cli.ts verify-public-report .frugal-fusion/eval-public.json
  pnpm tsx src/cli.ts eval examples/cases.jsonl --preflight --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json --trials 3 [--preflight-out .frugal-fusion/eval-preflight.json] [--max-planned-call-attempts 1000] [--max-planned-completion-cost-usd 1]
  pnpm tsx src/cli.ts eval examples/cases.jsonl --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json --out .frugal-fusion/eval-result.json --public-out .frugal-fusion/eval-public.json --trials 3 [--case-manifest holdout.manifest.json --case-manifest-hmac-key-env FRUGAL_FUSION_MANIFEST_HMAC_KEY]

Commands:
  models          Fetch and save an OpenRouter model/price snapshot.
  ask             Run one task through direct, self-review, repeated, fusion, or auto mode.
  validate-cases  Validate JSONL evaluation cases and optional manifests without model calls.
  verify-public-report
                  Verify a public report artifact without model calls.
  eval            Run or preflight a JSONL evaluation.

Use "pnpm tsx src/cli.ts <command> --help" for command-specific help.`;
}

function modelsHelpText(): string {
  return `Usage:
  pnpm tsx src/cli.ts models [--out .frugal-fusion/models.json]

Fetch current OpenRouter model metadata and write a local model/price snapshot.
Requires OPENROUTER_API_KEY for fetching; help never requires an API key.

Options:
  --out <path>  Snapshot output path. Defaults to .frugal-fusion/models.json.`;
}

function askHelpText(): string {
  return `Usage:
  pnpm tsx src/cli.ts ask "task" [--mode fusion] --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json

Run one task through Frugal Fusion and print the full result JSON.

Options:
  --mode <mode>    One of auto, direct, self_review, repeated, or fusion. Defaults to fusion.
  --models <path>  Model/price snapshot path. Defaults to .frugal-fusion/models.json.
  --config <path>  Optional config path. Defaults to the built-in config.`;
}

function validateCasesHelpText(): string {
  return `Usage:
  pnpm tsx src/cli.ts validate-cases <cases.jsonl> [--private] [--allow-smoke-only]
  pnpm tsx src/cli.ts validate-cases <cases.jsonl> --manifest-out <manifest.json> [--intended-use dev|public_sample|holdout] [--manifest-hmac-key-env ENV]
  pnpm tsx src/cli.ts validate-cases <cases.jsonl> --claim-gate public_cost_performance

Validate evaluation cases without an API key, model snapshot, network calls, or model spend.

Options:
  --private                         Include local-only category labels in the validation summary.
  --allow-smoke-only                Allow files with no scored cases.
  --claim-gate public_cost_performance
                                    Emit a public-safe no-spend claim-gate assessment.
  --manifest-out <path>             Write a case-set manifest.
  --intended-use <value>            dev, public_sample, or holdout. Defaults to dev unless a manifest or claim gate is requested.
  --manifest-hmac-key-env <env>     Read a private-audit manifest HMAC key from an environment variable.
  --source-label <label>            Include a non-HMAC public source label.
  --public-category-labels          Include category labels in a non-HMAC public manifest.
  --public-case-ids                 Include case IDs in a non-HMAC public manifest.`;
}

function verifyPublicReportHelpText(): string {
  return `Usage:
  pnpm tsx src/cli.ts verify-public-report <public-report.json>

Verify a public evaluation report without an API key, model snapshot, network calls, or model spend.

Exits 0 when the public artifact shape is supported, public case outcomes match aggregate metrics, the embedded claimGate exactly matches the current recomputed public claim gate, and the recomputed gate has no blockers.
Exits 2 with public-safe JSON when the report is stale, malformed, blocked, or mismatched.`;
}

function evalHelpText(): string {
  return `Usage:
  pnpm tsx src/cli.ts eval <cases.jsonl> --preflight --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json [--preflight-out .frugal-fusion/eval-preflight.json]
  pnpm tsx src/cli.ts eval <cases.jsonl> --models .frugal-fusion/models.json --config examples/frugal-fusion.config.json --out .frugal-fusion/eval-result.json [--public-out .frugal-fusion/eval-public.json]

Run or preflight an evaluation over direct, self_review, repeated, and fusion configs.

Options:
  --preflight                         Plan call counts and conservative completion-token cost without API key or model calls.
  --preflight-out <path>              Write the preflight JSON.
  --max-planned-call-attempts <n>     Fail preflight when planned call attempts exceed n.
  --max-planned-completion-cost-usd <n>
                                      Fail preflight when completion-token upper bound exceeds n.
  --models <path>                     Model/price snapshot path. Defaults to .frugal-fusion/models.json.
  --config <path>                     Optional config path. Defaults to the built-in config.
  --out <path>                        Private evaluation report path. Defaults to .frugal-fusion/eval-result.json.
  --public-out <path>                 Public allowlisted report path.
  --trials <n>                        Trials per case. Defaults to 1.
  --bootstrap-samples <n>             Bootstrap resamples for confidence intervals. Defaults to 500.
  --case-manifest <path>              Verify and bind a frozen case-set manifest before spend.
  --case-manifest-hmac-key-env <env>  Read the holdout manifest HMAC key from an environment variable.`;
}

function usage(): never {
  throw new Error(topLevelHelpText());
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
