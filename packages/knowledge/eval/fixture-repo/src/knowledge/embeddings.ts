export const EMBEDDING_PROVIDER = "ollama";
export const EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDING_DIM = 768;

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

/**
 * Identifies the vector space stored chunks were embedded in. A mismatch
 * against the stored fingerprint triggers a full re-embed. The model digest is
 * not part of it, so a re-pulled model with the same name is not detected.
 */
export function embeddingFingerprint(): string {
  return `${EMBEDDING_PROVIDER}:${EMBEDDING_MODEL}`;
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status}`);
  const json = (await res.json()) as { embeddings: number[][] };
  return json.embeddings.map((v) => {
    if (v.length !== EMBEDDING_DIM) throw new Error(`unexpected embedding width ${v.length}`);
    return Float32Array.from(v);
  });
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
