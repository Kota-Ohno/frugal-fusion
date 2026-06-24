export type DeliberationMode = "direct" | "self_review" | "repeated" | "fusion";

export type Budget = {
  maxCostUsd: number;
  maxLatencyMs: number;
  maxCandidates: number;
  maxCompletionTokens: number;
  maxRepairRounds: number;
};

export type DeliberationRequest = {
  task: string;
  mode: DeliberationMode | "auto";
  constraints?: string[];
  verification?: "none" | "schema" | "code" | "source" | "math";
  budget: Budget;
  seedMaterial?: string;
};

export type ModelStatus =
  | "ok"
  | "timeout"
  | "provider_error"
  | "invalid_output"
  | "budget_exhausted";

export type ModelUsage = {
  modelId: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  status: ModelStatus;
};

export type Candidate = {
  candidateId: string;
  conclusion: string;
  claims: Array<{
    claimId: string;
    text: string;
    evidenceIds: string[];
    confidence: number;
  }>;
  reasoningOutline: string[];
  alternatives: string[];
  risks: string[];
  unresolved: string[];
};

export type DeliberationLedger = {
  consensusClaimIds: string[];
  adoptedClaimIds: string[];
  uniqueAdoptedClaimIds: string[];
  rejectedClaims: Array<{
    claimId: string;
    reason: "unsupported" | "contradicted" | "irrelevant" | "duplicate";
  }>;
  conflicts: Array<{
    topic: string;
    claimIds: string[];
    status: "resolved" | "unresolved";
    resolution?: string;
  }>;
  coverageGaps: string[];
  blindSpots: string[];
  requiredChecks: string[];
};

export type AggregatorOutput = {
  answer: string;
  ledger: DeliberationLedger;
};

export type VerificationResult = {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; details?: string }>;
};

export type PriceSnapshotEntry = {
  modelId: string;
  name?: string;
  provider?: string;
  supportedParameters?: string[];
  promptPriceUsdPerToken: number;
  completionPriceUsdPerToken: number;
  fetchedAt: string;
  source: "openrouter" | "config";
};

export type SamplingParams = {
  temperature?: number;
  topP?: number;
  seed?: number;
};

export type SamplingConfig = {
  rootSeed?: number;
  sendSeeds?: boolean;
  direct?: SamplingParams;
  selfReviewDraft?: SamplingParams;
  selfReviewFinal?: SamplingParams;
  repeatedSample?: SamplingParams;
  fusionCandidate?: SamplingParams;
  aggregator?: SamplingParams;
};

export type SamplingResolution = {
  requested?: SamplingParams;
  applied?: SamplingParams;
  seedPolicy:
    | "not_requested"
    | "sent"
    | "not_sent_disabled"
    | "not_sent_support_unknown"
    | "not_sent_unsupported";
  determinism: "best_effort";
};

export type AutoRoutingMetadata = {
  requestedMode: "auto";
  selectedMode: "direct";
  strategy: "direct_only_mvp";
  reason: "adaptive_router_not_enabled";
};

export type CallTrace = {
  stage: string;
  modelId: string;
  maxOutputTokens: number;
  sampling: SamplingResolution;
  usageIndex?: number;
  rawResponseId?: string;
  status: ModelStatus;
};

export type DeliberationResult = {
  answer: string;
  modeUsed: DeliberationMode;
  degraded: boolean;
  ledger?: DeliberationLedger;
  usage: ModelUsage[];
  rawResponseIds: string[];
  totalCostUsd: number;
  totalLatencyMs: number;
  verification: VerificationResult;
  priceSnapshot: PriceSnapshotEntry[];
  metadata: {
    configId: string;
    promptVersion: string;
    autoRouting?: AutoRoutingMetadata;
    candidateAliasMap?: Array<{
      alias: string;
      modelId: string;
      originalCandidateIdHash: string;
    }>;
    candidateOrderSeed?: number;
    candidateRoleMap?: Array<{ modelId: string; role: string }>;
    callTrace?: CallTrace[];
    samplingConfig?: SamplingConfig;
  };
  failures: Array<{
    stage: string;
    modelId?: string;
    status: ModelStatus;
    message: string;
  }>;
};

export type RetainedDeliberationResult = Omit<
  DeliberationResult,
  "answer" | "ledger"
> & {
  answer?: string;
  ledger?: DeliberationLedger;
  retention?: {
    answer?: {
      truncated: boolean;
      originalLength: number;
      retainedLength: number;
      sha256: string;
    };
    ledger?: {
      truncated: boolean;
      truncatedStringCount: number;
    };
  };
};

export type ModelClient = {
  generate<T>(request: {
    modelId: string;
    system: string;
    input: string;
    outputSchema: JsonSchema;
    maxOutputTokens: number;
    sampling?: SamplingParams;
    signal?: AbortSignal;
  }): Promise<{ output: T; usage: ModelUsage; rawResponseId?: string }>;
};

export type JsonSchema =
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | { type: "array"; items: JsonSchema }
  | { type: "string"; enum?: string[] }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" };

export type JsonSchemaSubset =
  | {
      type: "object";
      properties: Record<string, JsonSchemaSubset>;
      required?: string[];
      additionalProperties: boolean;
    }
  | { type: "array"; items: JsonSchemaSubset }
  | { type: "string"; enum?: string[] }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" };

export type ModelRoleConfig = {
  directModelId: string;
  selfReviewModelId: string;
  repeatedModelId: string;
  candidateModels: [string, string];
  aggregatorModelId: string;
};

export type ProviderPolicy = {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  order?: string[];
};

export type TraceRecord = {
  id: string;
  configId: string;
  trialIndex?: number;
  executionOrder?: number;
  request: Omit<DeliberationRequest, "task" | "constraints"> & {
    taskHash: string;
    taskLength: number;
    constraintsHash?: string;
    constraintsCount?: number;
    seedMaterialHash?: string;
    taskRedacted?: string;
    taskRaw?: string;
    constraintsRedacted?: string[];
  };
  outcome: {
    status: "completed" | "failed";
    result?: RetainedDeliberationResult;
    failure?: {
      status: ModelStatus;
      message: string;
      usage?: ModelUsage[];
      failures?: DeliberationResult["failures"];
      callTrace?: CallTrace[];
    };
  };
  startedAt: string;
  finishedAt: string;
};
