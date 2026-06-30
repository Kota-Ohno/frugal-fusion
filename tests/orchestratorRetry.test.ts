import { describe, expect, it } from "vitest";
import { FrugalFusionOrchestrator } from "../src/orchestrator.js";
import type {
  Budget,
  ModelRoleConfig,
  PriceSnapshotEntry,
} from "../src/types.js";
import { FakeModelClient, type FakeStep } from "./fakeClient.js";

const models: ModelRoleConfig = {
  directModelId: "direct/model",
  selfReviewModelId: "direct/model",
  repeatedModelId: "direct/model",
  candidateModels: ["candidate/a", "candidate/b"],
  aggregatorModelId: "aggregator/model",
};

const budget: Budget = {
  maxCostUsd: 0.01,
  maxLatencyMs: 1_000,
  maxCandidates: 2,
  maxCompletionTokens: 500,
  maxRepairRounds: 1,
};

function snapshot(modelId: string): PriceSnapshotEntry {
  return {
    modelId,
    name: modelId,
    supportedParameters: ["temperature", "top_p", "seed"],
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: "2026-06-29T00:00:00.000Z",
    source: "config",
  };
}

function makeOrchestrator(
  client: FakeModelClient,
  transientRetryAttempts?: number,
): FrugalFusionOrchestrator {
  return new FrugalFusionOrchestrator({
    client,
    models,
    priceSnapshot: (modelIds) => modelIds.map(snapshot),
    sleep: async () => {},
    ...(transientRetryAttempts !== undefined ? { transientRetryAttempts } : {}),
  });
}

const okAnswer: FakeStep = {
  kind: "ok",
  output: { answer: "Use schema validation and failure reporting." },
};

describe("transient retry", () => {
  it("retries a transient provider_error on the direct baseline", async () => {
    const client = new FakeModelClient([
      { kind: "error", status: "provider_error", message: "upstream 500" },
      okAnswer,
    ]);
    const result = await makeOrchestrator(client).run({
      task: "Plan import validation",
      mode: "direct",
      constraints: ["schema", "failure"],
      budget,
    });
    expect(result.verification.passed).toBe(true);
    expect(client.calls).toHaveLength(2);
  });

  it("gives up after the bounded retry budget", async () => {
    const client = new FakeModelClient([
      { kind: "error", status: "provider_error" },
      { kind: "error", status: "provider_error" },
    ]);
    await expect(
      makeOrchestrator(client, 1).run({
        task: "Plan import validation",
        mode: "direct",
        budget,
      }),
    ).rejects.toBeTruthy();
    expect(client.calls).toHaveLength(2);
  });

  it("does not retry a non-transient invalid_output", async () => {
    const client = new FakeModelClient([
      { kind: "error", status: "invalid_output" },
    ]);
    await makeOrchestrator(client)
      .run({ task: "Plan import validation", mode: "direct", budget })
      .catch(() => undefined);
    expect(client.calls).toHaveLength(1);
  });
});

class ConcurrencyTrackingClient extends FakeModelClient {
  inFlight = 0;
  peak = 0;

  async generate<T>(request: Parameters<FakeModelClient["generate"]>[0]) {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    try {
      return await super.generate<T>(request);
    } finally {
      this.inFlight -= 1;
    }
  }
}

const candidateOut = (id: string) => ({
  kind: "ok" as const,
  output: {
    candidateId: id,
    conclusion: "Use schema checks.",
    claims: [
      {
        claimId: `${id}-1`,
        text: "Use schema checks.",
        evidenceIds: [],
        confidence: 0.8,
      },
    ],
    reasoningOutline: ["compact"],
    alternatives: [],
    risks: [],
    unresolved: [],
  },
});

const aggregatorOut: FakeStep = {
  kind: "ok",
  output: {
    answer: "Use schema checks.",
    ledger: {
      consensusClaimIds: [],
      adoptedClaimIds: ["candidate_1_claim_1"],
      uniqueAdoptedClaimIds: [],
      rejectedClaims: [],
      conflicts: [],
      coverageGaps: [],
      blindSpots: [],
      requiredChecks: [],
    },
  },
};

describe("aggregator repair", () => {
  // Missing uniqueAdoptedClaimIds / coverageGaps -> schema-invalid aggregate.
  const invalidAggregate = {
    kind: "ok" as const,
    output: {
      answer: "Use schema checks.",
      ledger: {
        consensusClaimIds: [],
        adoptedClaimIds: [],
        rejectedClaims: [],
        conflicts: [],
        blindSpots: [],
        requiredChecks: [],
      },
    },
  };

  it("repairs a schema-invalid aggregate once, then succeeds", async () => {
    const client = new FakeModelClient([
      candidateOut("a"),
      candidateOut("b"),
      invalidAggregate,
      aggregatorOut,
    ]);
    const result = await makeOrchestrator(client).run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });
    expect(result.modeUsed).toBe("fusion");
    expect(client.calls).toHaveLength(4);
  });
});

describe("same-model concurrency", () => {
  it("runs repeated samples sequentially (peak concurrency 1)", async () => {
    const client = new ConcurrencyTrackingClient([
      candidateOut("a"),
      candidateOut("b"),
      aggregatorOut,
    ]);
    await makeOrchestrator(client)
      .run({ task: "Plan import validation", mode: "repeated", budget })
      .catch(() => undefined);
    expect(client.peak).toBe(1);
  });

  it("runs fusion candidates concurrently (peak concurrency 2)", async () => {
    const client = new ConcurrencyTrackingClient([
      candidateOut("a"),
      candidateOut("b"),
      aggregatorOut,
    ]);
    await makeOrchestrator(client)
      .run({ task: "Plan import validation", mode: "fusion", budget })
      .catch(() => undefined);
    expect(client.peak).toBe(2);
  });
});
