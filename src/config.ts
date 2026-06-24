import { readFile } from "node:fs/promises";
import type {
  Budget,
  ModelRoleConfig,
  ProviderPolicy,
  SamplingConfig,
  SamplingParams,
} from "./types.js";
import { PROMPT_VERSION } from "./promptContract.js";

export type FrugalFusionConfig = {
  configId: string;
  promptVersion: string;
  models: ModelRoleConfig;
  budget: Budget;
  provider: ProviderPolicy;
  sampling: SamplingConfig;
  retainRawPrompt: boolean;
  retainOutputs: boolean;
  retainProviderIds: boolean;
};

export const DEFAULT_CONFIG: FrugalFusionConfig = {
  configId: "local-default-v1",
  promptVersion: PROMPT_VERSION,
  models: {
    directModelId: "google/gemini-2.0-flash-001",
    selfReviewModelId: "google/gemini-2.0-flash-001",
    repeatedModelId: "google/gemini-2.0-flash-001",
    candidateModels: [
      "google/gemini-2.0-flash-001",
      "qwen/qwen-2.5-72b-instruct",
    ],
    aggregatorModelId: "google/gemini-2.0-flash-001",
  },
  budget: {
    maxCostUsd: 0.05,
    maxLatencyMs: 45_000,
    maxCandidates: 2,
    maxCompletionTokens: 900,
    maxRepairRounds: 1,
  },
  provider: {
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: "deny",
    zdr: false,
  },
  sampling: {
    rootSeed: 1729,
    sendSeeds: false,
    direct: { temperature: 0.2, topP: 1 },
    selfReviewDraft: { temperature: 0.2, topP: 1 },
    selfReviewFinal: { temperature: 0.1, topP: 1 },
    repeatedSample: { temperature: 0.7, topP: 1 },
    fusionCandidate: { temperature: 0.5, topP: 1 },
    aggregator: { temperature: 0.1, topP: 1 },
  },
  retainRawPrompt: false,
  retainOutputs: false,
  retainProviderIds: false,
};

export async function loadConfig(path?: string): Promise<FrugalFusionConfig> {
  if (!path) return DEFAULT_CONFIG;
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Config must be a JSON object");
  requireOptionalObject(parsed, "models");
  requireOptionalObject(parsed, "budget");
  requireOptionalObject(parsed, "provider");
  requireOptionalObject(parsed, "sampling");
  const config: FrugalFusionConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    models: {
      ...DEFAULT_CONFIG.models,
      ...(isRecord(parsed.models) ? parsed.models : {}),
    },
    budget: {
      ...DEFAULT_CONFIG.budget,
      ...(isRecord(parsed.budget) ? parsed.budget : {}),
    },
    provider: {
      ...DEFAULT_CONFIG.provider,
      ...(isRecord(parsed.provider) ? parsed.provider : {}),
    },
    sampling: {
      ...DEFAULT_CONFIG.sampling,
      ...(isRecord(parsed.sampling) ? parsed.sampling : {}),
    },
  };
  validateConfig(config);
  return config;
}

function requireOptionalObject(
  parsed: Record<string, unknown>,
  key: string,
): void {
  if (key in parsed && !isRecord(parsed[key])) {
    throw new Error(`${key} must be an object when provided`);
  }
}

export function validateConfig(config: FrugalFusionConfig): void {
  requireString(config.configId, "configId");
  requireString(config.promptVersion, "promptVersion");
  if (config.promptVersion !== PROMPT_VERSION) {
    throw new Error(
      `promptVersion must match active prompt contract ${PROMPT_VERSION}`,
    );
  }
  validateModelRoleConfig(config.models);
  validateBudget(config.budget);
  validateProvider(config.provider);
  validateSamplingConfig(config.sampling);
  requireBoolean(config.retainRawPrompt, "retainRawPrompt");
  requireBoolean(config.retainOutputs, "retainOutputs");
  requireBoolean(config.retainProviderIds, "retainProviderIds");
}

export function validateModelRoleConfig(models: ModelRoleConfig): void {
  requireString(models.directModelId, "models.directModelId");
  requireString(models.selfReviewModelId, "models.selfReviewModelId");
  requireString(models.repeatedModelId, "models.repeatedModelId");
  requireString(models.aggregatorModelId, "models.aggregatorModelId");
  if (
    !Array.isArray(models.candidateModels) ||
    models.candidateModels.length !== 2
  ) {
    throw new Error(
      "models.candidateModels must contain exactly two model ids",
    );
  }
  requireString(models.candidateModels[0], "models.candidateModels[0]");
  requireString(models.candidateModels[1], "models.candidateModels[1]");
  validateFixedBaselineModelId(models.directModelId, "models.directModelId");
  validateFixedBaselineModelId(
    models.selfReviewModelId,
    "models.selfReviewModelId",
  );
  validateFixedBaselineModelId(
    models.repeatedModelId,
    "models.repeatedModelId",
  );
  validateFixedBaselineModelId(
    models.candidateModels[0],
    "models.candidateModels[0]",
  );
  validateFixedBaselineModelId(
    models.candidateModels[1],
    "models.candidateModels[1]",
  );
  validateFixedBaselineModelId(
    models.aggregatorModelId,
    "models.aggregatorModelId",
  );
  if (models.candidateModels[0] === models.candidateModels[1]) {
    throw new Error(
      "models.candidateModels must contain two distinct model ids",
    );
  }
  if (models.selfReviewModelId !== models.directModelId) {
    throw new Error(
      "self_review baseline requires models.selfReviewModelId to equal directModelId",
    );
  }
  if (models.repeatedModelId !== models.directModelId) {
    throw new Error(
      "repeated baseline requires models.repeatedModelId to equal directModelId",
    );
  }
}

function validateFixedBaselineModelId(modelId: string, path: string): void {
  const normalized = modelId.trim().toLowerCase();
  const managedRouterAliases = new Set([
    "openrouter/auto",
    "openrouter/bodybuilder",
    "openrouter/free",
    "openrouter/fusion",
    "openrouter/pareto-code",
  ]);
  let disallowedReason: string | undefined;
  if (managedRouterAliases.has(normalized)) {
    disallowedReason = "managed OpenRouter router aliases";
  } else if (normalized.startsWith("~")) {
    disallowedReason = "latest-resolution aliases";
  } else if (normalized.includes(":")) {
    disallowedReason = "OpenRouter model variant suffixes";
  }
  if (disallowedReason) {
    throw new Error(
      `${path} must be a concrete model id for fixed-baseline evaluation; ${disallowedReason} belong in a separately labeled external-reference run`,
    );
  }
}

function validateBudget(budget: Budget): void {
  requirePositiveFinite(budget.maxCostUsd, "budget.maxCostUsd");
  requirePositiveFinite(budget.maxLatencyMs, "budget.maxLatencyMs");
  requirePositiveInteger(budget.maxCandidates, "budget.maxCandidates");
  requirePositiveInteger(
    budget.maxCompletionTokens,
    "budget.maxCompletionTokens",
  );
  requireNonNegativeInteger(budget.maxRepairRounds, "budget.maxRepairRounds");
  if (budget.maxRepairRounds > 1)
    throw new Error("budget.maxRepairRounds cannot exceed 1 in the MVP");
}

function validateProvider(provider: ProviderPolicy): void {
  if (provider.allow_fallbacks !== undefined)
    requireBoolean(provider.allow_fallbacks, "provider.allow_fallbacks");
  if (provider.require_parameters !== undefined)
    requireBoolean(provider.require_parameters, "provider.require_parameters");
  if (provider.zdr !== undefined) requireBoolean(provider.zdr, "provider.zdr");
  if (provider.order !== undefined)
    validateProviderSlugList(provider.order, "provider.order");
  if (
    provider.data_collection !== undefined &&
    provider.data_collection !== "allow" &&
    provider.data_collection !== "deny"
  ) {
    throw new Error('provider.data_collection must be "allow" or "deny"');
  }
}

function validateProviderSlugList(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of provider slugs`);
  }
  const seen = new Set<string>();
  for (const [index, slug] of value.entries()) {
    const slugPath = `${path}[${index}]`;
    requireString(slug, slugPath);
    if (slug !== slug.trim()) {
      throw new Error(`${slugPath} must not include leading or trailing space`);
    }
    if (!/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(slug)) {
      throw new Error(
        `${slugPath} must be a lowercase OpenRouter provider slug`,
      );
    }
    if (seen.has(slug)) {
      throw new Error(`${path} must not include duplicate provider slugs`);
    }
    seen.add(slug);
  }
}

function validateSamplingConfig(sampling: SamplingConfig): void {
  if (sampling.rootSeed !== undefined)
    requireNonNegativeInteger(sampling.rootSeed, "sampling.rootSeed");
  if (sampling.sendSeeds !== undefined)
    requireBoolean(sampling.sendSeeds, "sampling.sendSeeds");
  validateSamplingParams(sampling.direct, "sampling.direct");
  validateSamplingParams(sampling.selfReviewDraft, "sampling.selfReviewDraft");
  validateSamplingParams(sampling.selfReviewFinal, "sampling.selfReviewFinal");
  validateSamplingParams(sampling.repeatedSample, "sampling.repeatedSample");
  validateSamplingParams(sampling.fusionCandidate, "sampling.fusionCandidate");
  validateSamplingParams(sampling.aggregator, "sampling.aggregator");
}

function validateSamplingParams(
  params: SamplingParams | undefined,
  path: string,
): void {
  if (params === undefined) return;
  if (!isRecord(params)) throw new Error(`${path} must be an object`);
  if (params.temperature !== undefined) {
    requireFinite(params.temperature, `${path}.temperature`);
    if (params.temperature < 0 || params.temperature > 2)
      throw new Error(`${path}.temperature must be between 0 and 2`);
  }
  if (params.topP !== undefined) {
    requireFinite(params.topP, `${path}.topP`);
    if (params.topP <= 0 || params.topP > 1)
      throw new Error(`${path}.topP must be greater than 0 and at most 1`);
  }
  if (params.seed !== undefined)
    requireNonNegativeInteger(params.seed, `${path}.seed`);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function requireBoolean(
  value: unknown,
  path: string,
): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
}

function requireFinite(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
}

function requirePositiveFinite(
  value: unknown,
  path: string,
): asserts value is number {
  requireFinite(value, path);
  if (value <= 0) throw new Error(`${path} must be positive`);
}

function requirePositiveInteger(
  value: unknown,
  path: string,
): asserts value is number {
  requireNonNegativeInteger(value, path);
  if (value <= 0) throw new Error(`${path} must be positive`);
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
