import { BudgetExceededError, FrugalFusionError } from "./errors.js";
import type { ModelUsage, PriceSnapshotEntry } from "./types.js";

type OpenRouterModel = {
  id: string;
  name?: string;
  supported_parameters?: string[];
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    name?: string;
  };
};

type OpenRouterModelsResponse = {
  data: OpenRouterModel[];
};

export class ModelRegistry {
  private readonly entries: Map<string, PriceSnapshotEntry>;

  constructor(
    entries: PriceSnapshotEntry[],
    readonly maxAgeMs = 24 * 60 * 60 * 1000,
  ) {
    const byModelId = new Map<string, PriceSnapshotEntry>();
    for (const entry of entries) {
      validatePriceSnapshotEntry(entry);
      if (byModelId.has(entry.modelId)) {
        throw new FrugalFusionError(
          `Duplicate price snapshot entry for modelId ${entry.modelId}`,
          "invalid_output",
          entry.modelId,
        );
      }
      byModelId.set(entry.modelId, entry);
    }
    this.entries = byModelId;
  }

  static async fromOpenRouter(
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ModelRegistry> {
    const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new FrugalFusionError(
        `OpenRouter models request failed: ${response.status}`,
        "provider_error",
      );
    }
    const body = (await response.json()) as OpenRouterModelsResponse;
    const fetchedAt = new Date().toISOString();
    const entries = body.data.flatMap((model) => {
      const prompt = Number(model.pricing?.prompt);
      const completion = Number(model.pricing?.completion);
      if (prompt <= 0 || completion <= 0) return [];
      const entry: PriceSnapshotEntry = {
        modelId: model.id,
        promptPriceUsdPerToken: prompt,
        completionPriceUsdPerToken: completion,
        fetchedAt,
        source: "openrouter",
      };
      if (model.name) entry.name = model.name;
      if (model.top_provider?.name) entry.provider = model.top_provider.name;
      if (model.supported_parameters)
        entry.supportedParameters = model.supported_parameters;
      return [entry];
    });
    return new ModelRegistry(entries);
  }

  static fromJson(text: string): ModelRegistry {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      throw new FrugalFusionError(
        "Model snapshot must be an array",
        "invalid_output",
      );
    }
    return new ModelRegistry(parsed);
  }

  snapshot(modelIds?: string[]): PriceSnapshotEntry[] {
    const ids = modelIds ?? [...this.entries.keys()];
    return ids.map((id) => this.requireFresh(id));
  }

  requireFresh(modelId: string): PriceSnapshotEntry {
    const entry = this.entries.get(modelId);
    if (!entry)
      throw new FrugalFusionError(
        `Missing price snapshot for ${modelId}`,
        "provider_error",
        modelId,
      );
    const age = Date.now() - Date.parse(entry.fetchedAt);
    if (!Number.isFinite(age) || age > this.maxAgeMs) {
      throw new FrugalFusionError(
        `Stale price snapshot for ${modelId}`,
        "provider_error",
        modelId,
      );
    }
    return entry;
  }

  costFor(modelId: string, inputTokens: number, outputTokens: number): number {
    const entry = this.requireFresh(modelId);
    return (
      inputTokens * entry.promptPriceUsdPerToken +
      outputTokens * entry.completionPriceUsdPerToken
    );
  }
}

function validatePriceSnapshotEntry(entry: PriceSnapshotEntry): void {
  if (!entry.modelId) {
    throw new FrugalFusionError(
      "Price snapshot entry is missing modelId",
      "invalid_output",
    );
  }
  if (
    !Number.isFinite(entry.promptPriceUsdPerToken) ||
    entry.promptPriceUsdPerToken <= 0
  ) {
    throw new FrugalFusionError(
      `Invalid prompt price for ${entry.modelId}`,
      "invalid_output",
      entry.modelId,
    );
  }
  if (
    !Number.isFinite(entry.completionPriceUsdPerToken) ||
    entry.completionPriceUsdPerToken <= 0
  ) {
    throw new FrugalFusionError(
      `Invalid completion price for ${entry.modelId}`,
      "invalid_output",
      entry.modelId,
    );
  }
  if (!Number.isFinite(Date.parse(entry.fetchedAt))) {
    throw new FrugalFusionError(
      `Invalid fetchedAt for ${entry.modelId}`,
      "invalid_output",
      entry.modelId,
    );
  }
}

export function assertCostWithinBudget(
  usage: ModelUsage[],
  maxCostUsd: number,
): void {
  const total = usage.reduce((sum, item) => sum + item.costUsd, 0);
  if (total > maxCostUsd) {
    throw new BudgetExceededError(
      `Budget exceeded: $${total.toFixed(6)} > $${maxCostUsd.toFixed(6)}`,
    );
  }
}
