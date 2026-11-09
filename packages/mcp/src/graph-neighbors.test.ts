import { expect, test, describe, afterEach } from "bun:test";
import { formatNeighbors, handleToolCall } from "./tools.js";

/**
 * graph_neighbors is a pivot tool: an agent that found a trusted doc via
 * search_knowledge walks to its neighbors. The formatter must carry a neighbor's
 * trust/coherence through that pivot so an untrusted or contradicted neighbor is
 * flagged rather than handed over silently as authoritative — mirroring what
 * search_knowledge surfaces on a SearchResult.
 */
describe("formatNeighbors", () => {
  test("labels an untrusted-origin neighbor and a contradicted neighbor", () => {
    const out = formatNeighbors([
      {
        docId: "u",
        projectId: "p1",
        slug: "untrusted-doc",
        title: "Untrusted",
        kind: "related",
        weight: 2,
        originClass: "untrusted",
      },
      {
        docId: "c",
        projectId: "p2",
        slug: "contradicted-doc",
        title: "Contradicted",
        kind: "co-citation",
        weight: 1,
        originClass: "agent",
        verdict: "contradicted",
      },
    ]);

    const lines = out.split("\n");
    const untrustedLine = lines.find((l) => l.includes("[untrusted-doc]"))!;
    const contradictedLine = lines.find((l) => l.includes("[contradicted-doc]"))!;

    expect(untrustedLine).toContain("⚠");
    expect(untrustedLine.toLowerCase()).toContain("untrusted");
    expect(contradictedLine).toContain("⚠");
    expect(contradictedLine).toContain("CONTRADICTED");
  });

  test("labels a disputed neighbor distinctly from a contradicted one", () => {
    const out = formatNeighbors([
      {
        docId: "d",
        projectId: "p",
        slug: "disputed-doc",
        title: "Disputed",
        kind: "provenance",
        weight: 0,
        originClass: "owner",
        verdict: "disputed",
      },
    ]);

    expect(out).toContain("DISPUTED");
    expect(out).not.toContain("CONTRADICTED");
  });

  test("leaves a trusted, clean neighbor unadorned but still tags a non-code source kind", () => {
    const out = formatNeighbors([
      {
        docId: "ok",
        projectId: "p",
        slug: "good-doc",
        title: "Good",
        kind: "related",
        weight: 5,
        originClass: "owner",
        verdict: "clean",
        sourceKind: "spec",
      },
    ]);

    expect(out).not.toContain("⚠");
    expect(out).toContain("[good-doc] spec Good");
    expect(out).toContain("id ok");
  });

  test("prints the edge evidence next to the kind so a pivot reads WHY", () => {
    const out = formatNeighbors([
      {
        docId: "n",
        projectId: "p",
        slug: "uses-node",
        title: "Uses Node",
        kind: "contradicts",
        weight: 2,
        originClass: "owner",
        evidence: "doc says Bun; uses-node says Node",
      },
    ]);

    // The relation reads "contradicts · <finding>" — its substance, not just kind.
    expect(out).toContain("contradicts · doc says Bun; uses-node says Node");
    expect(out).toContain("weight 2");
  });
});

/**
 * The pivot from search_knowledge must be gated the same way search is: the
 * agent tool sets `scoped: true` so the collector resolves the user server-side
 * and drops out-of-scope neighbors. A missing flag would default the endpoint to
 * the permissive browse path and leak another user's private docs — the very
 * hole the scope gate exists to close.
 */
describe("graph_neighbors MCP tool forwards scoped:true", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts scoped:true and the docId to the neighbors endpoint", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ neighbors: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleToolCall("graph_neighbors", { docId: "doc-123" }, "http://collector.test");

    expect(capturedBody.scoped).toBe(true);
    expect(capturedBody.docId).toBe("doc-123");
  });
});
