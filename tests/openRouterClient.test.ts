import { describe, expect, it } from "vitest";
import { FrugalFusionError } from "../src/errors.js";
import { ModelRegistry } from "../src/modelRegistry.js";
import { OpenRouterClient } from "../src/openRouterClient.js";
import { answerSchema } from "../src/schema.js";
import type { PriceSnapshotEntry } from "../src/types.js";

describe("OpenRouterClient", () => {
  it("merges provider privacy defaults with partial overrides", async () => {
    let requestBody: unknown;
    let requestHeaders: unknown;
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      provider: { allow_fallbacks: true },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        requestHeaders = init?.headers;
        return Response.json({
          id: "generation-1",
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: { strategy: "direct" },
        });
      },
    });

    await client.generate<{ answer: string }>({
      modelId: "test/model",
      system: "system",
      input: "input",
      outputSchema: answerSchema,
      maxOutputTokens: 10,
    });

    expect(requestBody).toMatchObject({
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: "deny",
      },
    });
    expect(requestBody).toMatchObject({
      plugins: [
        { id: "web", enabled: false },
        { id: "response-healing", enabled: false },
        { id: "context-compression", enabled: false },
        { id: "fusion", enabled: false },
        { id: "pareto-router", enabled: false },
      ],
    });
    expect(requestHeaders).toMatchObject({
      "X-OpenRouter-Metadata": "enabled",
    });
  });

  it("serializes provider endpoint order", async () => {
    let requestBody: unknown;
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      provider: { order: ["deepinfra/turbo"] },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          id: "generation-1",
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: { strategy: "direct" },
        });
      },
    });

    await client.generate<{ answer: string }>({
      modelId: "test/model",
      system: "system",
      input: "input",
      outputSchema: answerSchema,
      maxOutputTokens: 10,
    });

    expect(requestBody).toMatchObject({
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        zdr: false,
        order: ["deepinfra/turbo"],
      },
    });
  });

  it("fails closed when token usage is missing", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: {},
          openrouter_metadata: { strategy: "direct" },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toBeInstanceOf(FrugalFusionError);
  });

  it("attaches usage to invalid structured output errors when provider reports usage", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: "not json" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: { strategy: "direct" },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "invalid_output",
      usage: [
        expect.objectContaining({
          modelId: "test/model",
          inputTokens: 10,
          outputTokens: 2,
        }),
      ],
    });
  });

  it("attaches usage to schema validation errors when provider reports usage", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ nope: "bad" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: { strategy: "direct" },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "invalid_output",
      usage: [expect.objectContaining({ modelId: "test/model" })],
    });
  });

  it("fails closed when requested router metadata is missing", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "provider_error",
      usage: [expect.objectContaining({ modelId: "test/model" })],
    });
  });

  it("fails closed when router metadata shows hidden plugins", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: {
            strategy: "direct",
            pipeline: [{ type: "plugin", name: "web-search" }],
          },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "provider_error",
      usage: [expect.objectContaining({ modelId: "test/model" })],
    });
  });

  it("fails closed when router metadata shows managed routing", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: { strategy: "fusion" },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "provider_error",
      usage: [expect.objectContaining({ modelId: "test/model" })],
    });
  });

  it("fails closed when router metadata omits the direct strategy", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: {},
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "provider_error",
      usage: [expect.objectContaining({ modelId: "test/model" })],
    });
  });

  it("fails closed when router metadata includes unknown pipeline stages", async () => {
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: {
            strategy: "direct",
            pipeline: [{ type: "unknown-stage", name: "unknown-stage" }],
          },
        }),
    });

    await expect(
      client.generate<{ answer: string }>({
        modelId: "test/model",
        system: "system",
        input: "input",
        outputSchema: answerSchema,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: "provider_error",
      usage: [expect.objectContaining({ modelId: "test/model" })],
    });
  });

  it("attaches usage when router metadata is malformed", async () => {
    const cases = [
      { strategy: 123 },
      { strategy: "direct", pipeline: {} },
      { strategy: "direct", pipeline: ["bad-stage"] },
    ];

    for (const metadata of cases) {
      const client = new OpenRouterClient({
        apiKey: "sk-or-v1-test",
        registry: registry(),
        fetchImpl: async () =>
          Response.json({
            choices: [
              { message: { content: JSON.stringify({ answer: "ok" }) } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
            openrouter_metadata: metadata,
          }),
      });

      await expect(
        client.generate<{ answer: string }>({
          modelId: "test/model",
          system: "system",
          input: "input",
          outputSchema: answerSchema,
          maxOutputTokens: 10,
        }),
      ).rejects.toMatchObject({
        status: "provider_error",
        usage: [expect.objectContaining({ modelId: "test/model" })],
      });
    }
  });

  it("sends only applied sampling parameters", async () => {
    let requestBody: unknown;
    const client = new OpenRouterClient({
      apiKey: "sk-or-v1-test",
      registry: registry(),
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          id: "generation-1",
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
          openrouter_metadata: { strategy: "direct" },
        });
      },
    });

    await client.generate<{ answer: string }>({
      modelId: "test/model",
      system: "system",
      input: "input",
      outputSchema: answerSchema,
      maxOutputTokens: 10,
      sampling: { temperature: 0.3, topP: 0.9, seed: 123 },
    });

    expect(requestBody).toMatchObject({
      temperature: 0.3,
      top_p: 0.9,
      seed: 123,
    });
  });
});

function registry(): ModelRegistry {
  return new ModelRegistry([snapshot("test/model")]);
}

function snapshot(modelId: string): PriceSnapshotEntry {
  return {
    modelId,
    supportedParameters: ["temperature", "top_p", "seed"],
    promptPriceUsdPerToken: 0.0000001,
    completionPriceUsdPerToken: 0.0000002,
    fetchedAt: new Date().toISOString(),
    source: "config",
  };
}
