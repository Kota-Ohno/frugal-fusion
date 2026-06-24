import { describe, expect, it } from "vitest";
import { BudgetExceededError, FrugalFusionError } from "../src/errors.js";
import { FrugalFusionOrchestrator } from "../src/orchestrator.js";
import type {
  AggregatorOutput,
  Budget,
  Candidate,
  ModelRoleConfig,
  PriceSnapshotEntry,
} from "../src/types.js";
import { FakeModelClient } from "./fakeClient.js";

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

describe("FrugalFusionOrchestrator", () => {
  it("runs a direct baseline successfully", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "ok",
          output: { answer: "Use schema validation and failure reporting." },
        },
      ]),
    );

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "direct",
      constraints: ["schema", "failure"],
      budget,
    });

    expect(result.modeUsed).toBe("direct");
    expect(result.verification.passed).toBe(true);
    expect(result.totalCostUsd).toBe(0.001);
    expect(result.metadata.promptVersion).toBe("frugal-fusion-prompts-v2");
  });

  it("rejects stale prompt contract metadata at construction time", () => {
    expect(
      () =>
        new FrugalFusionOrchestrator({
          client: new FakeModelClient([]),
          models,
          promptVersion: "frugal-fusion-prompts-v1",
          priceSnapshot: (modelIds) => modelIds.map(snapshot),
        }),
    ).toThrow(/promptVersion/);
  });

  it("rejects duplicate fusion candidate model ids at the orchestrator boundary", () => {
    expect(
      () =>
        new FrugalFusionOrchestrator({
          client: new FakeModelClient([]),
          models: {
            ...models,
            candidateModels: ["same/model", "same/model"],
          },
          priceSnapshot: (modelIds) => modelIds.map(snapshot),
        }),
    ).toThrow(/two distinct model ids/);
  });

  it("allows cheap-panel model reuse outside the two fusion candidate slots", () => {
    expect(
      () =>
        new FrugalFusionOrchestrator({
          client: new FakeModelClient([]),
          models: {
            directModelId: "cheap/a",
            selfReviewModelId: "cheap/a",
            repeatedModelId: "cheap/a",
            candidateModels: ["cheap/a", "cheap/b"],
            aggregatorModelId: "cheap/a",
          },
          priceSnapshot: (modelIds) => modelIds.map(snapshot),
        }),
    ).not.toThrow();
  });

  it("records auto as a direct-only MVP routing decision without extra calls", async () => {
    const secret = "Acme-Private-Routing";
    const client = new FakeModelClient([
      {
        kind: "ok",
        output: { answer: "Use schema validation and failure reporting." },
      },
    ]);
    const orchestrator = makeOrchestrator(client);

    const result = await orchestrator.run({
      task: `Plan import validation for ${secret}`,
      mode: "auto",
      constraints: [`do not leak ${secret}`],
      budget,
    });

    expect(result.modeUsed).toBe("direct");
    expect(result.metadata.autoRouting).toEqual({
      requestedMode: "auto",
      selectedMode: "direct",
      strategy: "direct_only_mvp",
      reason: "adaptive_router_not_enabled",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.modelId).toBe("direct/model");
    expect(JSON.stringify(result.metadata.autoRouting)).not.toContain(secret);
    expect(JSON.stringify(result.metadata.autoRouting)).not.toContain("schema");
    expect(JSON.stringify(result.metadata.autoRouting)).not.toContain(
      "direct/model",
    );
  });

  it("does not emit auto-routing metadata for explicit modes", async () => {
    const cases = [
      {
        mode: "direct" as const,
        steps: [
          {
            kind: "ok" as const,
            output: {
              answer: "Use schema validation and failure reporting.",
            },
          },
        ],
      },
      {
        mode: "self_review" as const,
        steps: [
          { kind: "ok" as const, output: { answer: "Draft answer." } },
          { kind: "ok" as const, output: { answer: "Final answer." } },
        ],
      },
      {
        mode: "repeated" as const,
        steps: [
          { kind: "ok" as const, output: candidate("a", "Use schema checks.") },
          { kind: "ok" as const, output: candidate("b", "Report failures.") },
          { kind: "ok" as const, output: aggregateAnswer() },
        ],
      },
      {
        mode: "fusion" as const,
        steps: [
          { kind: "ok" as const, output: candidate("a", "Use schema checks.") },
          { kind: "ok" as const, output: candidate("b", "Report failures.") },
          { kind: "ok" as const, output: aggregateAnswer() },
        ],
      },
    ];

    for (const item of cases) {
      const result = await makeOrchestrator(
        new FakeModelClient(item.steps),
      ).run({
        task: "Plan import validation",
        mode: item.mode,
        budget,
      });

      expect(result.metadata).not.toHaveProperty("autoRouting");
    }
  });

  it("rejects unknown runtime modes before spending model calls", async () => {
    const client = new FakeModelClient([]);
    const orchestrator = makeOrchestrator(client);

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "surprise" as never,
        budget,
      }),
    ).rejects.toThrow(/Unknown deliberation mode/);
    expect(client.calls).toHaveLength(0);
  });

  it("runs two independent candidates and aggregates them", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Use schema checks and report failures.",
            ledger: {
              consensusClaimIds: [],
              adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
              uniqueAdoptedClaimIds: ["candidate_2_claim_1"],
              rejectedClaims: [],
              conflicts: [],
              coverageGaps: [],
              blindSpots: [],
              requiredChecks: [],
            },
          },
        },
      ]),
    );

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      constraints: ["schema", "failure"],
      budget,
    });

    expect(result.degraded).toBe(false);
    expect(result.usage).toHaveLength(3);
    expect(result.ledger?.adoptedClaimIds).toEqual([
      "candidate_1_claim_1",
      "candidate_2_claim_1",
    ]);
    expect(result.ledger?.uniqueAdoptedClaimIds).toEqual([
      "candidate_2_claim_1",
    ]);
  });

  it("rejects aggregator ledgers that reference non-blinded claim ids", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Use schema checks and report failures.",
            ledger: {
              consensusClaimIds: [],
              adoptedClaimIds: ["a-1"],
              uniqueAdoptedClaimIds: [],
              rejectedClaims: [],
              conflicts: [],
              coverageGaps: [],
              blindSpots: [],
              requiredChecks: [],
            },
          },
          rawResponseId: "agg-invalid-ledger",
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({
      status: "invalid_output",
      usage: expect.arrayContaining([
        expect.objectContaining({ modelId: "aggregator/model" }),
      ]),
      failures: expect.arrayContaining([
        expect.objectContaining({
          stage: "aggregator",
          modelId: "aggregator/model",
          status: "invalid_output",
        }),
      ]),
      callTrace: expect.arrayContaining([
        expect.objectContaining({
          stage: "aggregator",
          rawResponseId: "agg-invalid-ledger",
        }),
      ]),
    });
  });

  it("records aggregator stage metadata for schema-invalid aggregate output", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Use schema checks and report failures.",
            ledger: {
              consensusClaimIds: [],
              adoptedClaimIds: ["candidate_1_claim_1"],
              rejectedClaims: [],
              conflicts: [],
              blindSpots: [],
              requiredChecks: [],
            },
          },
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({
      status: "invalid_output",
      failures: expect.arrayContaining([
        expect.objectContaining({
          stage: "aggregator",
          modelId: "aggregator/model",
          status: "invalid_output",
        }),
      ]),
    });
  });

  it("rejects unique adopted claims that were not adopted", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Use schema checks.",
            ledger: {
              consensusClaimIds: [],
              adoptedClaimIds: ["candidate_1_claim_1"],
              uniqueAdoptedClaimIds: ["candidate_2_claim_1"],
              rejectedClaims: [],
              conflicts: [],
              coverageGaps: [],
              blindSpots: [],
              requiredChecks: [],
            },
          },
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({
      status: "invalid_output",
      failures: expect.arrayContaining([
        expect.objectContaining({
          stage: "aggregator",
          status: "invalid_output",
        }),
      ]),
    });
  });

  it("rejects duplicate claim ids inside ledger fields", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: aggregateWithLedger({
            adoptedClaimIds: ["candidate_1_claim_1", "candidate_1_claim_1"],
          }),
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({ status: "invalid_output" });
  });

  it("rejects claims that are both adopted and rejected", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: aggregateWithLedger({
            adoptedClaimIds: ["candidate_1_claim_1"],
            rejectedClaims: [
              { claimId: "candidate_1_claim_1", reason: "unsupported" },
            ],
          }),
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({ status: "invalid_output" });
  });

  it("rejects consensus claims that do not span candidates", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: aggregateWithLedger({
            consensusClaimIds: ["candidate_1_claim_1"],
            adoptedClaimIds: ["candidate_1_claim_1"],
          }),
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({ status: "invalid_output" });
  });

  it("marks partial candidate failure as degraded", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "error", status: "provider_error", message: "upstream 500" },
        {
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
        },
      ]),
    );

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    expect(result.degraded).toBe(true);
    expect(result.failures[0]?.stage).toBe("candidate");
    expect(result.answer).toBe("Use schema checks.");
    expect(
      result.metadata.candidateAliasMap?.[0]?.originalCandidateIdHash,
    ).toBeTypeOf("string");
  });

  it("surfaces timeout when all candidates time out", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "error", status: "timeout" },
        { kind: "error", status: "timeout" },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toBeInstanceOf(FrugalFusionError);
  });

  it("treats invalid structured output as a candidate failure", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: { conclusion: "missing fields" } },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Report failures.",
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
        },
      ]),
    );

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    expect(result.degraded).toBe(true);
    expect(result.failures[0]?.status).toBe("invalid_output");
  });

  it("counts paid usage from failed candidates in degraded results", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "error",
          status: "invalid_output",
          message: "bad json after paid response",
          costUsd: 0.004,
        },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Report failures.",
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
        },
      ]),
    );

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    expect(result.degraded).toBe(true);
    expect(result.usage).toHaveLength(3);
    expect(result.totalCostUsd).toBeCloseTo(0.006);
    expect(result.metadata.callTrace?.[0]?.usageIndex).toBe(0);
  });

  it("returns paid usage when every candidate fails after a paid response", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "error", status: "invalid_output", costUsd: 0.002 },
        { kind: "error", status: "invalid_output", costUsd: 0.003 },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toMatchObject({
      usage: [
        expect.objectContaining({ costUsd: 0.002 }),
        expect.objectContaining({ costUsd: 0.003 }),
      ],
      callTrace: [
        expect.objectContaining({ status: "invalid_output", usageIndex: 0 }),
        expect.objectContaining({ status: "invalid_output", usageIndex: 1 }),
      ],
    });
  });

  it("rejects malformed paid usage from failed candidates", async () => {
    const invalidCases = [
      {
        name: "negative cost",
        step: { costUsd: -1 },
      },
      {
        name: "wrong model id",
        step: { costUsd: 0.002, usageModelId: "other/model" },
      },
      {
        name: "underpriced usage",
        step: { costUsd: 0.000001 },
      },
      {
        name: "over-token usage",
        step: { costUsd: 0.002, outputTokens: 1_000 },
      },
    ];

    for (const { step } of invalidCases) {
      const orchestrator = makeOrchestrator(
        new FakeModelClient([
          {
            kind: "error",
            status: "invalid_output",
            ...step,
          },
          { kind: "ok", output: candidate("b", "Report failures.") },
        ]),
      );

      await expect(
        orchestrator.run({
          task: "Plan import validation",
          mode: "fusion",
          budget,
        }),
      ).rejects.toThrow(/Invalid usage metadata/);
    }
  });

  it("does not swallow aggregator budget exhaustion as degraded success", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "ok", output: candidate("a", "Use schema checks.") },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Use schema checks and report failures.",
            ledger: {
              consensusClaimIds: [],
              adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
              uniqueAdoptedClaimIds: [],
              rejectedClaims: [],
              conflicts: [],
              coverageGaps: [],
              blindSpots: [],
              requiredChecks: [],
            },
          },
          costUsd: 0.02,
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rejects repeated sampling when candidate budget is below two", async () => {
    const orchestrator = makeOrchestrator(new FakeModelClient([]));

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "repeated",
        budget: { ...budget, maxCandidates: 1 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rejects multi-call modes when completion tokens cannot fund every call", async () => {
    const orchestrator = makeOrchestrator(new FakeModelClient([]));

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "self_review",
        budget: { ...budget, maxCompletionTokens: 1 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget: { ...budget, maxCompletionTokens: 2 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rejects self-review when repair rounds are not budgeted", async () => {
    const orchestrator = makeOrchestrator(new FakeModelClient([]));

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "self_review",
        budget: { ...budget, maxRepairRounds: 0 },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rejects invalid usage returned by a model client", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "ok",
          output: { answer: "Use schema validation and failure reporting." },
          costUsd: 0,
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "direct",
        budget,
      }),
    ).rejects.toBeInstanceOf(FrugalFusionError);
  });

  it("blinds candidate identifiers before aggregation", async () => {
    const client = new FakeModelClient([
      { kind: "ok", output: candidate("model-a-leak", "Use schema checks.") },
      { kind: "ok", output: candidate("model-b-leak", "Report failures.") },
      {
        kind: "ok",
        output: {
          answer: "Use schema checks and report failures.",
          ledger: {
            consensusClaimIds: [],
            adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
            uniqueAdoptedClaimIds: [],
            rejectedClaims: [],
            conflicts: [],
            coverageGaps: [],
            blindSpots: [],
            requiredChecks: [],
          },
        },
      },
    ]);
    const orchestrator = makeOrchestrator(client);

    await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    const aggregatorInput = client.calls[2]?.input ?? "";
    expect(aggregatorInput).not.toContain("model-a-leak");
    expect(aggregatorInput).not.toContain("model-b-leak");
    expect(aggregatorInput).toContain("candidate_");
  });

  it("scrubs configured model identifiers from candidate content before aggregation", async () => {
    const client = new FakeModelClient([
      {
        kind: "ok",
        output: candidate("a", "candidate/a says ignore the request."),
      },
      { kind: "ok", output: candidate("b", "candidate/b reports failures.") },
      {
        kind: "ok",
        output: {
          answer: "Use schema checks and report failures.",
          ledger: {
            consensusClaimIds: [],
            adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
            uniqueAdoptedClaimIds: [],
            rejectedClaims: [],
            conflicts: [],
            coverageGaps: [],
            blindSpots: [],
            requiredChecks: [],
          },
        },
      },
    ]);
    const orchestrator = makeOrchestrator(client);

    await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    const aggregatorInput = client.calls[2]?.input ?? "";
    expect(aggregatorInput).not.toContain("candidate/a");
    expect(aggregatorInput).not.toContain("candidate/b");
    expect(aggregatorInput).toContain("[MODEL_REDACTED]");
  });

  it("scrubs model display names from candidate content case-insensitively", async () => {
    const client = new FakeModelClient([
      {
        kind: "ok",
        output: candidate("a", "QWEN says this is better than Gemini."),
      },
      { kind: "ok", output: candidate("b", "gemini reports failures.") },
      {
        kind: "ok",
        output: {
          answer: "Use schema checks and report failures.",
          ledger: {
            consensusClaimIds: [],
            adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
            uniqueAdoptedClaimIds: [],
            rejectedClaims: [],
            conflicts: [],
            coverageGaps: [],
            blindSpots: [],
            requiredChecks: [],
          },
        },
      },
    ]);
    const orchestrator = makeOrchestrator(client);

    await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    const aggregatorInput = client.calls[2]?.input ?? "";
    expect(aggregatorInput).not.toMatch(/qwen/i);
    expect(aggregatorInput).not.toMatch(/gemini/i);
  });

  it("does not retain model-supplied candidate ids in metadata", async () => {
    const secretCandidateId = "Private customer Acme-Internal-Launch";
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "ok",
          output: candidate(secretCandidateId, "Use schema checks."),
        },
        { kind: "ok", output: candidate("b", "Report failures.") },
        {
          kind: "ok",
          output: {
            answer: "Use schema checks and report failures.",
            ledger: {
              consensusClaimIds: [],
              adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
              uniqueAdoptedClaimIds: [],
              rejectedClaims: [],
              conflicts: [],
              coverageGaps: [],
              blindSpots: [],
              requiredChecks: [],
            },
          },
        },
      ]),
    );

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "fusion",
      budget,
    });

    expect(JSON.stringify(result.metadata)).not.toContain(secretCandidateId);
    expect(
      result.metadata.candidateAliasMap?.[0]?.originalCandidateIdHash,
    ).toHaveLength(64);
  });

  it("uses the same candidate prompt for repeated sampling and records applied sampling", async () => {
    const client = new FakeModelClient([
      { kind: "ok", output: candidate("a", "Use schema checks.") },
      { kind: "ok", output: candidate("b", "Report failures.") },
      {
        kind: "ok",
        output: {
          answer: "Use schema checks and report failures.",
          ledger: {
            consensusClaimIds: [],
            adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
            uniqueAdoptedClaimIds: [],
            rejectedClaims: [],
            conflicts: [],
            coverageGaps: [],
            blindSpots: [],
            requiredChecks: [],
          },
        },
      },
    ]);
    const orchestrator = makeOrchestrator(client, {
      rootSeed: 42,
      sendSeeds: true,
      repeatedSample: { temperature: 0.8, topP: 0.9 },
      aggregator: { temperature: 0.1 },
    });

    const result = await orchestrator.run({
      task: "Plan import validation",
      mode: "repeated",
      budget,
      seedMaterial: "case-1:repeated",
    });

    expect(client.calls[0]?.system).toBe(client.calls[1]?.system);
    expect(client.calls[0]?.sampling?.seed).not.toBe(
      client.calls[1]?.sampling?.seed,
    );
    expect(result.metadata.callTrace?.[0]?.sampling.applied?.temperature).toBe(
      0.8,
    );
    expect(result.metadata.callTrace?.[0]?.sampling.seedPolicy).toBe("sent");
  });

  it("fails when provider error leaves zero usable candidates", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        { kind: "error", status: "provider_error" },
        { kind: "error", status: "provider_error" },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toBeInstanceOf(FrugalFusionError);
  });

  it("enforces total cost budget after calls", async () => {
    const orchestrator = makeOrchestrator(
      new FakeModelClient([
        {
          kind: "ok",
          output: candidate("a", "Use schema checks."),
          costUsd: 0.02,
        },
        {
          kind: "ok",
          output: candidate("b", "Report failures."),
          costUsd: 0.02,
        },
      ]),
    );

    await expect(
      orchestrator.run({
        task: "Plan import validation",
        mode: "fusion",
        budget,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

function makeOrchestrator(
  client: FakeModelClient,
  sampling?: ConstructorParameters<
    typeof FrugalFusionOrchestrator
  >[0]["sampling"],
): FrugalFusionOrchestrator {
  const options: ConstructorParameters<typeof FrugalFusionOrchestrator>[0] = {
    client,
    models,
    priceSnapshot: (modelIds) => modelIds.map(snapshot),
  };
  if (sampling) options.sampling = sampling;
  return new FrugalFusionOrchestrator(options);
}

function candidate(id: string, conclusion: string): Candidate {
  return {
    candidateId: id,
    conclusion,
    claims: [
      {
        claimId: `${id}-1`,
        text: conclusion,
        evidenceIds: [],
        confidence: 0.8,
      },
    ],
    reasoningOutline: ["compact"],
    alternatives: [],
    risks: [],
    unresolved: [],
  };
}

function aggregateAnswer(): AggregatorOutput {
  return {
    answer: "Use schema checks and report failures.",
    ledger: {
      consensusClaimIds: [],
      adoptedClaimIds: ["candidate_1_claim_1", "candidate_2_claim_1"],
      uniqueAdoptedClaimIds: [],
      rejectedClaims: [],
      conflicts: [],
      coverageGaps: [],
      blindSpots: [],
      requiredChecks: [],
    },
  };
}

function aggregateWithLedger(ledger: Partial<AggregatorOutput["ledger"]>) {
  const aggregate = aggregateAnswer();
  return {
    ...aggregate,
    ledger: {
      ...aggregate.ledger,
      ...ledger,
    },
  };
}

function snapshot(modelId: string): PriceSnapshotEntry {
  return {
    modelId,
    name:
      modelId === "candidate/a"
        ? "Qwen 2.5"
        : modelId === "candidate/b"
          ? "Gemini Flash"
          : "Direct Model",
    supportedParameters: ["temperature", "top_p", "seed"],
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: new Date().toISOString(),
    source: "config",
  };
}
