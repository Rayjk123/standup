import { afterEach, describe, expect, test } from "bun:test";
import {
  formatKnowledgeForFile,
  formatSearchResults,
  handleToolCall,
  missingMentionsMarker,
  tools,
  type KnowledgeForFileResult,
} from "./tools.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const RESULT: KnowledgeForFileResult = {
  project: "standup",
  path: "packages/knowledge/src/search.ts",
  docs: [
    {
      id: "a1",
      projectId: "standup",
      slug: "ranking",
      title: "Ranking",
      excerpt: "Ranking lives in `packages/knowledge/src/search.ts`.",
      match: "file",
      mentions: ["packages/knowledge/src/search.ts"],
    },
    {
      id: "b2",
      projectId: "standup",
      slug: "entry",
      title: "Entry point",
      excerpt: "Call `searchKnowledge()`.",
      match: "symbol",
      mentions: ["searchKnowledge"],
      missingMentions: [{ kind: "symbol", target: "rankCandidates" }],
    },
    {
      id: "c3",
      projectId: "standup",
      slug: "store",
      title: "Store",
      excerpt: "Rows are written by store.ts.",
      match: "directory",
      mentions: ["packages/knowledge/src/store.ts"],
    },
  ],
};

describe("formatKnowledgeForFile", () => {
  test("one entry per doc: what matched, the get_knowledge_doc pivot, the excerpt", () => {
    const out = formatKnowledgeForFile("search.ts", RESULT);
    expect(out.startsWith("Docs about packages/knowledge/src/search.ts (standup):")).toBe(true);
    expect(out).toContain("[ranking] Ranking (standup; names `packages/knowledge/src/search.ts`; id a1)");
    expect(out).toContain("[entry] Entry point (standup; names `searchKnowledge`, defined here; id b2)");
    expect(out).toContain("[store] Store (standup; same directory: `packages/knowledge/src/store.ts`; id c3)");
    expect(out).toContain('→ full body: get_knowledge_doc(id="a1")');
    expect(out).toContain("Rows are written by store.ts.");
  });

  test("a doc naming code that is gone carries the marker", () => {
    const out = formatKnowledgeForFile("search.ts", RESULT);
    const entry = out.split("\n\n").find((e) => e.includes("[entry]"))!;
    expect(entry).toContain("⚠ names 1 symbol no longer in the code: rankCandidates");
  });

  test("no docs says so, with the path and project looked in and any warning", () => {
    const out = formatKnowledgeForFile("x.ts", { project: "standup", path: "src/x.ts", docs: [], projectWarning: "w" });
    expect(out).toBe("No confident knowledge docs name src/x.ts (or a file in its directory) in standup.\n\nWarning: w");
  });
});

describe("missingMentionsMarker", () => {
  const cases: Array<[Array<{ kind: "file" | "symbol"; target: string }>, string]> = [
    [[{ kind: "symbol", target: "x" }, { kind: "symbol", target: "y" }], "names 2 symbols no longer in the code: x, y"],
    [[{ kind: "file", target: "a.ts" }], "names 1 file no longer in the code: a.ts"],
    [[{ kind: "file", target: "a.ts" }, { kind: "file", target: "b.ts" }, { kind: "symbol", target: "y" }], "names 2 files and 1 symbol no longer in the code: a.ts, b.ts, y"],
  ];
  for (const [missing, text] of cases) {
    test(text, () => {
      expect(missingMentionsMarker(missing).startsWith(`⚠ ${text}`)).toBe(true);
    });
  }
});

describe("search_knowledge hits with missing mentions", () => {
  test("are marked under the hit header", () => {
    const out = formatSearchResults("q", {
      project: "standup",
      results: [
        {
          id: "d1",
          projectId: "standup",
          slug: "ranking",
          title: "Ranking",
          excerpt: "…",
          score: 0.9,
          source: "text",
          missingMentions: [{ kind: "symbol", target: "rankCandidates" }],
        },
      ],
    });
    expect(out).toContain("⚠ names 1 symbol no longer in the code: rankCandidates");
  });
});

describe("knowledge_for_file MCP tool", () => {
  test("is listed with a required path", () => {
    const tool = tools.find((t) => t.name === "knowledge_for_file");
    expect(tool?.inputSchema.required).toEqual(["path"]);
  });

  test("posts the path, project and scoped:true to the about-file endpoint and formats the reply", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify(RESULT), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const out = await handleToolCall(
      "knowledge_for_file",
      { path: "packages/knowledge/src/search.ts", project: "standup" },
      "http://collector.test"
    );

    expect(capturedUrl).toBe("http://collector.test/api/knowledge/about-file");
    expect(capturedBody.path).toBe("packages/knowledge/src/search.ts");
    expect(capturedBody.project).toBe("standup");
    expect(capturedBody.scoped).toBe(true);
    expect(out.content[0].text).toContain("[ranking] Ranking");
  });
});
