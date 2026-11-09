/**
 * A provider id. Kept as an open string (not a closed union) so any provider
 * registered on the seam is a valid id at call sites without churn.
 */
export type EmbeddingProvider = string;

/**
 * Per-call configuration threaded from the collector's environment down to the
 * plugin. Every field is optional: a plugin falls back to its own default model
 * and base URL, and the API-key providers fall back to their env vars, so the
 * zero-config local path keeps working unchanged.
 */
export interface EmbeddingConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  /**
   * An explicit output width for models that emit a configurable one — Titan v2
   * embeds at 1024 by default but also accepts 256/512. A provider that honors
   * it must produce vectors of exactly this width; leave it unset to take the
   * model's native width. It is part of the corpus embedding fingerprint, so
   * changing it re-embeds the corpus even when the model id is unchanged.
   */
  dimensions?: number;
  /**
   * Abort signal for the underlying provider request. Runtime-only — NOT part
   * of the corpus embedding fingerprint (that is provider+model+dimensions),
   * so setting it never re-embeds. generateEmbedding supplies a default
   * timeout signal when a caller passes none, so a provider that accepts the
   * TCP connection but never responds can't hang the request indefinitely.
   */
  signal?: AbortSignal;
}

/**
 * Default per-request timeout for a provider embedding call, in ms. Bounds the
 * network dependency so a hung endpoint degrades to a null embedding (and, at
 * the launcher, to no injected block) rather than stalling the caller — the
 * product/spec retrieval runs inline on the launch spawn path, so an unbounded
 * embedding request would wedge the launch in "starting". Env-tunable; a bad or
 * non-positive value falls back to the default.
 */
export const EMBEDDING_REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.STANDUP_EMBEDDING_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 15000;
})();

/**
 * The pluggable embedding-provider seam, mirroring the KnowledgeBackend seam.
 * A plugin owns one provider id, declares the model it embeds with by default,
 * optionally declares its output dimensionality, and turns text into a vector
 * (or null when it can't). `embed` is only ever reached through
 * generateEmbedding, which centralizes error handling — so a plugin may let its
 * own errors throw.
 */
export interface EmbeddingProviderPlugin {
  id: string;
  defaultModel: string;
  dimensions?: number;
  embed(text: string, config: EmbeddingConfig): Promise<number[] | null>;
  /**
   * An identifier of the exact model weights `model` currently resolves to, for
   * a provider whose model names are mutable tags (a local Ollama re-pull keeps
   * the name and swaps the weights). Null when it can't be determined. Omitted
   * by providers whose model ids are immutable, where the id itself is the
   * identity (see resolveModelDigest).
   */
  modelDigest?(model: string, config: EmbeddingConfig): Promise<string | null>;
}

/** The settings key holding the fingerprint the chunk corpus was embedded under. */
export const EMBEDDING_FINGERPRINT_KEY = "embedding_provider_fingerprint";

/** Upper bound on a model-digest lookup, so a hung provider never stalls boot. */
export const MODEL_DIGEST_TIMEOUT_MS = 3000;

const PROVIDERS = new Map<string, EmbeddingProviderPlugin>();

/** Adds (or replaces) a provider on the seam, keyed by its id. */
export function registerEmbeddingProvider(plugin: EmbeddingProviderPlugin): void {
  PROVIDERS.set(plugin.id, plugin);
}

/** The plugin registered under `id`, or undefined if none is. */
export function resolveEmbeddingProvider(
  id: string
): EmbeddingProviderPlugin | undefined {
  return PROVIDERS.get(id);
}

/**
 * The model a provider embeds with when no explicit model is configured — the
 * same default generateEmbedding applies. Exposed so the stats endpoint can
 * report which model retrieval is running on. Falls back to the provider id
 * for an unregistered provider so the stats never surface an empty model.
 */
export function defaultModelFor(provider: EmbeddingProvider): string {
  return resolveEmbeddingProvider(provider)?.defaultModel ?? provider;
}

export async function generateEmbedding(
  text: string,
  provider: EmbeddingProvider,
  config?: EmbeddingConfig
): Promise<number[] | null> {
  const plugin = resolveEmbeddingProvider(provider);
  if (!plugin) {
    console.error(`Unknown embedding provider: ${provider}`);
    return null;
  }

  // Supply a default timeout signal when the caller passes none, so every
  // provider fetch is bounded even for callers that don't thread their own.
  const effectiveConfig: EmbeddingConfig =
    config?.signal !== undefined
      ? config
      : { ...(config ?? {}), signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS) };

  try {
    return await plugin.embed(text, effectiveConfig);
  } catch (err) {
    // An abort (timeout) surfaces here the same as any other failure — a null
    // embedding, which the search path treats as no embedding recall.
    console.error(`Embedding generation failed:`, err);
    return null;
  }
}

/**
 * The identity of the weights a provider's configured model resolves to: the
 * plugin's modelDigest when it declares one, else the model id. Null when the
 * plugin declares a lookup and it fails, times out, or finds nothing — callers
 * treat that as "unknown", never as a change. Never throws.
 */
export async function resolveModelDigest(
  provider: EmbeddingProvider,
  config: EmbeddingConfig = {},
  timeoutMs = MODEL_DIGEST_TIMEOUT_MS
): Promise<string | null> {
  const plugin = resolveEmbeddingProvider(provider);
  if (!plugin) return null;
  const model = config.model ?? plugin.defaultModel;
  if (!plugin.modelDigest) return model;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const lookup = plugin.modelDigest(model, { ...config, signal });
    const timeout = new Promise<null>((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    return await Promise.race([lookup, timeout]);
  } catch (err) {
    console.warn(`[knowledge] model digest lookup for ${provider}:${model} failed:`, err);
    return null;
  }
}

const ollamaProvider: EmbeddingProviderPlugin = {
  id: "ollama",
  defaultModel: "nomic-embed-text",
  dimensions: 768,
  embed(text, config) {
    return embedWithOllama(
      text,
      config.model ?? this.defaultModel,
      config.baseUrl ?? "http://localhost:11434",
      config.signal
    );
  },
  modelDigest(model, config) {
    return ollamaModelDigest(model, config.baseUrl ?? "http://localhost:11434", config.signal);
  },
};

// The digest of the local model `model` names, from /api/tags. An untagged name
// resolves to its `:latest` tag, the same resolution Ollama applies on embed.
async function ollamaModelDigest(
  model: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string | null> {
  const response = await fetch(`${baseUrl}/api/tags`, { signal });
  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }
  const data = (await response.json()) as {
    models?: Array<{ name?: string; model?: string; digest?: string }>;
  };
  const wanted = model.includes(":") ? [model] : [model, `${model}:latest`];
  const match = (data.models ?? []).find(
    (m) => wanted.includes(m.name ?? "") || wanted.includes(m.model ?? "")
  );
  return match?.digest ?? null;
}

const voyageProvider: EmbeddingProviderPlugin = {
  id: "voyage",
  defaultModel: "voyage-3-lite",
  dimensions: 512,
  embed(text, config) {
    return embedWithVoyage(
      text,
      config.model ?? this.defaultModel,
      config.baseUrl ?? "https://api.voyageai.com",
      config.apiKey,
      config.signal
    );
  },
};

const openaiProvider: EmbeddingProviderPlugin = {
  id: "openai",
  defaultModel: "text-embedding-3-small",
  dimensions: 1536,
  embed(text, config) {
    return embedWithOpenAI(
      text,
      config.model ?? this.defaultModel,
      config.baseUrl ?? "https://api.openai.com",
      config.apiKey,
      config.signal
    );
  },
};

registerEmbeddingProvider(ollamaProvider);
registerEmbeddingProvider(voyageProvider);
registerEmbeddingProvider(openaiProvider);

async function embedWithOllama(
  text: string,
  model: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<number[] | null> {
  const response = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal,
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
  apiKey?: string,
  signal?: AbortSignal
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
    signal,
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
  apiKey?: string,
  signal?: AbortSignal
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
    signal,
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0]?.embedding ?? null;
}

/**
 * Sentence-window chunking of plain text, with no awareness of markdown
 * structure (knowledge docs are chunked by chunkMarkdown).
 */
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

/**
 * The version of chunkMarkdown's output. Part of the embedding fingerprint, so
 * any change to how a body is split or what text is embedded per chunk must
 * bump it — that re-embeds the corpus instead of mixing chunkings.
 */
export const CHUNKER_VERSION = 3;

/** Sections are packed together into one chunk up to this many characters. */
export const CHUNK_TARGET_CHARS = 1000;
/** A section up to this size stays whole; a single block is split above it. */
export const CHUNK_MAX_CHARS = 1500;
/** Trailing prose repeated at the start of the next chunk of the same section. */
export const CHUNK_OVERLAP_CHARS = 150;

/** One chunk of a markdown doc. */
export interface MarkdownChunk {
  /** The chunk's own markdown, unprefixed — what is stored and served as an excerpt. */
  text: string;
  /** What is embedded: the heading path ("Title › H1 › H2"), a blank line, then `text`. */
  embedText: string;
}

/** The separator joining a chunk's heading path. */
export const HEADING_PATH_SEPARATOR = " › ";

interface MarkdownBlock {
  text: string;
  kind: "heading" | "prose" | "code";
}

interface MarkdownSection {
  /** Heading texts from the outermost enclosing heading down to this section's own. */
  path: string[];
  blocks: MarkdownBlock[];
}

// A fence opener: three or more backticks or tildes, indented at most three
// spaces. A backtick fence's info string cannot itself contain a backtick
// (CommonMark), so a line like ```js``` is inline code, not an opener.
function fenceOpener(line: string): string | null {
  const m = line.match(/^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/);
  return m ? m[1] : null;
}

function fenceCloser(marker: string): RegExp {
  const ch = marker[0] === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${ch}{${marker.length},}[ \\t]*$`);
}

// Splits a markdown body into heading-delimited sections of blocks: a heading
// line, a paragraph (consecutive non-blank lines), or a whole fenced code block.
// A `#` line inside a fence is code, never a heading.
function parseMarkdownSections(body: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let stack: Array<{ level: number; text: string }> = [];
  let current: MarkdownSection = { path: [], blocks: [] };
  let para: string[] = [];
  let fence: { closer: RegExp; lines: string[] } | null = null;

  const flushPara = () => {
    const text = para.join("\n").trim();
    if (text) current.blocks.push({ text, kind: "prose" });
    para = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      fence.lines.push(line);
      if (fence.closer.test(line)) {
        current.blocks.push({ text: fence.lines.join("\n"), kind: "code" });
        fence = null;
      }
      continue;
    }
    const open = fenceOpener(line);
    if (open) {
      flushPara();
      fence = { closer: fenceCloser(open), lines: [line] };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) {
      flushPara();
      if (current.blocks.length > 0) sections.push(current);
      const level = heading[1].length;
      stack = stack.filter((h) => h.level < level);
      stack.push({ level, text: heading[2].trim() });
      current = {
        path: stack.map((h) => h.text),
        blocks: [{ text: line.trim(), kind: "heading" }],
      };
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    para.push(line);
  }
  // An unterminated fence runs to the end of the doc, as markdown renders it.
  if (fence) current.blocks.push({ text: fence.lines.join("\n"), kind: "code" });
  flushPara();
  if (current.blocks.length > 0) sections.push(current);
  return sections;
}

// A piece of an oversized block, with the separator that joined it to the
// previous piece in the original text.
interface SplitUnit {
  text: string;
  sep: string;
}

// Hard-splits text with no usable boundary at word gaps, then at `max`.
function splitWords(text: string, max: number, firstSep: string): SplitUnit[] {
  const out: SplitUnit[] = [];
  let cur = "";
  const emit = (t: string) => out.push({ text: t, sep: out.length === 0 ? firstSep : " " });
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > max) {
      if (cur) emit(cur);
      cur = "";
      for (let i = 0; i < word.length; i += max) emit(word.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + word.length > max) {
      emit(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) emit(cur);
  return out;
}

// Greedily packs `units` back together, each with its original separator, into
// pieces of at most `max` chars.
function packUnits(units: SplitUnit[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const unit of units) {
    if (cur && cur.length + unit.sep.length + unit.text.length > max) {
      out.push(cur);
      cur = unit.text;
    } else {
      cur = cur ? cur + unit.sep + unit.text : unit.text;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Splits one block into pieces of at most `max` chars (a block that fits is
// returned as is). Prose splits at line, then sentence, then word boundaries,
// keeping the original separators. Code splits only at line boundaries, and
// each piece is re-wrapped in the block's fence so every piece still reads as a
// code block.
function splitBlock(block: MarkdownBlock, max: number): MarkdownBlock[] {
  if (block.text.length <= max) return [block];
  if (block.kind === "code") {
    const lines = block.text.split("\n");
    const opener = lines[0];
    const marker = fenceOpener(opener) ?? "```";
    const closed = lines.length > 1 && fenceCloser(marker).test(lines[lines.length - 1]);
    const inner = lines.slice(1, closed ? -1 : undefined);
    const budget = max - opener.length - marker.length - 2;
    // An opener (info string) that leaves less than half the chunk for code is
    // not repeated: the block is split as plain lines, opener and closer
    // included once where they stand.
    if (budget < max / 2) {
      const units = lines.flatMap((l) =>
        l.length > max ? splitWords(l, max, "\n") : [{ text: l, sep: "\n" }]
      );
      return packUnits(units, max).map((text) => ({ text, kind: "code" as const }));
    }
    const units = inner.flatMap((l) =>
      l.length > budget ? splitWords(l, budget, "\n") : [{ text: l, sep: "\n" }]
    );
    const pieces = packUnits(units, budget);
    // Every piece is re-fenced so it reads as code; the last piece of a fence
    // the source never closed gets no closer, so it ends the way the doc does.
    return pieces.map((piece, i) => ({
      text: `${opener}\n${piece}${closed || i < pieces.length - 1 ? `\n${marker}` : ""}`,
      kind: "code" as const,
    }));
  }
  const units = block.text.split("\n").flatMap((line): SplitUnit[] => {
    if (line.length <= max) return [{ text: line, sep: "\n" }];
    return line
      .split(/(?<=[.!?])\s+/)
      .flatMap((sentence, i) => {
        const sep = i === 0 ? "\n" : " ";
        return sentence.length <= max ? [{ text: sentence, sep }] : splitWords(sentence, max, sep);
      });
  });
  return packUnits(units, max).map((text) => ({ text, kind: block.kind }));
}

// The trailing sentences of a prose piece, up to `max` chars, starting at a
// sentence or line boundary. Empty when the piece ends in one sentence longer
// than `max`.
function overlapTail(text: string, max: number): string {
  if (text.length <= max) return "";
  const tail = text.slice(-max);
  const boundary = tail.search(/(?<=[.!?])\s+\S|\n\S/);
  if (boundary === -1) return "";
  return tail.slice(boundary).trim();
}

function commonPrefix(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < paths[0].length; i++) {
    const h = paths[0][i];
    if (paths.every((p) => p[i] === h)) out.push(h);
    else break;
  }
  return out;
}

/**
 * Splits a markdown doc into retrieval chunks along its structure: sections
 * break at headings, a fenced code block is never cut unless it alone exceeds
 * `max` (then it splits at line boundaries, each piece re-fenced), consecutive
 * small sections are packed together up to `target`, a section up to `max`
 * stays whole, and a section longer than that is split into `target`-sized
 * runs of blocks with a short prose overlap between them. A chunk never ends on
 * a bare heading. Each chunk's `embedText` is prefixed with its heading path —
 * the doc title and the headings enclosing the chunk — so the vector carries
 * the context the chunk's own text may not repeat; `text` stays unprefixed so
 * excerpts read as the doc does.
 */
export function chunkMarkdown(
  title: string,
  body: string,
  options: { target?: number; max?: number; overlap?: number } = {}
): MarkdownChunk[] {
  const target = options.target ?? CHUNK_TARGET_CHARS;
  const max = Math.max(target, options.max ?? CHUNK_MAX_CHARS);
  const overlap = options.overlap ?? CHUNK_OVERLAP_CHARS;
  const SEP = "\n\n";

  interface Part {
    text: string;
    kind: MarkdownBlock["kind"] | "overlap";
    section: number;
  }
  const sections = parseMarkdownSections(body);
  const chunks: Array<{ parts: Part[]; sections: Set<number> }> = [];
  let cur: Part[] = [];

  const size = (parts: Part[]) =>
    parts.reduce((n, p, i) => n + p.text.length + (i > 0 ? SEP.length : 0), 0);
  const hasContent = (parts: Part[]) =>
    parts.some((p) => p.kind === "prose" || p.kind === "code");
  const push = (parts: Part[]) => {
    if (parts.length > 0) chunks.push({ parts, sections: new Set(parts.map((p) => p.section)) });
  };
  // Ends the current chunk. Trailing bare headings move to the next chunk so a
  // heading always travels with the content under it.
  const flush = (): Part[] => {
    let cut = cur.length;
    while (cut > 0 && cur[cut - 1].kind === "heading") cut--;
    if (cut === 0) return cur;
    push(cur.slice(0, cut));
    return cur.slice(cut);
  };
  // Before content of `length` chars joins a chunk holding only carried bare
  // headings: when the two together would exceed max, the headings become a
  // chunk of their own, so carrying headings forward never pushes a chunk past
  // max.
  const makeRoomFor = (length: number) => {
    if (cur.length > 0 && !hasContent(cur) && size(cur) + SEP.length + length > max) {
      push(cur);
      cur = [];
    }
  };

  sections.forEach((section, index) => {
    const parts: Part[] = section.blocks.map((b) => ({ text: b.text, kind: b.kind, section: index }));
    const sectionSize = size(parts);

    // A section joins the current chunk while the pair stays within target, or
    // within max when the current chunk is still small (a short intro section
    // would otherwise become a near-empty chunk of its own).
    const combined = size(cur) + SEP.length + sectionSize;
    if (cur.length > 0 && (combined <= target || (size(cur) < target / 3 && combined <= max))) {
      cur.push(...parts);
      return;
    }
    if (sectionSize <= max) {
      if (hasContent(cur)) cur = flush();
      makeRoomFor(sectionSize);
      cur.push(...parts);
      return;
    }

    if (hasContent(cur)) cur = flush();
    for (const block of section.blocks) {
      // Prose is cut to target so the overlap carried into the next piece still
      // fits under max; code is cut only when it exceeds max.
      for (const piece of splitBlock(block, block.kind === "code" ? max : target)) {
        const part: Part = { text: piece.text, kind: piece.kind, section: index };
        if (hasContent(cur) && size(cur) + SEP.length + part.text.length > target) {
          const last = cur[cur.length - 1];
          cur = flush();
          if (cur.length === 0 && last.kind === "prose" && last.section === index) {
            const tail = overlapTail(last.text, overlap);
            if (tail && tail.length + SEP.length + part.text.length <= max) {
              cur.push({ text: tail, kind: "overlap", section: index });
            }
          }
        }
        makeRoomFor(part.text.length);
        cur.push(part);
      }
    }
  });
  // A doc that ends on bare headings folds them into its last chunk when they
  // fit under max.
  if (
    !hasContent(cur) &&
    chunks.length > 0 &&
    size([...chunks[chunks.length - 1].parts, ...cur]) <= max
  ) {
    const last = chunks[chunks.length - 1];
    last.parts.push(...cur);
    for (const p of cur) last.sections.add(p.section);
  } else {
    push(cur);
  }

  const normalizedTitle = title.trim().toLowerCase();
  return chunks.map(({ parts, sections: used }) => {
    const text = parts.map((p) => p.text).join(SEP);
    const path = commonPrefix([...used].map((i) => sections[i].path));
    if (path.length > 0 && path[0].trim().toLowerCase() === normalizedTitle) path.shift();
    const prefix = [title.trim(), ...path].filter(Boolean).join(HEADING_PATH_SEPARATOR);
    return { text, embedText: prefix ? `${prefix}${SEP}${text}` : text };
  });
}

export async function embedChunks(
  chunks: string[],
  provider: EmbeddingProvider,
  config?: EmbeddingConfig
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk, provider, config);
    results.push(embedding);
  }

  return results;
}
