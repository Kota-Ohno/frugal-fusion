import type {
  CallTrace,
  DeliberationResult,
  ModelStatus,
  ModelUsage,
} from "./types.js";

export class FrugalFusionError extends Error {
  usage: ModelUsage[] = [];
  failures: DeliberationResult["failures"] = [];
  callTrace: CallTrace[] = [];

  constructor(
    message: string,
    readonly status: ModelStatus,
    readonly modelId?: string,
  ) {
    super(message);
    this.name = "FrugalFusionError";
  }
}

export class BudgetExceededError extends FrugalFusionError {
  constructor(message: string, usage: ModelUsage[] = []) {
    super(message, "budget_exhausted");
    this.name = "BudgetExceededError";
    this.usage = usage;
  }
}

export function errorStatus(error: unknown): ModelStatus {
  if (error instanceof FrugalFusionError) return error.status;
  if (error instanceof DOMException && error.name === "AbortError")
    return "timeout";
  return "provider_error";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
