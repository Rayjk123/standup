import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  registerEmbeddingProvider,
  type EmbeddingConfig,
  type EmbeddingProviderPlugin,
} from "./embeddings.js";
import {
  registerRerankProvider,
  scoresFromIndexed,
  type RerankProviderPlugin,
} from "./rerank.js";

/**
 * The model Bedrock embeds with when none is configured. Titan v2 emits 1024
 * dimensions.
 */
export const BEDROCK_DEFAULT_MODEL = "amazon.titan-embed-text-v2:0";

/**
 * The request/response contract for one Bedrock embedding-model family, kept
 * separate from transport so each family's body and response shape is isolated.
 * A new family (e.g. cohere.embed-*-v3) plugs in by adding an entry and routing
 * its model id in modelFor — no transport or plugin change.
 */
interface BedrockEmbeddingModel {
  buildBody(text: string, config: EmbeddingConfig): unknown;
  parseResponse(payload: unknown): number[] | null;
}

// Titan text embeddings (titan-embed-text-*): { inputText } -> { embedding }. Titan v2 defaults
// to 1024 dimensions and also accepts 512/256 through a `dimensions` body field.
const titanModel: BedrockEmbeddingModel = {
  buildBody(text, config) {
    const body: { inputText: string; dimensions?: number } = { inputText: text };
    if (config.dimensions !== undefined) body.dimensions = config.dimensions;
    return body;
  },
  parseResponse(payload) {
    const data = payload as { embedding?: number[] };
    return data.embedding ?? null;
  },
};

// cohere.embed-*-v3: { texts, input_type } -> { embeddings: [[...]] }.
const cohereModel: BedrockEmbeddingModel = {
  buildBody(text) {
    return { texts: [text], input_type: "search_document" };
  },
  parseResponse(payload) {
    const data = payload as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  },
};

// Selects the request/response shape from the model id, defaulting to Titan.
function modelFor(modelId: string): BedrockEmbeddingModel {
  if (modelId.startsWith("cohere.embed")) return cohereModel;
  return titanModel;
}

/**
 * Sends a JSON body to a Bedrock model and returns the parsed JSON response.
 * The plugin reaches Bedrock only through this, so a caller (or a test) can
 * supply a stand-in without live AWS access.
 */
export type BedrockInvoker = (
  modelId: string,
  body: unknown,
  region?: string,
  signal?: AbortSignal
) => Promise<unknown>;

const clients = new Map<string, BedrockRuntimeClient>();

// One client per region, resolving ambient AWS credentials through the SDK's
// standard provider chain — no secrets are read or stored here.
function clientFor(region?: string): BedrockRuntimeClient {
  const key = region ?? "";
  let client = clients.get(key);
  if (!client) {
    client = new BedrockRuntimeClient(region ? { region } : {});
    clients.set(key, client);
  }
  return client;
}

const defaultInvoker: BedrockInvoker = async (modelId, body, region, signal) => {
  const client = clientFor(region);
  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(JSON.stringify(body)),
    }),
    // The SDK aborts the in-flight request when this fires, so the default
    // timeout signal generateEmbedding supplies bounds the Bedrock path too.
    { abortSignal: signal }
  );
  return JSON.parse(new TextDecoder().decode(response.body));
};

let invoker: BedrockInvoker = defaultInvoker;

/** Replaces the Bedrock transport; pass nothing to restore the SDK default. */
export function setBedrockInvoker(next?: BedrockInvoker): void {
  invoker = next ?? defaultInvoker;
}

export const bedrockProvider: EmbeddingProviderPlugin = {
  id: "bedrock",
  defaultModel: BEDROCK_DEFAULT_MODEL,
  dimensions: 1024,
  async embed(text, config) {
    const modelId = config.model ?? this.defaultModel;
    const region = config.region ?? process.env.AWS_REGION;
    const model = modelFor(modelId);
    const payload = await invoker(modelId, model.buildBody(text, config), region, config.signal);
    return model.parseResponse(payload);
  },
};

registerEmbeddingProvider(bedrockProvider);

/** The Bedrock rerank model used when RERANK_MODEL is unset. */
export const BEDROCK_RERANK_DEFAULT_MODEL = "cohere.rerank-v3-5:0";

/**
 * Cohere Rerank on Bedrock, on the rerank seam (rerank.ts). Same transport and
 * ambient credentials as the embedding plugin. Request
 * `{query, documents, top_n, api_version: 2}` → `{results: [{index,
 * relevance_score}]}`; top_n is the full document count so every doc is scored.
 * Region: RERANK_REGION, else AWS_REGION.
 */
export const bedrockRerankProvider: RerankProviderPlugin = {
  id: "bedrock",
  defaultModel: BEDROCK_RERANK_DEFAULT_MODEL,
  async rerank(query, docs, config) {
    const modelId = config.model ?? this.defaultModel;
    const region = config.region ?? process.env.AWS_REGION;
    const body = { query, documents: docs, top_n: docs.length, api_version: 2 };
    const payload = await invoker(modelId, body, region, config.signal);
    return scoresFromIndexed((payload as { results?: unknown })?.results, docs.length);
  },
};

registerRerankProvider(bedrockRerankProvider);
