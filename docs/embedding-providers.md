# Embedding providers

Standup's knowledge corpus is retrieved with hybrid FTS + vector search. The vector half runs through
a **pluggable embedding-provider seam** in `@standup/knowledge` (`packages/knowledge/src/embeddings.ts`),
mirroring the `KnowledgeBackend` seam: text-to-vector is an interface plus a registry, so a new provider
plugs in without editing any core switch.

## The seam

A provider is a plugin that owns one provider id, declares the model it embeds with by default,
optionally declares its output width, and turns text into a vector (or `null` when it can't):

```ts
interface EmbeddingProviderPlugin {
  id: string;
  defaultModel: string;
  dimensions?: number;
  embed(text: string, config: EmbeddingConfig): Promise<number[] | null>;
}
```

Per-call configuration is threaded from the collector's environment down to the plugin. Every field is
optional — an unset field lets the plugin apply its own default model / base URL, or its env-var
fallback for API keys:

```ts
interface EmbeddingConfig {
  model?: string;    // overrides the plugin's defaultModel
  apiKey?: string;   // API-key providers fall back to their env var when unset
  baseUrl?: string;  // overrides the plugin's endpoint
  region?: string;   // AWS-creds providers (Bedrock); falls back to AWS_REGION
  dimensions?: number; // explicit output width for models that emit a configurable one
}
```

The registry is a module-level map keyed by provider id:

- `registerEmbeddingProvider(plugin)` — adds (or replaces) a provider.
- `resolveEmbeddingProvider(id)` — returns the plugin, or `undefined`.
- `defaultModelFor(id)` — the model a provider embeds with when none is configured (falls back to the
  id for an unregistered provider so stats never surface an empty model).

Call sites never touch the map. They go through two entry points, both of which centralize error
handling — any thrown error or unknown provider becomes `null` (best-effort), so a plugin may let its
own errors throw:

- `generateEmbedding(text, provider, config?)` — one vector.
- `embedChunks(chunks, provider, config?)` — a vector per chunk (skipping any that came back `null`).

`EmbeddingProvider` is an open `string` (not a closed union) so any registered id is a valid id at call
sites without churn.

## Registering a provider

Register at import time — the built-ins do exactly this at the bottom of `embeddings.ts`, and the
Bedrock plugin does it in `bedrock.ts`. Anything imported before the collector reads
`EMBEDDING_PROVIDER` is available to select. A minimal custom provider:

```ts
import {
  registerEmbeddingProvider,
  type EmbeddingProviderPlugin,
} from "@standup/knowledge";

const myProvider: EmbeddingProviderPlugin = {
  id: "acme",
  defaultModel: "acme-embed-1",
  dimensions: 1024,
  async embed(text, config) {
    const res = await fetch(`${config.baseUrl ?? "https://api.acme.example"}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey ?? process.env.ACME_API_KEY}`,
      },
      body: JSON.stringify({ model: config.model ?? "acme-embed-1", input: text }),
    });
    if (!res.ok) throw new Error(`Acme API error: ${res.status}`); // becomes null upstream
    const data = (await res.json()) as { embedding: number[] };
    return data.embedding;
  },
};

registerEmbeddingProvider(myProvider);
```

Select it by starting the collector with `EMBEDDING_PROVIDER=acme` (and, if needed,
`EMBEDDING_MODEL` / `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL`).

## Built-in providers

Selected via `EMBEDDING_PROVIDER`; per-provider knobs come from the collector env (see below). Each is
resilient: any error → `null`, leaving the doc FTS-searchable until a later sync fills the gap.

| Provider | `EMBEDDING_PROVIDER` | Default model | Dims | Endpoint (override with `EMBEDDING_BASE_URL`) | Key |
|---|---|---|---|---|---|
| Ollama (local) | `ollama` | `nomic-embed-text` | 768 | `http://localhost:11434` (`/api/embeddings`) | none |
| Voyage | `voyage` | `voyage-3-lite` | 512 | `https://api.voyageai.com` (`/v1/embeddings`) | `VOYAGE_API_KEY` |
| OpenAI | `openai` | `text-embedding-3-small` | 1536 | `https://api.openai.com` (`/v1/embeddings`) | `OPENAI_API_KEY` |
| Bedrock | `bedrock` | `amazon.titan-embed-text-v2:0` | 1024 | AWS Bedrock Runtime | ambient AWS creds |

**Local Ollama is the zero-config default.** When `EMBEDDING_PROVIDER` is unset the collector probes
`http://localhost:11434` and, if an Ollama daemon answers, selects `ollama` automatically. If nothing
answers (or the probe errors) it falls back to text-only (FTS) search rather than blocking startup.
Bedrock / Voyage / OpenAI are opt-in via `EMBEDDING_PROVIDER`.

### Collector environment

The collector (`packages/collector/src/index.ts`) reads these and threads them into `EmbeddingConfig`.
An unset or empty var is dropped so it never shadows a plugin default:

- `EMBEDDING_PROVIDER` — provider id (`ollama` | `voyage` | `openai` | `bedrock` | any registered id).
  Unset → auto-detect Ollama, else text-only.
- `EMBEDDING_MODEL` → `config.model`
- `EMBEDDING_API_KEY` → `config.apiKey` (Voyage/OpenAI also fall back to their own env var)
- `EMBEDDING_BASE_URL` → `config.baseUrl`
- `AWS_REGION` → `config.region` (Bedrock)
- `EMBEDDING_DIMENSIONS` → `config.dimensions` (integer; models with a configurable
  width, e.g. Titan v2's 256/512). Non-numeric values are dropped.

The same provider + config feed both the index path (`KnowledgeSync` → `embedChunks`) and the query
path (`LocalMarkdownBackend.search` → `searchKnowledge`), so documents and queries always embed
identically.

## Bedrock setup

The `bedrock` plugin (`packages/knowledge/src/bedrock.ts`) calls AWS Bedrock Runtime `InvokeModel`
through `@aws-sdk/client-bedrock-runtime`.

- **Credentials: ambient only.** The `BedrockRuntimeClient` resolves credentials through the SDK's
  standard provider chain (role / profile / env). No secrets are read or stored by Standup.
- **Region:** `config.region ?? process.env.AWS_REGION`. One client is cached per region.
- **Default model:** `amazon.titan-embed-text-v2:0` (1024-dim). Override with `EMBEDDING_MODEL`.
- **Titan width:** Titan v2 also accepts 256 / 512. Set `EMBEDDING_DIMENSIONS` (which threads into
  `config.dimensions`) to request a narrower width — it's sent in the request body and is part of the
  corpus fingerprint (below).
- **Model families:** the request/response shape is selected from the model id. `amazon.titan-embed-text-*`
  uses `{ inputText } → { embedding }`; `cohere.embed-*-v3` uses
  `{ texts, input_type } → { embeddings: [[…]] }`. A new family plugs in by adding a
  `BedrockEmbeddingModel` entry and routing its id in `modelFor` — no transport or plugin change.
- **Testing:** the plugin reaches Bedrock only through a swappable `BedrockInvoker`. `setBedrockInvoker`
  installs a stand-in (the unit suite mocks it); pass nothing to restore the live SDK transport. Live
  Bedrock calls are a manual/opt-in check, never part of the unit suite.

To run on Bedrock:

```sh
EMBEDDING_PROVIDER=bedrock AWS_REGION=us-west-2 bun run <collector-start>
# optional: EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
# optional: EMBEDDING_DIMENSIONS=512   # Titan v2 narrow width (256/512)
```

## Dimension-switch / re-embed behavior

The chunk index (`knowledge_chunks`) holds vectors of exactly **one** width and **one** embedding
space. Mixing is silently wrong: a query vector of a different width scores every stored chunk 0 (the
`a.length !== b.length` guard in `cosineSimilarity`), and a same-width switch into a different space
scores with meaningless non-zero values that `cosineSimilarity` can't detect.

To prevent that, the active embedding configuration is fingerprinted and recorded in the `settings`
table under `embedding_provider_fingerprint`. The fingerprint is `provider:model`, with `:dimensions`
appended only when an explicit width is set (that width is the one axis that changes the output
independently of the model id — e.g. Titan v2's 256/512/1024). Model resolves the same way `embedChunks`
does: explicit `config.model`, else the plugin's default.

On startup, before the initial sync, `KnowledgeSync.reindexOnProviderChange()` compares the active
fingerprint to the stored one:

- **Changed** → clear `knowledge_chunks` and let `syncAll` re-embed the whole corpus at the active
  provider (correctness over cost; logged clearly). The new fingerprint is recorded only *after* the
  clear, so a switch interrupted before the re-embed finishes is retried on the next boot.
- **Unchanged** → no-op.
- **No provider configured** → no-op (the query path never embeds; stale chunks are inert).
- **Unregistered provider id** (a typo / case-mismatch in `EMBEDDING_PROVIDER`) → bail without touching
  the chunks or the recorded fingerprint, so the existing embeddings survive and a corrected value
  resolves back to an unchanged fingerprint with no re-embed.
- **No fingerprint on record** (a corpus embedded before this guard shipped) but chunks exist → treat
  them as unproven and re-embed once, since a static width comparison can't prove they belong to the
  active provider's space.

This handles the provider/model **switch** case. The same-provider **backfill** case — a doc synced
text-only before a provider was configured, then given embeddings on a later sync — is handled
separately by `syncProject`'s empty-chunk-set backfill.
