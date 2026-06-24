import { FrugalFusionError } from "../src/errors.js";
import { assertValid } from "../src/schema.js";
import type {
  JsonSchema,
  ModelClient,
  ModelUsage,
  SamplingParams,
} from "../src/types.js";

export type FakeStep =
  | {
      kind: "ok";
      output: unknown;
      modelId?: string;
      costUsd?: number;
      latencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      rawResponseId?: string;
    }
  | {
      kind: "error";
      status: "timeout" | "provider_error" | "invalid_output";
      message?: string;
      modelId?: string;
      costUsd?: number;
      latencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      usageModelId?: string;
    };

export class FakeModelClient implements ModelClient {
  readonly calls: Array<{
    modelId: string;
    system: string;
    input: string;
    sampling?: SamplingParams;
  }> = [];

  constructor(private readonly steps: FakeStep[]) {}

  async generate<T>(request: {
    modelId: string;
    system: string;
    input: string;
    outputSchema: JsonSchema;
    maxOutputTokens: number;
    sampling?: SamplingParams;
    signal?: AbortSignal;
  }): Promise<{ output: T; usage: ModelUsage; rawResponseId?: string }> {
    const call: (typeof this.calls)[number] = {
      modelId: request.modelId,
      system: request.system,
      input: request.input,
    };
    if (request.sampling) call.sampling = request.sampling;
    this.calls.push(call);
    const step = this.steps.shift();
    if (!step)
      throw new FrugalFusionError(
        "No fake step configured",
        "provider_error",
        request.modelId,
      );
    if (step.modelId && step.modelId !== request.modelId) {
      throw new Error(`Expected ${step.modelId}, got ${request.modelId}`);
    }
    if (step.kind === "error") {
      const error = new FrugalFusionError(
        step.message ?? step.status,
        step.status,
        request.modelId,
      );
      if (
        step.costUsd !== undefined ||
        step.latencyMs !== undefined ||
        step.inputTokens !== undefined ||
        step.outputTokens !== undefined
      ) {
        error.usage = [
          {
            modelId: step.usageModelId ?? request.modelId,
            inputTokens: step.inputTokens ?? 100,
            outputTokens: step.outputTokens ?? 50,
            costUsd: step.costUsd ?? 0.001,
            latencyMs: step.latencyMs ?? 10,
            status: "ok",
          },
        ];
      }
      throw error;
    }
    const output = assertValid<T>(step.output, request.outputSchema);
    const response: { output: T; usage: ModelUsage; rawResponseId?: string } = {
      output,
      usage: {
        modelId: request.modelId,
        inputTokens: step.inputTokens ?? 100,
        outputTokens: step.outputTokens ?? 50,
        costUsd: step.costUsd ?? 0.001,
        latencyMs: step.latencyMs ?? 10,
        status: "ok",
      },
    };
    if (step.rawResponseId) response.rawResponseId = step.rawResponseId;
    return response;
  }
}
