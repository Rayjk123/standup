import { expect, test, describe, afterEach } from "bun:test";
import {
  bedrockProvider,
  setBedrockInvoker,
  BEDROCK_DEFAULT_MODEL,
  type BedrockInvoker,
} from "./bedrock.js";
import {
  generateEmbedding,
  defaultModelFor,
  resolveEmbeddingProvider,
} from "./embeddings.js";

/**
 * The Bedrock plugin on the embedding seam. Asserts it registers and resolves,
 * and that with a mocked invoker (no live AWS) it builds the Titan request body
 * and maps the Titan response to a vector. Also covers the cohere extension
 * point and the error -> null contract.
 */

type InvokeCall = { modelId: string; body: unknown; region?: string };

// Records each invoke and returns a canned model response, standing in for the
// Bedrock client so the plugin's mapping runs offline.
function stubInvoker(response: unknown): {
  calls: InvokeCall[];
  invoker: BedrockInvoker;
} {
  const calls: InvokeCall[] = [];
  const invoker: BedrockInvoker = async (modelId, body, region) => {
    calls.push({ modelId, body, region });
    return response;
  };
  return { calls, invoker };
}

afterEach(() => setBedrockInvoker());

describe("bedrock provider", () => {
  test("registers and resolves on the seam", () => {
    expect(resolveEmbeddingProvider("bedrock")).toBe(bedrockProvider);
    expect(defaultModelFor("bedrock")).toBe(BEDROCK_DEFAULT_MODEL);
    expect(bedrockProvider.dimensions).toBe(1024);
  });

  test("maps a Titan response to a vector with the default model", async () => {
    const { calls, invoker } = stubInvoker({ embedding: [0.1, 0.2, 0.3] });
    setBedrockInvoker(invoker);

    const vec = await generateEmbedding("hello", "bedrock", {
      region: "us-west-2",
    });

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(calls[0]!.region).toBe("us-west-2");
    expect(calls[0]!.body).toEqual({ inputText: "hello" });
  });

  test("threads an explicit dimensions override into the Titan request body", async () => {
    const { calls, invoker } = stubInvoker({ embedding: new Array(512).fill(0) });
    setBedrockInvoker(invoker);

    await generateEmbedding("hello", "bedrock", { dimensions: 512 });

    expect(calls[0]!.body).toEqual({ inputText: "hello", dimensions: 512 });
  });

  test("routes a cohere model id to the cohere request/response shape", async () => {
    const { calls, invoker } = stubInvoker({ embeddings: [[9, 8, 7]] });
    setBedrockInvoker(invoker);

    const vec = await generateEmbedding("q", "bedrock", {
      model: "cohere.embed-english-v3",
    });

    expect(vec).toEqual([9, 8, 7]);
    expect(calls[0]!.modelId).toBe("cohere.embed-english-v3");
    expect(calls[0]!.body).toEqual({
      texts: ["q"],
      input_type: "search_document",
    });
  });

  test("an AWS error yields null", async () => {
    setBedrockInvoker(async () => {
      throw new Error("AccessDeniedException");
    });

    expect(await generateEmbedding("x", "bedrock")).toBeNull();
  });

  test("a missing embedding field yields null", async () => {
    const { invoker } = stubInvoker({});
    setBedrockInvoker(invoker);

    expect(await generateEmbedding("x", "bedrock")).toBeNull();
  });
});
