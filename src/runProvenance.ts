import { createHash } from "node:crypto";
import type { FrugalFusionConfig } from "./config.js";
import {
  OPENROUTER_FIXED_BASELINE_ALLOWED_STRATEGIES,
  OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_NAMES,
  OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_TYPES,
  OPENROUTER_FIXED_BASELINE_DISABLED_PLUGIN_IDS,
  OPENROUTER_METADATA_HEADER,
} from "./openRouterPolicy.js";
import type {
  DeliberationMode,
  ModelRoleConfig,
  PriceSnapshotEntry,
  ProviderPolicy,
  SamplingConfig,
  SamplingParams,
} from "./types.js";

const RUN_PROVENANCE_SCHEMA_VERSION = "frugal-fusion-run-provenance-v2";
const RUN_PROVENANCE_FINGERPRINT_VERSION = "run-provenance-v2";
const RESOLVED_CONFIG_CONTENT = "resolved-frugal-fusion-config-v2";
const OPENROUTER_PROVIDER_ROUTING_CONTENT =
  "openrouter-provider-routing-policy-v1";

export type RunProvenanceSourceKind =
  | "default_config"
  | "config_file"
  | "models_file"
  | "caller_provided";

export type ProviderEndpointPinningStatus =
  | "single_provider_endpoint_pinned"
  | "not_configured"
  | "fallbacks_allowed"
  | "multiple_provider_endpoints_allowed"
  | "base_provider_slug_only";

export type EvalRunProvenance = {
  schemaVersion: typeof RUN_PROVENANCE_SCHEMA_VERSION;
  fingerprintVersion: typeof RUN_PROVENANCE_FINGERPRINT_VERSION;
  canonicalization: "json-sorted-v1";
  evaluatedConfigs: DeliberationMode[];
  invocation?: EvalRunInvocationProvenance;
  openRouterRequestPolicy?: EvalRunOpenRouterRequestPolicyProvenance;
  providerRouting: EvalRunProviderRoutingProvenance;
  config: {
    status: "private_report_bound";
    sourceKind: Extract<
      RunProvenanceSourceKind,
      "default_config" | "config_file" | "caller_provided"
    >;
    content: typeof RESOLVED_CONFIG_CONTENT;
    resolvedConfigDigest: {
      algorithm: "sha256";
      sha256: string;
      digestDisclosure: "private_report_only";
    };
    pathDisclosure: "omitted";
  };
  modelPriceSnapshot: {
    status: "private_report_bound";
    sourceKind: Extract<
      RunProvenanceSourceKind,
      "models_file" | "caller_provided"
    >;
    content: "effective-model-price-snapshot-v1";
    effectiveModelCount: number;
    effectivePriceSnapshotDigest: {
      algorithm: "sha256";
      sha256: string;
      digestDisclosure: "private_report_only";
    };
    pathDisclosure: "omitted";
  };
};

export type EvalRunProviderRoutingProvenance = {
  status: "private_report_bound";
  content: typeof OPENROUTER_PROVIDER_ROUTING_CONTENT;
  providerEndpointPinning: ProviderEndpointPinningStatus;
  allowFallbacks: boolean | null;
  orderedProviderSlugs: string[];
  orderSlugCount: number;
  fullEndpointSlugCount: number;
  detailDisclosure: "private_report_only";
};

export type EvalRunOpenRouterRequestPolicyProvenance = {
  status: "private_report_bound";
  content: "openrouter-fixed-baseline-request-policy-v1";
  disabledDefaultPluginIds: Array<
    (typeof OPENROUTER_FIXED_BASELINE_DISABLED_PLUGIN_IDS)[number]
  >;
  metadataHeader: {
    name: typeof OPENROUTER_METADATA_HEADER.name;
    value: typeof OPENROUTER_METADATA_HEADER.value;
  };
  metadataRequiredOnSuccessfulResponse: true;
  allowedStrategies: Array<
    (typeof OPENROUTER_FIXED_BASELINE_ALLOWED_STRATEGIES)[number]
  >;
  missingStrategyPolicy: "fail_closed";
  unknownStrategyPolicy: "fail_closed";
  blockedPipelineStageTypes: Array<
    (typeof OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_TYPES)[number]
  >;
  blockedPipelineStageNames: Array<
    (typeof OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_NAMES)[number]
  >;
  missingPipelineStageFieldPolicy: "fail_closed";
  unknownPipelineStagePolicy: "fail_closed";
  cacheHitPolicy: "metadata_still_required";
  requestPolicyDigest: {
    algorithm: "sha256";
    sha256: string;
    digestDisclosure: "private_report_only";
  };
};

export type EvalRunInvocationProvenance = {
  assertion: "self_reported_private_metadata";
  content: "normalized-cli-invocation-v1";
  interface: "cli_eval";
  command: "eval";
  rawArgvDisclosure: "omitted";
  pathDisclosure: "omitted";
  environmentDisclosure: "omitted";
  caseSource: {
    sourceKind: "jsonl_file";
    pathDisclosure: "omitted";
  };
};

export type EvalRunProvenanceInput = {
  config: FrugalFusionConfig;
  configs: DeliberationMode[];
  configSourceKind: EvalRunProvenance["config"]["sourceKind"];
  modelPriceEntries: PriceSnapshotEntry[];
  modelSnapshotSourceKind: EvalRunProvenance["modelPriceSnapshot"]["sourceKind"];
  invocation?: EvalRunInvocationProvenance;
};

export function buildEvalRunProvenance(
  input: EvalRunProvenanceInput,
): EvalRunProvenance {
  const configs = validateConfigs(input.configs);
  const expectedModelIds = modelIdsForRunProvenance(
    input.config.models,
    configs,
  );
  const effectiveModelEntries = effectivePriceSnapshotEntries(
    input.modelPriceEntries,
    expectedModelIds,
  );
  const invocation = normalizeRunInvocationProvenance(input.invocation);
  const openRouterRequestPolicy = buildOpenRouterRequestPolicyProvenance();
  const providerRouting = buildProviderRoutingProvenance(input.config.provider);
  return {
    schemaVersion: RUN_PROVENANCE_SCHEMA_VERSION,
    fingerprintVersion: RUN_PROVENANCE_FINGERPRINT_VERSION,
    canonicalization: "json-sorted-v1",
    evaluatedConfigs: configs,
    ...(invocation === undefined ? {} : { invocation }),
    openRouterRequestPolicy,
    providerRouting,
    config: {
      status: "private_report_bound",
      sourceKind: input.configSourceKind,
      content: RESOLVED_CONFIG_CONTENT,
      resolvedConfigDigest: {
        algorithm: "sha256",
        sha256: hashCanonical({
          fingerprintVersion: RUN_PROVENANCE_FINGERPRINT_VERSION,
          content: RESOLVED_CONFIG_CONTENT,
          evaluatedConfigs: configs,
          config: canonicalResolvedConfig(input.config, configs),
        }),
        digestDisclosure: "private_report_only",
      },
      pathDisclosure: "omitted",
    },
    modelPriceSnapshot: {
      status: "private_report_bound",
      sourceKind: input.modelSnapshotSourceKind,
      content: "effective-model-price-snapshot-v1",
      effectiveModelCount: effectiveModelEntries.length,
      effectivePriceSnapshotDigest: {
        algorithm: "sha256",
        sha256: hashCanonical({
          fingerprintVersion: RUN_PROVENANCE_FINGERPRINT_VERSION,
          content: "effective-model-price-snapshot-v1",
          evaluatedConfigs: configs,
          entries: effectiveModelEntries,
        }),
        digestDisclosure: "private_report_only",
      },
      pathDisclosure: "omitted",
    },
  };
}

export function normalizeEvalRunProvenance(
  provenance: EvalRunProvenance,
): EvalRunProvenance {
  if (!isRecord(provenance)) {
    throw new Error("Invalid runProvenance metadata");
  }
  const hasInvocation = hasOwn(provenance, "invocation");
  const hasOpenRouterRequestPolicy = hasOwn(
    provenance,
    "openRouterRequestPolicy",
  );
  if (hasInvocation && provenance.invocation === undefined) {
    throw new Error("Invalid runProvenance.invocation metadata");
  }
  if (
    hasOpenRouterRequestPolicy &&
    provenance.openRouterRequestPolicy === undefined
  ) {
    throw new Error("Invalid runProvenance.openRouterRequestPolicy metadata");
  }
  const rootKeys = [
    "schemaVersion",
    "fingerprintVersion",
    "canonicalization",
    "evaluatedConfigs",
    "config",
    "modelPriceSnapshot",
    "providerRouting",
    ...(hasInvocation ? ["invocation"] : []),
    ...(hasOpenRouterRequestPolicy ? ["openRouterRequestPolicy"] : []),
  ];
  if (!hasExactKeys(provenance, rootKeys)) {
    throw new Error("Invalid runProvenance metadata keys");
  }
  if (
    provenance.schemaVersion !== RUN_PROVENANCE_SCHEMA_VERSION ||
    provenance.fingerprintVersion !== RUN_PROVENANCE_FINGERPRINT_VERSION ||
    provenance.canonicalization !== "json-sorted-v1"
  ) {
    throw new Error("Invalid runProvenance metadata");
  }
  const evaluatedConfigs = validateConfigs(
    provenance.evaluatedConfigs as DeliberationMode[],
  );
  const invocation = normalizeRunInvocationProvenance(provenance.invocation);
  const openRouterRequestPolicy = hasOpenRouterRequestPolicy
    ? normalizeOpenRouterRequestPolicyProvenance(
        provenance.openRouterRequestPolicy,
      )
    : undefined;
  return {
    schemaVersion: RUN_PROVENANCE_SCHEMA_VERSION,
    fingerprintVersion: RUN_PROVENANCE_FINGERPRINT_VERSION,
    canonicalization: "json-sorted-v1",
    evaluatedConfigs,
    ...(invocation === undefined ? {} : { invocation }),
    ...(openRouterRequestPolicy === undefined
      ? {}
      : { openRouterRequestPolicy }),
    providerRouting: normalizeProviderRoutingProvenance(
      provenance.providerRouting,
    ),
    config: normalizeConfigProvenance(provenance.config),
    modelPriceSnapshot: normalizeModelPriceSnapshotProvenance(
      provenance.modelPriceSnapshot,
    ),
  };
}

export function cliEvalInvocationProvenance(): EvalRunInvocationProvenance {
  return {
    assertion: "self_reported_private_metadata",
    content: "normalized-cli-invocation-v1",
    interface: "cli_eval",
    command: "eval",
    rawArgvDisclosure: "omitted",
    pathDisclosure: "omitted",
    environmentDisclosure: "omitted",
    caseSource: {
      sourceKind: "jsonl_file",
      pathDisclosure: "omitted",
    },
  };
}

export function normalizeRunInvocationProvenance(
  invocation: EvalRunInvocationProvenance | undefined,
): EvalRunInvocationProvenance | undefined {
  if (invocation === undefined) return undefined;
  const expected = cliEvalInvocationProvenance();
  if (!isRecord(invocation)) {
    throw new Error("Invalid runProvenance.invocation metadata");
  }
  if (!hasExactKeys(invocation, Object.keys(expected))) {
    throw new Error("Invalid runProvenance.invocation metadata keys");
  }
  if (
    invocation.assertion !== expected.assertion ||
    invocation.content !== expected.content ||
    invocation.interface !== expected.interface ||
    invocation.command !== expected.command ||
    invocation.rawArgvDisclosure !== expected.rawArgvDisclosure ||
    invocation.pathDisclosure !== expected.pathDisclosure ||
    invocation.environmentDisclosure !== expected.environmentDisclosure
  ) {
    throw new Error("Invalid runProvenance.invocation metadata");
  }
  if (
    !isRecord(invocation.caseSource) ||
    !hasExactKeys(invocation.caseSource, Object.keys(expected.caseSource)) ||
    invocation.caseSource.sourceKind !== expected.caseSource.sourceKind ||
    invocation.caseSource.pathDisclosure !== expected.caseSource.pathDisclosure
  ) {
    throw new Error("Invalid runProvenance.invocation.caseSource metadata");
  }
  return expected;
}

function buildOpenRouterRequestPolicyProvenance(): EvalRunOpenRouterRequestPolicyProvenance {
  const policy = canonicalOpenRouterRequestPolicyFields();
  return {
    ...policy,
    requestPolicyDigest: {
      algorithm: "sha256",
      sha256: openRouterRequestPolicyDigest(policy),
      digestDisclosure: "private_report_only",
    },
  };
}

function buildProviderRoutingProvenance(
  provider: ProviderPolicy,
): EvalRunProviderRoutingProvenance {
  const orderedProviderSlugs = provider.order ?? [];
  return {
    status: "private_report_bound",
    content: OPENROUTER_PROVIDER_ROUTING_CONTENT,
    providerEndpointPinning: providerEndpointPinningStatus(provider),
    allowFallbacks: provider.allow_fallbacks ?? null,
    orderedProviderSlugs: [...orderedProviderSlugs],
    orderSlugCount: orderedProviderSlugs.length,
    fullEndpointSlugCount: orderedProviderSlugs.filter(
      isFullProviderEndpointSlug,
    ).length,
    detailDisclosure: "private_report_only",
  };
}

function normalizeProviderRoutingProvenance(
  value: unknown,
): EvalRunProviderRoutingProvenance {
  if (!isRecord(value)) {
    throw new Error("Invalid runProvenance.providerRouting metadata");
  }
  if (
    !hasExactKeys(value, [
      "status",
      "content",
      "providerEndpointPinning",
      "allowFallbacks",
      "orderedProviderSlugs",
      "orderSlugCount",
      "fullEndpointSlugCount",
      "detailDisclosure",
    ])
  ) {
    throw new Error("Invalid runProvenance.providerRouting metadata keys");
  }
  const allowFallbacks = normalizeOptionalBoolean(
    value.allowFallbacks,
    "runProvenance.providerRouting.allowFallbacks",
  );
  const orderedProviderSlugs = normalizeProviderSlugs(
    value.orderedProviderSlugs,
    "runProvenance.providerRouting.orderedProviderSlugs",
  );
  const orderSlugCount = normalizeNonNegativeSafeInteger(
    value.orderSlugCount,
    "runProvenance.providerRouting.orderSlugCount",
  );
  const fullEndpointSlugCount = normalizeNonNegativeSafeInteger(
    value.fullEndpointSlugCount,
    "runProvenance.providerRouting.fullEndpointSlugCount",
  );
  const routingEvidence: ProviderPolicy = { order: orderedProviderSlugs };
  if (allowFallbacks !== null) {
    routingEvidence.allow_fallbacks = allowFallbacks;
  }
  const expectedProviderEndpointPinning =
    providerEndpointPinningStatus(routingEvidence);
  if (
    value.status !== "private_report_bound" ||
    value.content !== OPENROUTER_PROVIDER_ROUTING_CONTENT ||
    !isOneOf(value.providerEndpointPinning, [
      "single_provider_endpoint_pinned",
      "not_configured",
      "fallbacks_allowed",
      "multiple_provider_endpoints_allowed",
      "base_provider_slug_only",
    ]) ||
    value.providerEndpointPinning !== expectedProviderEndpointPinning ||
    orderSlugCount !== orderedProviderSlugs.length ||
    fullEndpointSlugCount !==
      orderedProviderSlugs.filter(isFullProviderEndpointSlug).length ||
    value.detailDisclosure !== "private_report_only"
  ) {
    throw new Error("Invalid runProvenance.providerRouting metadata");
  }
  return {
    status: "private_report_bound",
    content: OPENROUTER_PROVIDER_ROUTING_CONTENT,
    providerEndpointPinning: value.providerEndpointPinning,
    allowFallbacks,
    orderedProviderSlugs,
    orderSlugCount,
    fullEndpointSlugCount,
    detailDisclosure: "private_report_only",
  };
}

export function providerEndpointPinningStatus(
  provider: ProviderPolicy,
): ProviderEndpointPinningStatus {
  if (provider.allow_fallbacks !== false) return "fallbacks_allowed";
  const order = provider.order;
  if (order === undefined || order.length === 0) return "not_configured";
  if (order.length !== 1) return "multiple_provider_endpoints_allowed";
  return isFullProviderEndpointSlug(order[0] ?? "")
    ? "single_provider_endpoint_pinned"
    : "base_provider_slug_only";
}

function isFullProviderEndpointSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(
    slug,
  );
}

function normalizeOpenRouterRequestPolicyProvenance(
  value: unknown,
): EvalRunOpenRouterRequestPolicyProvenance {
  if (!isRecord(value)) {
    throw new Error("Invalid runProvenance.openRouterRequestPolicy metadata");
  }
  const expected = buildOpenRouterRequestPolicyProvenance();
  if (!hasExactKeys(value, Object.keys(expected))) {
    throw new Error(
      "Invalid runProvenance.openRouterRequestPolicy metadata keys",
    );
  }
  const digest = normalizeSha256Digest(
    value.requestPolicyDigest,
    "runProvenance.openRouterRequestPolicy.requestPolicyDigest",
  );
  const expectedWithoutDigest = canonicalOpenRouterRequestPolicyFields();
  for (const [key, expectedValue] of Object.entries(expectedWithoutDigest)) {
    const actual = value[key];
    if (canonicalJson(actual) !== canonicalJson(expectedValue)) {
      throw new Error("Invalid runProvenance.openRouterRequestPolicy metadata");
    }
  }
  if (digest.sha256 !== expected.requestPolicyDigest.sha256) {
    throw new Error(
      "Invalid runProvenance.openRouterRequestPolicy.requestPolicyDigest metadata",
    );
  }
  return expected;
}

function canonicalOpenRouterRequestPolicyFields(): Omit<
  EvalRunOpenRouterRequestPolicyProvenance,
  "requestPolicyDigest"
> {
  return {
    status: "private_report_bound",
    content: "openrouter-fixed-baseline-request-policy-v1",
    disabledDefaultPluginIds: [
      ...OPENROUTER_FIXED_BASELINE_DISABLED_PLUGIN_IDS,
    ],
    metadataHeader: {
      name: OPENROUTER_METADATA_HEADER.name,
      value: OPENROUTER_METADATA_HEADER.value,
    },
    metadataRequiredOnSuccessfulResponse: true,
    allowedStrategies: [...OPENROUTER_FIXED_BASELINE_ALLOWED_STRATEGIES],
    missingStrategyPolicy: "fail_closed",
    unknownStrategyPolicy: "fail_closed",
    blockedPipelineStageTypes: [
      ...OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_TYPES,
    ],
    blockedPipelineStageNames: [
      ...OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_NAMES,
    ],
    missingPipelineStageFieldPolicy: "fail_closed",
    unknownPipelineStagePolicy: "fail_closed",
    cacheHitPolicy: "metadata_still_required",
  };
}

function openRouterRequestPolicyDigest(
  policy: Omit<EvalRunOpenRouterRequestPolicyProvenance, "requestPolicyDigest">,
): string {
  return hashCanonical({
    fingerprintVersion: RUN_PROVENANCE_FINGERPRINT_VERSION,
    content: policy.content,
    policy,
  });
}

function normalizeConfigProvenance(
  value: unknown,
): EvalRunProvenance["config"] {
  if (!isRecord(value)) {
    throw new Error("Invalid runProvenance.config metadata");
  }
  if (
    !hasExactKeys(value, [
      "status",
      "sourceKind",
      "content",
      "resolvedConfigDigest",
      "pathDisclosure",
    ])
  ) {
    throw new Error("Invalid runProvenance.config metadata keys");
  }
  if (
    value.status !== "private_report_bound" ||
    !isOneOf(value.sourceKind, [
      "default_config",
      "config_file",
      "caller_provided",
    ]) ||
    value.content !== RESOLVED_CONFIG_CONTENT ||
    value.pathDisclosure !== "omitted"
  ) {
    throw new Error("Invalid runProvenance.config metadata");
  }
  return {
    status: "private_report_bound",
    sourceKind: value.sourceKind,
    content: RESOLVED_CONFIG_CONTENT,
    resolvedConfigDigest: normalizeSha256Digest(
      value.resolvedConfigDigest,
      "runProvenance.config.resolvedConfigDigest",
    ),
    pathDisclosure: "omitted",
  };
}

function normalizeModelPriceSnapshotProvenance(
  value: unknown,
): EvalRunProvenance["modelPriceSnapshot"] {
  if (!isRecord(value)) {
    throw new Error("Invalid runProvenance.modelPriceSnapshot metadata");
  }
  if (
    !hasExactKeys(value, [
      "status",
      "sourceKind",
      "content",
      "effectiveModelCount",
      "effectivePriceSnapshotDigest",
      "pathDisclosure",
    ])
  ) {
    throw new Error("Invalid runProvenance.modelPriceSnapshot metadata keys");
  }
  if (
    value.status !== "private_report_bound" ||
    !isOneOf(value.sourceKind, ["models_file", "caller_provided"]) ||
    value.content !== "effective-model-price-snapshot-v1" ||
    typeof value.effectiveModelCount !== "number" ||
    !Number.isSafeInteger(value.effectiveModelCount) ||
    value.effectiveModelCount < 0 ||
    value.pathDisclosure !== "omitted"
  ) {
    throw new Error("Invalid runProvenance.modelPriceSnapshot metadata");
  }
  return {
    status: "private_report_bound",
    sourceKind: value.sourceKind,
    content: "effective-model-price-snapshot-v1",
    effectiveModelCount: value.effectiveModelCount,
    effectivePriceSnapshotDigest: normalizeSha256Digest(
      value.effectivePriceSnapshotDigest,
      "runProvenance.modelPriceSnapshot.effectivePriceSnapshotDigest",
    ),
    pathDisclosure: "omitted",
  };
}

function normalizeSha256Digest(
  value: unknown,
  fieldName: string,
): {
  algorithm: "sha256";
  sha256: string;
  digestDisclosure: "private_report_only";
} {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldName} metadata`);
  }
  if (!hasExactKeys(value, ["algorithm", "sha256", "digestDisclosure"])) {
    throw new Error(`Invalid ${fieldName} metadata keys`);
  }
  if (
    value.algorithm !== "sha256" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.digestDisclosure !== "private_report_only"
  ) {
    throw new Error(`Invalid ${fieldName} metadata`);
  }
  return {
    algorithm: "sha256",
    sha256: value.sha256,
    digestDisclosure: "private_report_only",
  };
}

function normalizeOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${fieldName} metadata`);
  }
  return value;
}

function normalizeNonNegativeSafeInteger(
  value: unknown,
  fieldName: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${fieldName} metadata`);
  }
  return value;
}

function normalizeProviderSlugs(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName} metadata`);
  }
  const slugs: string[] = [];
  for (const [index, slug] of value.entries()) {
    if (typeof slug !== "string" || !isProviderSlug(slug)) {
      throw new Error(`Invalid ${fieldName}[${index}] metadata`);
    }
    slugs.push(slug);
  }
  return slugs;
}

function isProviderSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(slug);
}

export function modelIdsForRunProvenance(
  models: ModelRoleConfig,
  configs: DeliberationMode[],
): string[] {
  const validatedConfigs = validateConfigs(configs);
  const modelIds = new Set<string>();
  for (const config of validatedConfigs) {
    if (config === "direct") {
      modelIds.add(models.directModelId);
    } else if (config === "self_review") {
      modelIds.add(models.directModelId);
      modelIds.add(models.selfReviewModelId);
    } else if (config === "repeated") {
      modelIds.add(models.repeatedModelId);
      modelIds.add(models.aggregatorModelId);
    } else {
      for (const modelId of models.candidateModels) modelIds.add(modelId);
      modelIds.add(models.aggregatorModelId);
    }
  }
  return [...modelIds].sort();
}

function canonicalResolvedConfig(
  config: FrugalFusionConfig,
  configs: DeliberationMode[],
): unknown {
  return {
    configId: config.configId,
    promptVersion: config.promptVersion,
    models: canonicalModelRoles(config.models, configs),
    budget: {
      maxCostUsd: config.budget.maxCostUsd,
      maxLatencyMs: config.budget.maxLatencyMs,
      maxCandidates: config.budget.maxCandidates,
      maxCompletionTokens: config.budget.maxCompletionTokens,
      maxRepairRounds: config.budget.maxRepairRounds,
    },
    provider: definedRecord({
      allow_fallbacks: config.provider.allow_fallbacks,
      require_parameters: config.provider.require_parameters,
      data_collection: config.provider.data_collection,
      zdr: config.provider.zdr,
      order:
        config.provider.order === undefined
          ? undefined
          : [...config.provider.order],
    }),
    sampling: canonicalSamplingConfig(config.sampling, configs),
    retention: {
      retainRawPrompt: config.retainRawPrompt,
      retainOutputs: config.retainOutputs,
      retainProviderIds: config.retainProviderIds,
    },
  };
}

function canonicalModelRoles(
  models: ModelRoleConfig,
  configs: DeliberationMode[],
): unknown {
  const roles: Record<string, unknown> = {};
  if (configs.includes("direct") || configs.includes("self_review")) {
    roles.directModelId = models.directModelId;
  }
  if (configs.includes("self_review")) {
    roles.selfReviewModelId = models.selfReviewModelId;
  }
  if (configs.includes("repeated")) {
    roles.repeatedModelId = models.repeatedModelId;
    roles.aggregatorModelId = models.aggregatorModelId;
  }
  if (configs.includes("fusion")) {
    roles.candidateModels = [...models.candidateModels];
    roles.aggregatorModelId = models.aggregatorModelId;
  }
  return roles;
}

function canonicalSamplingConfig(
  sampling: SamplingConfig,
  configs: DeliberationMode[],
): unknown {
  return definedRecord({
    rootSeed: sampling.rootSeed,
    sendSeeds: sampling.sendSeeds,
    direct: configs.includes("direct")
      ? canonicalSamplingParams(sampling.direct)
      : undefined,
    selfReviewDraft: configs.includes("self_review")
      ? canonicalSamplingParams(sampling.selfReviewDraft)
      : undefined,
    selfReviewFinal: configs.includes("self_review")
      ? canonicalSamplingParams(sampling.selfReviewFinal)
      : undefined,
    repeatedSample: configs.includes("repeated")
      ? canonicalSamplingParams(sampling.repeatedSample)
      : undefined,
    fusionCandidate: configs.includes("fusion")
      ? canonicalSamplingParams(sampling.fusionCandidate)
      : undefined,
    aggregator:
      configs.includes("repeated") || configs.includes("fusion")
        ? canonicalSamplingParams(sampling.aggregator)
        : undefined,
  });
}

function canonicalSamplingParams(params: SamplingParams | undefined): unknown {
  if (params === undefined) return undefined;
  return definedRecord({
    temperature: params.temperature,
    topP: params.topP,
    seed: params.seed,
  });
}

function effectivePriceSnapshotEntries(
  entries: PriceSnapshotEntry[],
  expectedModelIds: string[],
): unknown[] {
  const expected = new Set(expectedModelIds);
  const unique = new Map<string, unknown>();
  const canonicalById = new Map<string, string>();
  for (const entry of entries) {
    if (!expected.has(entry.modelId)) {
      throw new Error(
        `Unexpected run provenance model price entry: ${entry.modelId}`,
      );
    }
    const canonicalEntry = canonicalPriceSnapshotEntry(entry);
    const canonical = canonicalJson(canonicalEntry);
    const existing = canonicalById.get(entry.modelId);
    if (existing !== undefined && existing !== canonical) {
      throw new Error(
        `Conflicting run provenance model price entry: ${entry.modelId}`,
      );
    }
    canonicalById.set(entry.modelId, canonical);
    unique.set(entry.modelId, canonicalEntry);
  }
  for (const modelId of expectedModelIds) {
    if (!unique.has(modelId)) {
      throw new Error(`Missing run provenance model price entry: ${modelId}`);
    }
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}

function canonicalPriceSnapshotEntry(entry: PriceSnapshotEntry): unknown {
  return definedRecord({
    modelId: entry.modelId,
    name: entry.name,
    provider: entry.provider,
    supportedParameters:
      entry.supportedParameters === undefined
        ? undefined
        : [...entry.supportedParameters].sort(),
    promptPriceUsdPerToken: entry.promptPriceUsdPerToken,
    completionPriceUsdPerToken: entry.completionPriceUsdPerToken,
    fetchedAt: entry.fetchedAt,
    source: entry.source,
  });
}

function definedRecord(
  record: Record<string, unknown | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateConfigs(configs: DeliberationMode[]): DeliberationMode[] {
  const valid = new Set<DeliberationMode>([
    "direct",
    "self_review",
    "repeated",
    "fusion",
  ]);
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error("runProvenance.configs must contain at least one config");
  }
  const seen = new Set<DeliberationMode>();
  for (const config of configs) {
    if (!valid.has(config)) {
      throw new Error(`Invalid run provenance config: ${String(config)}`);
    }
    if (seen.has(config)) {
      throw new Error(`Duplicate run provenance config: ${config}`);
    }
    seen.add(config);
  }
  return [...configs];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: string[],
): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isOneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}
