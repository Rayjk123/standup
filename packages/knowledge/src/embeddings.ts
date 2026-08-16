export type EmbeddingProvider = "ollama" | "voyage" | "openai";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  ollama: "nomic-embed-text",
  voyage: "voyage-3-lite",
  openai: "text-embedding-3-small",
};

const DEFAULT_URLS: Record<EmbeddingProvider, string> = {
  ollama: "http://localhost:11434",
  voyage: "https://api.voyageai.com",
  openai: "https://api.openai.com",
};

export async function generateEmbedding(
  text: string,
  provider: EmbeddingProvider,
  config?: Partial<EmbeddingConfig>
): Promise<number[] | null> {
  const model = config?.model ?? DEFAULT_MODELS[provider];
  const baseUrl = config?.baseUrl ?? DEFAULT_URLS[provider];

  try {
    switch (provider) {
      case "ollama":
        return await embedWithOllama(text, model, baseUrl);
      case "voyage":
        return await embedWithVoyage(text, model, baseUrl, config?.apiKey);
      case "openai":
        return await embedWithOpenAI(text, model, baseUrl, config?.apiKey);
      default:
        console.error(`Unknown embedding provider: ${provider}`);
        return null;
    }
  } catch (err) {
    console.error(`Embedding generation failed:`, err);
    return null;
  }
}

async function embedWithOllama(
  text: string,
  model: string,
  baseUrl: string
): Promise<number[] | null> {
  const response = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}

async function embedWithVoyage(
  text: string,
  model: string,
  baseUrl: string,
  apiKey?: string
): Promise<number[] | null> {
  if (!apiKey) {
    apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      console.error("VOYAGE_API_KEY not set");
      return null;
    }
  }

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
      input_type: "query",
    }),
  });

  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0]?.embedding ?? null;
}

async function embedWithOpenAI(
  text: string,
  model: string,
  baseUrl: string,
  apiKey?: string
): Promise<number[] | null> {
  if (!apiKey) {
    apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("OPENAI_API_KEY not set");
      return null;
    }
  }

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0]?.embedding ?? null;
}

export function chunkText(
  text: string,
  maxChunkSize = 512,
  overlap = 50
): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);

  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        // Keep overlap from the end of the current chunk
        const words = currentChunk.split(/\s+/);
        const overlapWords = words.slice(-Math.ceil(overlap / 5));
        currentChunk = overlapWords.join(" ") + " ";
      }
    }
    currentChunk += sentence + " ";
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export async function embedChunks(
  chunks: string[],
  provider: EmbeddingProvider,
  config?: Partial<EmbeddingConfig>
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk, provider, config);
    results.push(embedding);
  }

  return results;
}
