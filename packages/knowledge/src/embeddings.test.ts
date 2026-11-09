import { expect, test, describe, afterEach } from "bun:test";
import {
  generateEmbedding,
  defaultModelFor,
  registerEmbeddingProvider,
  resolveEmbeddingProvider,
  EMBEDDING_REQUEST_TIMEOUT_MS,
  chunkMarkdown,
  resolveModelDigest,
  HEADING_PATH_SEPARATOR,
  CHUNK_MAX_CHARS,
  type EmbeddingConfig,
  type EmbeddingProviderPlugin,
} from "./embeddings.js";

/**
 * The provider seam. Asserts the three built-ins register + resolve + still hit
 * the same URL/model/body they did before the seam existed, and that a plugin
 * defined entirely outside this module can register and be resolved — proving
 * the seam is extensible without editing core.
 */

type FetchCall = { url: string; init: RequestInit };

// Swaps in a fetch that records the call and returns a canned provider-shaped
// body, so the built-in embed functions can be exercised offline.
function stubFetch(body: unknown): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("built-in providers", () => {
  test("all three are registered and resolvable", () => {
    for (const id of ["ollama", "voyage", "openai"]) {
      const plugin = resolveEmbeddingProvider(id);
      expect(plugin).toBeDefined();
      expect(plugin!.id).toBe(id);
    }
  });

  test("declare their default models", () => {
    expect(defaultModelFor("ollama")).toBe("nomic-embed-text");
    expect(defaultModelFor("voyage")).toBe("voyage-3-lite");
    expect(defaultModelFor("openai")).toBe("text-embedding-3-small");
  });

  test("ollama embeds against /api/embeddings with the default model", async () => {
    const { calls, restore } = stubFetch({ embedding: [0.1, 0.2, 0.3] });
    restoreFetch = restore;

    const vec = await generateEmbedding("hello", "ollama");

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/embeddings");
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({ model: "nomic-embed-text", prompt: "hello" });
  });

  test("voyage embeds against /v1/embeddings with a bearer key", async () => {
    const { calls, restore } = stubFetch({ data: [{ embedding: [1, 2] }] });
    restoreFetch = restore;

    const vec = await generateEmbedding("q", "voyage", { apiKey: "vk" });

    expect(vec).toEqual([1, 2]);
    expect(calls[0]!.url).toBe("https://api.voyageai.com/v1/embeddings");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer vk");
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({
      model: "voyage-3-lite",
      input: "q",
      input_type: "query",
    });
  });

  test("openai embeds against /v1/embeddings with a bearer key", async () => {
    const { calls, restore } = stubFetch({ data: [{ embedding: [3, 4] }] });
    restoreFetch = restore;

    const vec = await generateEmbedding("q", "openai", {
      apiKey: "ok",
      model: "text-embedding-3-large",
    });

    expect(vec).toEqual([3, 4]);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ok");
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({ model: "text-embedding-3-large", input: "q" });
  });

  test("baseUrl override is honored", async () => {
    const { calls, restore } = stubFetch({ embedding: [0] });
    restoreFetch = restore;

    await generateEmbedding("hi", "ollama", { baseUrl: "http://ollama:9999" });

    expect(calls[0]!.url).toBe("http://ollama:9999/api/embeddings");
  });
});

describe("registry", () => {
  test("an unknown provider returns null", async () => {
    const vec = await generateEmbedding("x", "does-not-exist");
    expect(vec).toBeNull();
  });

  test("a dummy provider registers and resolves without editing core", async () => {
    const dummy: EmbeddingProviderPlugin = {
      id: "dummy-test-provider",
      defaultModel: "dummy-v1",
      dimensions: 3,
      async embed(text, config) {
        return [text.length, config.model === "dummy-v1" ? 1 : 0, 42];
      },
    };
    registerEmbeddingProvider(dummy);

    expect(resolveEmbeddingProvider("dummy-test-provider")).toBe(dummy);
    expect(defaultModelFor("dummy-test-provider")).toBe("dummy-v1");

    const vec = await generateEmbedding("abcd", "dummy-test-provider", {
      model: "dummy-v1",
    });
    expect(vec).toEqual([4, 1, 42]);
  });

  test("a throwing plugin is caught and yields null", async () => {
    registerEmbeddingProvider({
      id: "boom",
      defaultModel: "x",
      async embed() {
        throw new Error("kaboom");
      },
    });
    expect(await generateEmbedding("x", "boom")).toBeNull();
  });
});

/**
 * The embedding request is a network dependency on the launch spawn path (the
 * launcher retrieves product/spec + code knowledge inline before tmux). A hung
 * endpoint must not wedge the launch, so generateEmbedding bounds every call
 * with a timeout AbortSignal and a plugin that honors it degrades to null.
 */
describe("request timeout / abort", () => {
  test("supplies a default timeout signal when the caller passes none", async () => {
    let seen: EmbeddingConfig | undefined;
    registerEmbeddingProvider({
      id: "signal-capture",
      defaultModel: "x",
      async embed(_text, config) {
        seen = config;
        return [1];
      },
    });

    await generateEmbedding("q", "signal-capture");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    // A fresh timeout signal is not already aborted.
    expect(seen?.signal?.aborted).toBe(false);
    expect(EMBEDDING_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("honors an explicit caller signal instead of overriding it", async () => {
    const controller = new AbortController();
    let seen: EmbeddingConfig | undefined;
    registerEmbeddingProvider({
      id: "signal-passthrough",
      defaultModel: "x",
      async embed(_text, config) {
        seen = config;
        return [1];
      },
    });

    await generateEmbedding("q", "signal-passthrough", { signal: controller.signal });
    expect(seen?.signal).toBe(controller.signal);
  });

  test("a plugin that aborts on its signal degrades to null (a hang cannot wedge the caller)", async () => {
    registerEmbeddingProvider({
      id: "hang-then-abort",
      defaultModel: "x",
      embed(_text, config) {
        // Never resolves on its own — resolves to null only when the timeout
        // signal fires, exactly as a real fetch aborts on a stalled endpoint.
        return new Promise((_resolve, reject) => {
          config.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        });
      },
    });

    // A short explicit timeout stands in for the module default so the test is fast.
    const result = await generateEmbedding("q", "hang-then-abort", {
      signal: AbortSignal.timeout(20),
    });
    expect(result).toBeNull();
  });
});

describe("resolveModelDigest", () => {
  test("ollama reads the digest of the configured model's tag from /api/tags", async () => {
    const stub = stubFetch({
      models: [
        { name: "other:latest", digest: "sha-other" },
        { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", digest: "sha-nomic" },
      ],
    });
    restoreFetch = stub.restore;
    expect(await resolveModelDigest("ollama", { baseUrl: "http://ollama.test" })).toBe("sha-nomic");
    expect(stub.calls[0].url).toBe("http://ollama.test/api/tags");
  });

  test("a provider without a digest hook is identified by its model id", async () => {
    registerEmbeddingProvider({
      id: "digestless-test",
      defaultModel: "fixed-model-v3",
      embed: async () => [1],
    });
    expect(await resolveModelDigest("digestless-test")).toBe("fixed-model-v3");
    expect(await resolveModelDigest("digestless-test", { model: "pinned" })).toBe("pinned");
  });

  test("a failing, empty or hung lookup degrades to null without throwing", async () => {
    let mode: "throw" | "none" | "hang" = "throw";
    registerEmbeddingProvider({
      id: "digest-faulty-test",
      defaultModel: "m",
      embed: async () => [1],
      modelDigest: async () => {
        if (mode === "throw") throw new Error("connection refused");
        if (mode === "none") return null;
        return new Promise<string>(() => {});
      },
    });
    expect(await resolveModelDigest("digest-faulty-test")).toBeNull();
    mode = "none";
    expect(await resolveModelDigest("digest-faulty-test")).toBeNull();
    mode = "hang";
    const started = Date.now();
    expect(await resolveModelDigest("digest-faulty-test", {}, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await resolveModelDigest("not-registered-test")).toBeNull();
  });
});

describe("chunkMarkdown", () => {
  test("splits at headings and prefixes the embedded text with the heading path", () => {
    const body = [
      "# Setup",
      "",
      "Intro paragraph.",
      "",
      "## Install",
      "",
      "Run the installer. ".repeat(40),
      "",
      "## Configure",
      "",
      "Set the env vars. ".repeat(40),
    ].join("\n");
    const chunks = chunkMarkdown("Guide", body, { target: 600, max: 900 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].text.startsWith("# Setup")).toBe(true);
    expect(chunks[0].text).toContain("## Install");
    expect(chunks[0].embedText.startsWith(`Guide${HEADING_PATH_SEPARATOR}Setup\n\n`)).toBe(true);
    expect(chunks[1].text.startsWith("## Configure")).toBe(true);
    expect(chunks[1].embedText.startsWith(["Guide", "Setup", "Configure"].join(HEADING_PATH_SEPARATOR))).toBe(true);
    // The stored text carries no prefix.
    expect(chunks[1].text).not.toContain(HEADING_PATH_SEPARATOR);
  });

  test("never splits inside a fenced code block that fits, even across a '#' line", () => {
    const code = ["```bash", "# not a heading", ...Array.from({ length: 30 }, (_, i) => `echo line-${i}`), "```"].join("\n");
    const body = `${"Lead in. ".repeat(60)}\n\n${code}\n\nAfter the block.`;
    const chunks = chunkMarkdown("Doc", body, { target: 400, max: 700 });
    const holder = chunks.filter((c) => c.text.includes("echo line-0"));
    expect(holder.length).toBe(1);
    expect(holder[0].text).toContain(code);
    for (const c of chunks) {
      expect((c.text.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  test("a fence larger than the max splits on line boundaries, each piece re-fenced", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `step_${i}();`);
    const body = ["```ts", ...lines, "```"].join("\n");
    const chunks = chunkMarkdown("Doc", body, { target: 500, max: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(800);
      expect(c.text.startsWith("```ts\n")).toBe(true);
      expect(c.text.endsWith("\n```")).toBe(true);
      seen.push(...c.text.split("\n").filter((l) => l.startsWith("step_")));
    }
    expect(seen).toEqual(lines);
  });

  test("packs small sections together and never ends a chunk on a bare heading", () => {
    const body = [
      "## A", "", "short a", "",
      "## B", "", "short b", "",
      "## 3.", "",
      "### 3.1", "", "long section. ".repeat(120),
    ].join("\n");
    const chunks = chunkMarkdown("Doc", body, { target: 300, max: 1200 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].text).toBe("## A\n\nshort a\n\n## B\n\nshort b");
    // "## 3." has no content of its own: it travels with its subsection.
    expect(chunks[1].text.startsWith("## 3.\n\n### 3.1")).toBe(true);
    for (const c of chunks) {
      expect(c.text.trim().split("\n").at(-1)!.match(/^#{1,6} /)).toBeNull();
    }
  });

  test("a long section is split with a short overlap that stays within the section", () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} explains a detail.`);
    const body = `## Only\n\n${sentences.join(" ")}`;
    const chunks = chunkMarkdown("Doc", body, { target: 500, max: 800, overlap: 120 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800);
    const tail = chunks[0].text.slice(-60);
    expect(chunks[1].text).toContain(tail.slice(tail.indexOf("Sentence")));
  });

  test("an empty body yields no chunks, a heading-less body is one titled chunk", () => {
    expect(chunkMarkdown("T", "")).toEqual([]);
    expect(chunkMarkdown("T", "just text")).toEqual([{ text: "just text", embedText: "T\n\njust text" }]);
  });

  test("an H1 equal to the title is not repeated in the prefix", () => {
    const [chunk] = chunkMarkdown("Retry policy", "# Retry policy\n\nThree attempts.");
    expect(chunk.embedText.startsWith("Retry policy\n\n# Retry policy")).toBe(true);
  });
});

describe("chunkMarkdown edge cases", () => {
  const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

  test("leading bare headings carried forward never push a chunk past max", () => {
    const headings = Array.from({ length: 6 }, (_, i) => `${"#".repeat(i + 1)} ${"H".repeat(200)}`);
    const chunks = chunkMarkdown("Doc", `${headings.join("\n")}\n\n${words(260)}`);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    const joined = chunks.map((c) => c.text).join("\n");
    expect(words(260).split(" ").every((w) => joined.includes(w))).toBe(true);
    // A following section that fits under max on its own.
    const fitting = chunkMarkdown("Doc", `${headings.join("\n")}\n\n## Next\n\n${words(150)}`);
    for (const c of fitting) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  test("an unterminated fence is not given a closer it never had", () => {
    const body = "intro\n\n```js\nconst a = 1;\nconst b = 2;";
    const chunks = chunkMarkdown("Doc", body);
    expect(chunks.map((c) => c.text).join("\n\n")).toBe(body);

    const long = "```js\n" + "line of code\n".repeat(400);
    const pieces = chunkMarkdown("Doc", long);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.slice(0, -1).every((c) => c.text.endsWith("\n```"))).toBe(true);
    expect(pieces.at(-1)!.text.endsWith("```")).toBe(false);
  });

  test("a fence opener longer than max splits the block into a handful of bounded chunks", () => {
    const body = "```" + "a".repeat(1600) + "\n" + "code line\n".repeat(300) + "```";
    const chunks = chunkMarkdown("Doc", body);
    expect(chunks.length).toBeLessThan(10);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  test("a backtick line whose info string holds backticks is not a fence opener", () => {
    const body = `\`\`\`js\`\`\`\n\n${words(250, "alpha")}\n\n# Later\n\n${words(250, "beta")}`;
    const chunks = chunkMarkdown("Doc", body);
    const later = chunks.find((c) => c.text.includes("beta0"));
    expect(later?.embedText.startsWith(`Doc${HEADING_PATH_SEPARATOR}Later`)).toBe(true);
  });
});
