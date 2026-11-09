import { afterEach, describe, expect, test } from "bun:test";
import { resolveSessionId } from "./session-id.js";
import { handleToolCall } from "./tools.js";

describe("resolveSessionId", () => {
  test("uses CLAUDE_CODE_SESSION_ID when Claude Code exports it, regardless of cwd", async () => {
    expect(
      await resolveSessionId("/no/transcripts/here", { CLAUDE_CODE_SESSION_ID: "1f64f87b-aaaa" })
    ).toBe("1f64f87b-aaaa");
  });
});

describe("scratch-fallback warning", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function respondWith(body: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("search_knowledge shows the collector's projectWarning", async () => {
    respondWith({ results: [], project: "scratch", projectWarning: "defaulted to scratch" });
    const res = await handleToolCall("search_knowledge", { query: "q" }, "http://collector.test");
    expect(res.content[0].text).toContain("Warning: defaulted to scratch");
  });

  test("propose_knowledge shows it too, and it is omitted when absent", async () => {
    respondWith({ ok: true, slug: "s", published: true, mode: "accept", projectWarning: "defaulted to scratch" });
    const propose = await handleToolCall(
      "propose_knowledge",
      { slug: "s", title: "t", body: "b" },
      "http://collector.test"
    );
    expect(propose.content[0].text).toContain("Warning: defaulted to scratch");

    respondWith({ results: [], project: "acme" });
    const clean = await handleToolCall("search_knowledge", { query: "q" }, "http://collector.test");
    expect(clean.content[0].text).not.toContain("Warning:");
  });
});
