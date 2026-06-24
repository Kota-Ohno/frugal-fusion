import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildEvalRunProvenance,
  cliEvalInvocationProvenance,
  modelIdsForRunProvenance,
  normalizeEvalRunProvenance,
} from "../src/runProvenance.js";
import type {
  DeliberationMode,
  ModelRoleConfig,
  PriceSnapshotEntry,
} from "../src/types.js";

const models: ModelRoleConfig = {
  directModelId: "direct/model",
  selfReviewModelId: "direct/model",
  repeatedModelId: "direct/model",
  candidateModels: ["candidate/b", "candidate/a"],
  aggregatorModelId: "aggregator/model",
};

describe("run provenance", () => {
  it("fingerprints the allowlisted resolved config, not dormant raw config keys", () => {
    const baseConfig = {
      ...DEFAULT_CONFIG,
      configId: "provenance-config",
      models,
    };
    const configWithDormantSecret = {
      ...baseConfig,
      unusedPrivateNote: "PRIVATE-CUSTOMER-SK-SECRET",
    } as typeof baseConfig;

    const base = buildEvalRunProvenance({
      config: baseConfig,
      configs: ["direct"],
      configSourceKind: "config_file",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file",
    });
    const withDormantSecret = buildEvalRunProvenance({
      config: configWithDormantSecret,
      configs: ["direct"],
      configSourceKind: "config_file",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file",
    });
    const changedBudget = buildEvalRunProvenance({
      config: {
        ...baseConfig,
        budget: { ...baseConfig.budget, maxCostUsd: 0.06 },
      },
      configs: ["direct"],
      configSourceKind: "config_file",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file",
    });

    expect(base.config.resolvedConfigDigest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(withDormantSecret.config.resolvedConfigDigest.sha256).toBe(
      base.config.resolvedConfigDigest.sha256,
    );
    expect(changedBudget.config.resolvedConfigDigest.sha256).not.toBe(
      base.config.resolvedConfigDigest.sha256,
    );
    expect(JSON.stringify(withDormantSecret)).not.toContain("PRIVATE-CUSTOMER");
    expect(withDormantSecret.config.pathDisclosure).toBe("omitted");
    expect(withDormantSecret.openRouterRequestPolicy).toMatchObject({
      status: "private_report_bound",
      content: "openrouter-fixed-baseline-request-policy-v1",
      disabledDefaultPluginIds: [
        "web",
        "response-healing",
        "context-compression",
        "fusion",
        "pareto-router",
      ],
      metadataHeader: {
        name: "X-OpenRouter-Metadata",
        value: "enabled",
      },
      metadataRequiredOnSuccessfulResponse: true,
      allowedStrategies: ["direct"],
      missingStrategyPolicy: "fail_closed",
      unknownStrategyPolicy: "fail_closed",
      unknownPipelineStagePolicy: "fail_closed",
      cacheHitPolicy: "metadata_still_required",
    });
    expect(
      withDormantSecret.openRouterRequestPolicy?.requestPolicyDigest.sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(withDormantSecret.providerRouting).toEqual({
      status: "private_report_bound",
      content: "openrouter-provider-routing-policy-v1",
      providerEndpointPinning: "not_configured",
      allowFallbacks: false,
      orderedProviderSlugs: [],
      orderSlugCount: 0,
      fullEndpointSlugCount: 0,
      detailDisclosure: "private_report_only",
    });
  });

  it("binds provider endpoint routing into resolved config provenance", () => {
    const input = {
      config: { ...DEFAULT_CONFIG, models },
      configs: ["direct"] as DeliberationMode[],
      configSourceKind: "config_file" as const,
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file" as const,
    };
    const unpinned = buildEvalRunProvenance(input);
    const pinned = buildEvalRunProvenance({
      ...input,
      config: {
        ...input.config,
        provider: {
          ...input.config.provider,
          allow_fallbacks: false,
          order: ["deepinfra/turbo"],
        },
      },
    });
    const baseSlugOnly = buildEvalRunProvenance({
      ...input,
      config: {
        ...input.config,
        provider: {
          ...input.config.provider,
          allow_fallbacks: false,
          order: ["deepinfra"],
        },
      },
    });
    const fallbacksAllowed = buildEvalRunProvenance({
      ...input,
      config: {
        ...input.config,
        provider: {
          ...input.config.provider,
          allow_fallbacks: true,
          order: ["deepinfra/turbo"],
        },
      },
    });
    const multipleEndpoints = buildEvalRunProvenance({
      ...input,
      config: {
        ...input.config,
        provider: {
          ...input.config.provider,
          allow_fallbacks: false,
          order: ["deepinfra/turbo", "fireworks/fp8"],
        },
      },
    });

    expect(pinned.config.resolvedConfigDigest.sha256).not.toBe(
      unpinned.config.resolvedConfigDigest.sha256,
    );
    expect(pinned.providerRouting).toMatchObject({
      providerEndpointPinning: "single_provider_endpoint_pinned",
      allowFallbacks: false,
      orderedProviderSlugs: ["deepinfra/turbo"],
      orderSlugCount: 1,
      fullEndpointSlugCount: 1,
    });
    expect(baseSlugOnly.providerRouting.providerEndpointPinning).toBe(
      "base_provider_slug_only",
    );
    expect(fallbacksAllowed.providerRouting.providerEndpointPinning).toBe(
      "fallbacks_allowed",
    );
    expect(multipleEndpoints.providerRouting).toMatchObject({
      providerEndpointPinning: "multiple_provider_endpoints_allowed",
      orderSlugCount: 2,
      fullEndpointSlugCount: 2,
    });
  });

  it("fingerprints sorted unique effective model price entries", () => {
    const entriesA = [
      snapshot("candidate/b", ["seed", "temperature"]),
      snapshot("aggregator/model"),
      snapshot("candidate/a"),
      snapshot("candidate/a"),
    ];
    const entriesB = [
      snapshot("candidate/a"),
      snapshot("candidate/b", ["temperature", "seed"]),
      snapshot("aggregator/model"),
    ];

    const provenanceA = buildEvalRunProvenance({
      config: { ...DEFAULT_CONFIG, models },
      configs: ["fusion"],
      configSourceKind: "caller_provided",
      modelPriceEntries: entriesA,
      modelSnapshotSourceKind: "caller_provided",
    });
    const provenanceB = buildEvalRunProvenance({
      config: { ...DEFAULT_CONFIG, models },
      configs: ["fusion"],
      configSourceKind: "caller_provided",
      modelPriceEntries: entriesB,
      modelSnapshotSourceKind: "caller_provided",
    });

    expect(provenanceA.modelPriceSnapshot.effectiveModelCount).toBe(3);
    expect(
      provenanceA.modelPriceSnapshot.effectivePriceSnapshotDigest.sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      provenanceA.modelPriceSnapshot.effectivePriceSnapshotDigest.sha256,
    ).toBe(provenanceB.modelPriceSnapshot.effectivePriceSnapshotDigest.sha256);
    expect(provenanceA.modelPriceSnapshot.pathDisclosure).toBe("omitted");
  });

  it("rejects missing, extra, and conflicting model price entries", () => {
    const input = {
      config: { ...DEFAULT_CONFIG, models },
      configs: ["fusion"] as DeliberationMode[],
      configSourceKind: "caller_provided" as const,
      modelSnapshotSourceKind: "caller_provided" as const,
    };

    expect(() =>
      buildEvalRunProvenance({
        ...input,
        modelPriceEntries: [snapshot("candidate/a"), snapshot("candidate/b")],
      }),
    ).toThrow(/Missing run provenance model price entry/);
    expect(() =>
      buildEvalRunProvenance({
        ...input,
        modelPriceEntries: [
          snapshot("candidate/a"),
          snapshot("candidate/b"),
          snapshot("aggregator/model"),
          snapshot("unused/model"),
        ],
      }),
    ).toThrow(/Unexpected run provenance model price entry/);
    expect(() =>
      buildEvalRunProvenance({
        ...input,
        modelPriceEntries: [
          snapshot("candidate/a"),
          { ...snapshot("candidate/a"), promptPriceUsdPerToken: 0.0000009 },
          snapshot("candidate/b"),
          snapshot("aggregator/model"),
        ],
      }),
    ).toThrow(/Conflicting run provenance model price entry/);
  });

  it("records only normalized private CLI invocation metadata", () => {
    const provenance = buildEvalRunProvenance({
      config: { ...DEFAULT_CONFIG, models },
      configs: ["direct"],
      configSourceKind: "config_file",
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file",
      invocation: cliEvalInvocationProvenance(),
    });

    expect(provenance.invocation).toEqual({
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
    });
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain("--case-manifest");
    expect(serialized).not.toContain("FRUGAL_FUSION_MANIFEST_HMAC_KEY");
    expect(serialized).not.toContain("/private/");
  });

  it("rejects invocation metadata with raw argv, env, or path extras", () => {
    const input = {
      config: { ...DEFAULT_CONFIG, models },
      configs: ["direct"] as DeliberationMode[],
      configSourceKind: "config_file" as const,
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file" as const,
    };

    expect(() =>
      buildEvalRunProvenance({
        ...input,
        invocation: {
          ...cliEvalInvocationProvenance(),
          rawArgv: ["--case-manifest", "/private/holdout.jsonl"],
        } as unknown as ReturnType<typeof cliEvalInvocationProvenance>,
      }),
    ).toThrow(/runProvenance\.invocation/);
    expect(() =>
      buildEvalRunProvenance({
        ...input,
        invocation: {
          ...cliEvalInvocationProvenance(),
          caseSource: {
            ...cliEvalInvocationProvenance().caseSource,
            path: "/private/holdout.jsonl",
          },
        } as unknown as ReturnType<typeof cliEvalInvocationProvenance>,
      }),
    ).toThrow(/runProvenance\.invocation\.caseSource/);
  });

  it("rejects modified OpenRouter request policy provenance", () => {
    const input = {
      config: { ...DEFAULT_CONFIG, models },
      configs: ["direct"] as DeliberationMode[],
      configSourceKind: "config_file" as const,
      modelPriceEntries: modelIdsForRunProvenance(models, ["direct"]).map(
        (modelId) => snapshot(modelId),
      ),
      modelSnapshotSourceKind: "models_file" as const,
    };
    const provenance = buildEvalRunProvenance(input);

    expect(() =>
      normalizeEvalRunProvenance({
        ...provenance,
        openRouterRequestPolicy: {
          ...provenance.openRouterRequestPolicy!,
          allowedStrategies: ["direct", "auto"],
        },
      } as unknown as Parameters<typeof normalizeEvalRunProvenance>[0]),
    ).toThrow(/openRouterRequestPolicy/);
    expect(() =>
      normalizeEvalRunProvenance({
        ...provenance,
        openRouterRequestPolicy: {
          ...provenance.openRouterRequestPolicy!,
          requestPolicyDigest: {
            ...provenance.openRouterRequestPolicy!.requestPolicyDigest,
            sha256: "0".repeat(64),
          },
        },
      }),
    ).toThrow(/requestPolicyDigest/);
    expect(() =>
      normalizeEvalRunProvenance({
        ...provenance,
        providerRouting: {
          ...provenance.providerRouting,
          providerEndpointPinning: "PRIVATE-ENDPOINT-SLUG",
        },
      } as unknown as Parameters<typeof normalizeEvalRunProvenance>[0]),
    ).toThrow(/providerRouting/);
  });

  it("derives planned model ids from evaluation configs", () => {
    expect(modelIdsForRunProvenance(models, ["direct"])).toEqual([
      "direct/model",
    ]);
    expect(modelIdsForRunProvenance(models, ["fusion"])).toEqual([
      "aggregator/model",
      "candidate/a",
      "candidate/b",
    ]);
    expect(
      modelIdsForRunProvenance(models, [
        "direct",
        "self_review",
        "repeated",
        "fusion",
      ]),
    ).toEqual([
      "aggregator/model",
      "candidate/a",
      "candidate/b",
      "direct/model",
    ]);
  });
});

function snapshot(
  modelId: string,
  supportedParameters: string[] = ["temperature", "seed"],
): PriceSnapshotEntry {
  return {
    modelId,
    provider: `provider-${modelId}`,
    name: `name-${modelId}`,
    supportedParameters,
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: "2026-06-24T00:00:00.000Z",
    source: "config",
  };
}
