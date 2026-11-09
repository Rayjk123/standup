import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import type { CodeSymbolRow } from "./store.js";
import type { KnowledgeDoc } from "./types.js";
import { extractCodeMentions, refreshCodeMentions, resolveMentionedPath } from "./code-mentions.js";

const P = "proj";
const REPO = "/repo";

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: "d1",
    projectId: P,
    slug: "arch",
    title: "Arch",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/arch.md",
    ...overrides,
  };
}

function fileRow(file: string): CodeSymbolRow {
  return { file, line: 0, name: file.split("/").pop()!, kind: "file" };
}

/** Indexes `files` with the given symbols, replacing whatever those files held. */
function index(store: KnowledgeStore, files: string[], symbols: Array<[file: string, name: string, line: number]>): void {
  store.replaceCodeSymbols(P, REPO, "sha", files, [
    ...files.map(fileRow),
    ...symbols.map(([file, name, line]) => ({ file, line, name, kind: "function" })),
  ]);
}

function seeded(): KnowledgeStore {
  const store = new KnowledgeStore(new Database(":memory:"));
  index(
    store,
    ["packages/knowledge/src/store.ts", "packages/collector/src/server.ts", "packages/mcp/src/index.ts", "packages/collector/src/index.ts"],
    [
      ["packages/knowledge/src/store.ts", "KnowledgeStore", 241],
      ["packages/knowledge/src/store.ts", "lookupSymbols", 2539],
      ["packages/collector/src/server.ts", "createServer", 1900],
      ["packages/collector/src/server.ts", "RANK_RRF_SHARE", 311],
    ]
  );
  return store;
}

describe("extractCodeMentions", () => {
  const cases: Array<{ name: string; body: string; files?: string[]; symbols?: string[] }> = [
    { name: "backticked repo path", body: "See `packages/knowledge/src/store.ts`.", files: ["packages/knowledge/src/store.ts"], symbols: [] },
    { name: "bare path in prose, trailing period", body: "Edit packages/collector/src/server.ts.", files: ["packages/collector/src/server.ts"] },
    { name: "path with line suffix and ./ prefix", body: "at `./src/store.ts:2479`", files: ["src/store.ts"] },
    { name: "backticked bare filename", body: "the `store.ts` module", files: ["store.ts"] },
    { name: "bare filename in prose is not a path", body: "Node.js and e.g. store.ts here", files: [] },
    { name: "URL is not a path", body: "https://example.com/docs/page.html and `https://x.dev/a/b.ts`", files: [], symbols: [] },
    { name: "version numbers are ignored", body: "Upgrade to 1.2.3 or v2.0 (`1.2.3`)", files: [], symbols: [] },
    { name: "unknown extension is ignored", body: "see `logs/output.log` and data/x.bin", files: [] },
    { name: "path inside a fenced block", body: "```sh\nbun test packages/knowledge/src/code-mentions.test.ts\nfooBar()\n```", files: ["packages/knowledge/src/code-mentions.test.ts"], symbols: [] },
    { name: "camelCase symbol", body: "call `lookupSymbols` first", symbols: ["lookupSymbols"] },
    { name: "call form", body: "`refresh()` then `fooBar(x, y)`", symbols: ["refresh", "fooBar"] },
    { name: "dotted member", body: "`KnowledgeStore.getDoc`", symbols: ["KnowledgeStore.getDoc"] },
    { name: "SCREAMING_CASE constant", body: "`RANK_RRF_SHARE` is 0.5", symbols: ["RANK_RRF_SHARE"] },
    { name: "plain words and keywords are not symbols", body: "`scope`, `true`, `null`, `default`, `Database`", symbols: [] },
    { name: "commands with spaces are not symbols", body: "run `bun run typecheck`", symbols: [] },
    { name: "duplicates collapse", body: "`fooBar` and `fooBar` and `a/b.ts` a/b.ts", symbols: ["fooBar"], files: ["a/b.ts"] },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const out = extractCodeMentions(c.body);
      if (c.files) expect(out.filter((m) => m.kind === "file").map((m) => m.mention)).toEqual(c.files);
      if (c.symbols) expect(out.filter((m) => m.kind === "symbol").map((m) => m.mention)).toEqual(c.symbols);
    });
  }

  test("a dotted member tries the member, then its owner", () => {
    const [m] = extractCodeMentions("`store.lookupSymbols`");
    expect(m.candidates).toEqual(["lookupSymbols"]);
    const [n] = extractCodeMentions("`KnowledgeStore.getDoc()`");
    expect(n.candidates).toEqual(["getDoc", "KnowledgeStore"]);
  });
});

describe("resolveMentionedPath", () => {
  const store = seeded();
  const cases: Array<[string, string | null]> = [
    ["packages/knowledge/src/store.ts", "packages/knowledge/src/store.ts"],
    ["src/store.ts", "packages/knowledge/src/store.ts"],
    ["store.ts", "packages/knowledge/src/store.ts"],
    // Two indexed index.ts files: a bare name is ambiguous, a longer suffix is not.
    ["index.ts", null],
    ["mcp/src/index.ts", "packages/mcp/src/index.ts"],
    ["/home/u/worktrees/standup/branch/packages/collector/src/server.ts", "packages/collector/src/server.ts"],
    ["/elsewhere/server.ts", null],
    ["packages/knowledge/src/missing.ts", null],
  ];
  for (const [path, expected] of cases) {
    test(`${path} → ${expected}`, () => {
      expect(resolveMentionedPath(store, P, path)).toBe(expected);
    });
  }
});

describe("refreshCodeMentions", () => {
  const BODY =
    "The store lives in `packages/knowledge/src/store.ts`; `KnowledgeStore.lookupSymbols()` is the lookup. " +
    "`createServer` wires routes. `notInTheCode` and src/nowhere.ts are not indexed.";

  test("records only mentions that resolve, with their file and line", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: BODY }));
    expect(refreshCodeMentions(store, P).refreshed).toBe(1);
    const rows = store.getCodeMentions(id).map((r) => [r.kind, r.mention, r.target, r.file, r.line]);
    expect(rows).toEqual([
      ["file", "packages/knowledge/src/store.ts", "packages/knowledge/src/store.ts", "packages/knowledge/src/store.ts", null],
      ["symbol", "KnowledgeStore.lookupSymbols", "lookupSymbols", "packages/knowledge/src/store.ts", 2539],
      ["symbol", "createServer", "createServer", "packages/collector/src/server.ts", 1900],
    ]);
  });

  test("is idempotent: a second pass re-reads nothing and changes nothing", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: BODY }));
    refreshCodeMentions(store, P);
    const before = store.getCodeMentions(id);
    expect(refreshCodeMentions(store, P).refreshed).toBe(0);
    expect(store.getCodeMentions(id)).toEqual(before);
  });

  test("re-extracts a doc whose body changed and drops what it stopped naming", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: BODY }));
    refreshCodeMentions(store, P);
    store.upsertDoc(doc({ body: "Only `createServer` now.", updatedAt: new Date("2026-09-01T00:00:00Z") }));
    expect(refreshCodeMentions(store, P).refreshed).toBe(1);
    expect(store.getCodeMentions(id).map((r) => r.target)).toEqual(["createServer"]);
  });

  test("a mention that disappears from the index is kept and reported missing", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: BODY }));
    refreshCodeMentions(store, P);
    expect(store.missingCodeMentions([id]).size).toBe(0);

    // createServer is deleted from server.ts; store.ts is deleted outright (its
    // symbols go with it).
    index(store, ["packages/collector/src/server.ts"], [["packages/collector/src/server.ts", "RANK_RRF_SHARE", 311]]);
    store.replaceCodeSymbols(P, REPO, "sha2", ["packages/knowledge/src/store.ts"], []);
    refreshCodeMentions(store, P);

    expect(store.getCodeMentions(id)).toHaveLength(3);
    expect(store.missingCodeMentions([id]).get(id)).toEqual([
      { kind: "file", target: "packages/knowledge/src/store.ts" },
      { kind: "symbol", target: "createServer" },
      { kind: "symbol", target: "lookupSymbols" },
    ]);
  });

  test("a symbol that moved to another file is not missing", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: "`createServer` wires routes." }));
    refreshCodeMentions(store, P);
    index(store, ["packages/collector/src/server.ts"], []);
    index(store, ["packages/collector/src/app.ts"], [["packages/collector/src/app.ts", "createServer", 10]]);
    expect(store.missingCodeMentions([id]).size).toBe(0);
  });

  test("an empty code index reports nothing missing", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: BODY }));
    refreshCodeMentions(store, P);
    store.clearCodeSymbols(P, REPO);
    refreshCodeMentions(store, P);
    expect(store.getCodeMentions(id)).toHaveLength(3);
    expect(store.missingCodeMentions([id]).size).toBe(0);
  });

  test("a deleted doc's mentions are pruned", () => {
    const store = seeded();
    const id = store.upsertDoc(doc({ body: BODY }));
    refreshCodeMentions(store, P);
    store.deleteDoc(P, "arch");
    refreshCodeMentions(store, P);
    expect(store.getCodeMentions(id)).toEqual([]);
  });
});

describe("docsMentioningPath", () => {
  test("file matches (path or a symbol defined in it) come before same-directory ones", () => {
    const store = seeded();
    const a = store.upsertDoc(doc({ id: "a", slug: "a", body: "`createServer` in packages/collector/src/server.ts" }));
    const b = store.upsertDoc(doc({ id: "b", slug: "b", body: "`RANK_RRF_SHARE` tunes the rank merge" }));
    const c = store.upsertDoc(doc({ id: "c", slug: "c", body: "Boot is packages/collector/src/index.ts" }));
    store.upsertDoc(doc({ id: "d", slug: "d", body: "`KnowledgeStore` is elsewhere" }));
    refreshCodeMentions(store, P);

    const hits = store.docsMentioningPath(P, "packages/collector/src/server.ts");
    expect(hits.map((h) => [h.docId, h.match, h.mentions.length])).toEqual([
      [a, "file", 2],
      [b, "file", 1],
      [c, "directory", 1],
    ]);
  });

  test("a nested directory does not count as the same directory", () => {
    const store = seeded();
    index(store, ["packages/collector/src/persona/x.ts"], []);
    store.upsertDoc(doc({ body: "see packages/collector/src/persona/x.ts" }));
    refreshCodeMentions(store, P);
    expect(store.docsMentioningPath(P, "packages/collector/src/server.ts")).toEqual([]);
  });
});
