import { FrugalFusionError } from "./errors.js";
import {
  assertOpenRouterFixedBaselineMetadata,
  openRouterFixedBaselineDisabledPlugins,
  OPENROUTER_METADATA_HEADER,
} from "./openRouterPolicy.js";
import { assertValid } from "./schema.js";
import type {
  JsonSchema,
  ModelClient,
  ModelUsage,
  ProviderPolicy,
  SamplingParams,
} from "./types.js";
import { ModelRegistry } from "./modelRegistry.js";

type OpenRouterProviderPolicy = Required<Omit<ProviderPolicy, "order">> &
  Pick<ProviderPolicy, "order">;

type OpenRouterClientOptions = {
  apiKey: string;
  registry: ModelRegistry;
  fetchImpl?: typeof fetch;
  referer?: string;
  title?: string;
  provider?: ProviderPolicy;
};

type OpenRouterResponse = {
  id?: string;
  provider?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  openrouter_metadata?: unknown;
};

export class OpenRouterClient implements ModelClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate<T>(request: {
    modelId: string;
    system: string;
    input: string;
    outputSchema: JsonSchema;
    maxOutputTokens: number;
    sampling?: SamplingParams;
    signal?: AbortSignal;
  }): Promise<{ output: T; usage: ModelUsage; rawResponseId?: string }> {
    this.options.registry.requireFresh(request.modelId);
    const started = performance.now();
    const requestBody = {
      model: request.modelId,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.input },
      ],
      max_tokens: request.maxOutputTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "frugal_fusion_output",
          strict: true,
          schema: request.outputSchema,
        },
      },
      plugins: openRouterFixedBaselineDisabledPlugins(),
      provider: providerPolicy(this.options.provider),
      ...samplingBody(request.sampling),
    };
    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(requestBody),
    };
    if (request.signal) init.signal = request.signal;
    const response = await this.fetchImpl(
      "https://openrouter.ai/api/v1/chat/completions",
      init,
    );
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      throw new FrugalFusionError(
        `OpenRouter request failed: ${response.status}`,
        "provider_error",
        request.modelId,
      );
    }
    const responseBody = (await response.json()) as OpenRouterResponse;
    const usage = this.usageFromResponse(
      responseBody,
      request.modelId,
      latencyMs,
    );
    try {
      assertOpenRouterFixedBaselineMetadata(
        responseBody.openrouter_metadata,
        request.modelId,
      );
    } catch (error) {
      if (error instanceof FrugalFusionError) error.usage = [usage];
      throw error;
    }
    const content = responseBody.choices?.[0]?.message?.content;
    if (!content) {
      const error = new FrugalFusionError(
        "OpenRouter response did not include content",
        "invalid_output",
        request.modelId,
      );
      error.usage = [usage];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const error = new FrugalFusionError(
        "OpenRouter response content was not JSON",
        "invalid_output",
        request.modelId,
      );
      error.usage = [usage];
      throw error;
    }

    let output: T;
    try {
      output = assertValid<T>(parsed, request.outputSchema);
    } catch (error) {
      if (error instanceof FrugalFusionError) error.usage = [usage];
      throw error;
    }
    return responseBody.id
      ? { output, usage, rawResponseId: responseBody.id }
      : { output, usage };
  }

  private usageFromResponse(
    body: OpenRouterResponse,
    modelId: string,
    latencyMs: number,
  ): ModelUsage {
    const inputTokens = body.usage?.prompt_tokens;
    const outputTokens = body.usage?.completion_tokens;
    if (
      typeof inputTokens !== "number" ||
      typeof outputTokens !== "number" ||
      !Number.isFinite(inputTokens) ||
      !Number.isFinite(outputTokens) ||
      inputTokens <= 0 ||
      outputTokens < 0
    ) {
      throw new FrugalFusionError(
        "OpenRouter response did not include usable token usage",
        "provider_error",
        modelId,
      );
    }
    const calculatedCost = this.options.registry.costFor(
      modelId,
      inputTokens,
      outputTokens,
    );
    const providerCost = body.usage?.cost;
    const costUsd =
      Number.isFinite(providerCost) && providerCost !== undefined
        ? Math.max(providerCost, calculatedCost)
        : calculatedCost;
    const usage: ModelUsage = {
      modelId,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      status: "ok",
    };
    if (body.provider) usage.provider = body.provider;
    return usage;
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      [OPENROUTER_METADATA_HEADER.name]: OPENROUTER_METADATA_HEADER.value,
    };
    if (this.options.referer) headers["HTTP-Referer"] = this.options.referer;
    if (this.options.title) headers["X-OpenRouter-Title"] = this.options.title;
    return headers;
  }
}

function samplingBody(sampling?: SamplingParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (sampling?.temperature !== undefined)
    body.temperature = sampling.temperature;
  if (sampling?.topP !== undefined) body.top_p = sampling.topP;
  if (sampling?.seed !== undefined) body.seed = sampling.seed;
  return body;
}

export function providerPolicy(
  override?: ProviderPolicy,
): OpenRouterProviderPolicy {
  const policy: OpenRouterProviderPolicy = {
    allow_fallbacks: override?.allow_fallbacks ?? false,
    require_parameters: override?.require_parameters ?? true,
    data_collection: override?.data_collection ?? "deny",
    zdr: override?.zdr ?? false,
  };
  if (override?.order !== undefined) policy.order = [...override.order];
  return policy;
}
