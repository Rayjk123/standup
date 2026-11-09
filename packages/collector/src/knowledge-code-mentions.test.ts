import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore, type CodeSymbolRow, type KnowledgeDoc } from "@standup/knowledge";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";
import { resetSessionProjectCaches } from "./session-project.js";
import {
  demoteMissingMentions,
  describeMissingMentions,
  docsAboutFile,
  repoRelativePath,
} from "./knowledge-code-mentions.js";

/**
 * Read-time doc→code mentions: the search route marks and demotes a hit that
 * names code gone from the HEAD index, and /api/knowledge/about-file lists the
 * confident docs about a file.
 */

const P = "alpha";
const QUERY = "mentionmarker";

const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: P,
    slug: "doc",
    title: "Doc",
    body: `${QUERY} body`,
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "code",
    originClass: "owner",
    scope: "project",
    ...overrides,
  };
}

function fileRow(file: string): CodeSymbolRow {
  return { file, line: 0, name: file.split("/").pop()!, kind: "file" };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetSessionProjectCaches();
});

interface Fixture {
  store: Store;
  app: ReturnType<typeof createServer>;
  knowledge: KnowledgeStore;
  repo: string;
  index: (files: string[], symbols: Array<[file: string, name: string]>) => void;
}

function setUp(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "kb-code-mentions-"));
  const store = createStore(":memory:");
  cleanups.push(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });
  upsertProject(store.db, { id: P, name: "Alpha", branch: "main", repos: [repo] });
  const knowledge = new KnowledgeStore(store.db);
  const index = (files: string[], symbols: Array<[file: string, name: string]>) =>
    knowledge.replaceCodeSymbols(P, repo, "sha", files, [
      ...files.map(fileRow),
      ...symbols.map(([file, name], i) => ({ file, name, line: i + 1, kind: "function" })),
    ]);
  index(
    ["src/search.ts", "src/store.ts", "src/util.ts", "src/deep/inner.ts"],
    [
      ["src/search.ts", "searchKnowledge"],
      ["src/search.ts", "rankCandidates"],
      ["src/store.ts", "upsertDoc"],
    ]
  );
  return { store, app: createServer(store, () => {}, null), knowledge, repo, index };
}

async function post<T>(app: Fixture["app"], route: string, body: Record<string, unknown>): Promise<T> {
  const res = await app.request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedIn("alice") },
    body: JSON.stringify({ cwd: "/tmp/kb-code-mentions-none", project: P, scoped: true, ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

interface SearchReply {
  results: Array<{ slug: string; missingMentions?: Array<{ kind: string; target: string }> }>;
}

interface AboutFileReply {
  project: string;
  path: string;
  docs: Array<{
    slug: string;
    match: string;
    mentions: string[];
    excerpt: string;
    missingMentions?: Array<{ kind: string; target: string }>;
  }>;
}

describe("demoteMissingMentions", () => {
  const cases: Array<{ name: string; items: string[]; flagged: string[]; positions?: number; expected: string[] }> = [
    { name: "nothing flagged keeps the order", items: ["a", "b", "c"], flagged: [], expected: ["a", "b", "c"] },
    { name: "moves down two places", items: ["a", "b", "c", "d"], flagged: ["a"], expected: ["b", "c", "a", "d"] },
    { name: "stops at the end", items: ["a", "b"], flagged: ["a"], expected: ["b", "a"] },
    { name: "never passes another flagged item", items: ["a", "b", "c"], flagged: ["a", "b"], expected: ["c", "a", "b"] },
    { name: "positions is configurable", items: ["a", "b", "c"], flagged: ["a"], positions: 1, expected: ["b", "a", "c"] },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(demoteMissingMentions(c.items, (i) => c.flagged.includes(i), c.positions)).toEqual(c.expected);
    });
  }
});

describe("describeMissingMentions", () => {
  test("counts files and symbols and lists them", () => {
    expect(
      describeMissingMentions([
        { kind: "symbol", target: "x" },
        { kind: "symbol", target: "y" },
      ])
    ).toBe("names 2 symbols no longer in the code: x, y");
    expect(
      describeMissingMentions([
        { kind: "file", target: "a.ts" },
        { kind: "symbol", target: "y" },
      ])
    ).toBe("names 1 file and 1 symbol no longer in the code: a.ts, y");
  });
});

describe("repoRelativePath", () => {
  test("resolves repo-relative, checkout-absolute, worktree-absolute and unindexed paths", () => {
    const { knowledge, repo } = setUp();
    expect(repoRelativePath(knowledge, P, "./src/search.ts")).toBe("src/search.ts");
    expect(repoRelativePath(knowledge, P, `${repo}/src/store.ts`, [repo])).toBe("src/store.ts");
    expect(repoRelativePath(knowledge, P, "/wt/alpha/branch/src/util.ts")).toBe("src/util.ts");
    // A file the index has not seen yet, in an indexed directory of a worktree.
    expect(repoRelativePath(knowledge, P, "/wt/alpha/branch/src/new-file.ts")).toBe("src/new-file.ts");
    expect(repoRelativePath(knowledge, P, `${repo}/src/new-file.ts`, [repo])).toBe("src/new-file.ts");
    expect(repoRelativePath(knowledge, P, "/elsewhere/entirely/new.ts")).toBeNull();
  });
});

describe("POST /api/knowledge/search — missing mentions", () => {
  test("a hit naming a symbol gone from the index is marked and moved below a clean hit", async () => {
    const { app, knowledge, index } = setUp();
    // The stale doc ranks first on text (the query term twice), the clean one second.
    knowledge.upsertDoc(
      doc({ slug: "stale", title: "Ranking", body: `${QUERY} ${QUERY}: \`rankCandidates\` in src/search.ts orders hits.` })
    );
    knowledge.upsertDoc(doc({ slug: "clean", title: "Store", body: `${QUERY} \`upsertDoc\` writes rows.` }));

    const before = await post<SearchReply>(app, "/api/knowledge/search", { query: QUERY });
    expect(before.results.find((r) => r.slug === "stale")?.missingMentions).toBeUndefined();

    // rankCandidates is removed from src/search.ts at the new HEAD.
    index(["src/search.ts"], [["src/search.ts", "searchKnowledge"]]);

    const after = await post<SearchReply>(app, "/api/knowledge/search", { query: QUERY });
    const stale = after.results.find((r) => r.slug === "stale");
    expect(stale?.missingMentions).toEqual([{ kind: "symbol", target: "rankCandidates" }]);
    expect(after.results.find((r) => r.slug === "clean")?.missingMentions).toBeUndefined();
    const order = after.results.map((r) => r.slug);
    expect(order.indexOf("clean")).toBeLessThan(order.indexOf("stale"));
  });
});

describe("/api/knowledge/about-file", () => {
  function seed(f: Fixture): void {
    f.knowledge.upsertDoc(
      doc({ slug: "search-doc", title: "Search", body: "# Search\n\nRanking lives in `src/search.ts`; see `rankCandidates`." })
    );
    f.knowledge.upsertDoc(doc({ slug: "symbol-doc", title: "Entry", body: "Call `searchKnowledge()` for hybrid search." }));
    f.knowledge.upsertDoc(doc({ slug: "sibling-doc", title: "Store", body: "Rows are written by src/store.ts." }));
    f.knowledge.upsertDoc(doc({ slug: "deep-doc", title: "Deep", body: "See src/deep/inner.ts." }));
    f.knowledge.upsertDoc(doc({ slug: "disputed-doc", title: "Disputed", body: "Old claim about `src/search.ts`." }));
    f.knowledge.setDocVerdict(P, "disputed-doc", "disputed", []);
  }

  test("POST lists file, symbol and same-directory docs; disputed and nested-directory docs are left out", async () => {
    const f = setUp();
    seed(f);
    const reply = await post<AboutFileReply>(f.app, "/api/knowledge/about-file", { path: "src/search.ts" });
    expect(reply.project).toBe(P);
    expect(reply.path).toBe("src/search.ts");
    expect(reply.docs.map((d) => [d.slug, d.match])).toEqual([
      ["search-doc", "file"],
      ["symbol-doc", "symbol"],
      ["sibling-doc", "directory"],
    ]);
    expect(reply.docs[0].mentions).toEqual(["src/search.ts", "rankCandidates"]);
    expect(reply.docs[0].excerpt).toBe("Ranking lives in `src/search.ts`; see `rankCandidates`.");
  });

  test("GET takes the same fields as query parameters and resolves an absolute path", async () => {
    const f = setUp();
    seed(f);
    const res = await f.app.request(
      `/api/knowledge/about-file?project=${P}&path=${encodeURIComponent(`${f.repo}/src/search.ts`)}`,
      { headers: signedIn("alice") }
    );
    expect(res.status).toBe(200);
    const reply = (await res.json()) as AboutFileReply;
    expect(reply.path).toBe("src/search.ts");
    expect(reply.docs.map((d) => d.slug)).toContain("search-doc");
  });

  test("a doc whose mention left the index carries it", async () => {
    const f = setUp();
    seed(f);
    await post<AboutFileReply>(f.app, "/api/knowledge/about-file", { path: "src/search.ts" });
    f.index(["src/search.ts"], [["src/search.ts", "searchKnowledge"]]);
    const reply = await post<AboutFileReply>(f.app, "/api/knowledge/about-file", { path: "src/search.ts" });
    expect(reply.docs.find((d) => d.slug === "search-doc")?.missingMentions).toEqual([
      { kind: "symbol", target: "rankCandidates" },
    ]);
  });

  test("a missing path is a 400", async () => {
    const { app } = setUp();
    const res = await app.request("/api/knowledge/about-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: P }),
    });
    expect(res.status).toBe(400);
  });

  test("docsAboutFile honours the audience: another user's personal doc is not listed", () => {
    const f = setUp();
    f.knowledge.upsertDoc(doc({ slug: "bob-note", scope: "user", ownerUser: "bob", body: "`src/util.ts` gotcha" }));
    f.knowledge.upsertDoc(doc({ slug: "team-note", body: "`src/util.ts` decision" }));
    const { docs } = docsAboutFile(f.knowledge, {
      projectId: P,
      path: "src/util.ts",
      audience: { projectId: P, user: "alice" },
    });
    expect(docs.map((d) => d.slug)).toEqual(["team-note"]);
  });

  test("docsAboutFile with refresh: false reads the mentions table as the last refresh left it", () => {
    const f = setUp();
    f.knowledge.upsertDoc(doc({ slug: "team-note", body: "`src/util.ts` decision" }));
    const lookup = (refresh?: boolean) =>
      docsAboutFile(f.knowledge, {
        projectId: P,
        path: "src/util.ts",
        audience: { projectId: P },
        ...(refresh === undefined ? {} : { refresh }),
      }).docs.map((d) => d.slug);
    expect(lookup(false)).toEqual([]);
    expect(lookup()).toEqual(["team-note"]);
    expect(lookup(false)).toEqual(["team-note"]);
  });
});
