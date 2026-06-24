import { FrugalFusionError } from "./errors.js";

export type OpenRouterMetadata = {
  strategy?: string;
  pipeline?: Array<{
    type?: string;
    name?: string;
  }>;
};

export const OPENROUTER_FIXED_BASELINE_DISABLED_PLUGIN_IDS = [
  "web",
  "response-healing",
  "context-compression",
  "fusion",
  "pareto-router",
] as const;

export const OPENROUTER_METADATA_HEADER = {
  name: "X-OpenRouter-Metadata",
  value: "enabled",
} as const;

export const OPENROUTER_FIXED_BASELINE_ALLOWED_STRATEGIES = ["direct"] as const;

export const OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_TYPES = [
  "plugin",
  "response_healing",
  "context_compression",
  "server_tools",
] as const;

export const OPENROUTER_FIXED_BASELINE_BLOCKED_PIPELINE_STAGE_NAMES = [
  "web-search",
  "file-parser",
  "response-healing",
  "context-compression",
  "server-tools",
  "fusion",
] as const;

export function openRouterFixedBaselineDisabledPlugins(): Array<{
  id: (typeof OPENROUTER_FIXED_BASELINE_DISABLED_PLUGIN_IDS)[number];
  enabled: false;
}> {
  return OPENROUTER_FIXED_BASELINE_DISABLED_PLUGIN_IDS.map((id) => ({
    id,
    enabled: false,
  }));
}

export function assertOpenRouterFixedBaselineMetadata(
  metadata: unknown,
  modelId: string,
): void {
  if (!isRecord(metadata)) {
    throw new FrugalFusionError(
      "OpenRouter response did not include requested router metadata for fixed-baseline audit",
      "provider_error",
      modelId,
    );
  }
  if (
    metadata.strategy !== undefined &&
    typeof metadata.strategy !== "string"
  ) {
    throw new FrugalFusionError(
      "OpenRouter response included malformed router strategy metadata",
      "provider_error",
      modelId,
    );
  }
  if (metadata.pipeline !== undefined && !Array.isArray(metadata.pipeline)) {
    throw new FrugalFusionError(
      "OpenRouter response included malformed router pipeline metadata",
      "provider_error",
      modelId,
    );
  }
  const strategy = metadata.strategy?.toLowerCase();
  if (strategy !== OPENROUTER_FIXED_BASELINE_ALLOWED_STRATEGIES[0]) {
    throw new FrugalFusionError(
      `OpenRouter response used non-fixed routing strategy ${strategy ?? "missing"}`,
      "provider_error",
      modelId,
    );
  }
  for (const stage of metadata.pipeline ?? []) {
    if (!isRecord(stage)) {
      throw new FrugalFusionError(
        "OpenRouter response included malformed router pipeline stage metadata",
        "provider_error",
        modelId,
      );
    }
    if (stage.type !== undefined && typeof stage.type !== "string") {
      throw new FrugalFusionError(
        "OpenRouter response included malformed router pipeline stage type metadata",
        "provider_error",
        modelId,
      );
    }
    if (stage.name !== undefined && typeof stage.name !== "string") {
      throw new FrugalFusionError(
        "OpenRouter response included malformed router pipeline stage name metadata",
        "provider_error",
        modelId,
      );
    }
    const type = stage.type?.toLowerCase();
    const name = stage.name?.toLowerCase();
    throw new FrugalFusionError(
      `OpenRouter response used non-fixed pipeline stage ${name ?? type ?? "unknown"}`,
      "provider_error",
      modelId,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
