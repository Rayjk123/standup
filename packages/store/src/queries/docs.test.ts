import { describe, expect, test } from "bun:test";
import { DOC_BODY_MAX_BYTES, DOC_FOLDER_DEPTH_MAX, DOC_NAME_MAX, isValidDocName } from "@standup/shared";
import { createStore } from "../store.js";
import { getLiveGrant, setShare } from "./share-grants.js";
import {
  DOC_SEARCH_LIMIT,
  DocError,
  createDoc,
  createDocAsset,
  createDocFolder,
  deleteDoc,
  deleteDocFolder,
  docFolderPath,
  ensureDocFolderPath,
  findDocAssetByPath,
  findDocByPath,
  getDoc,
  getDocTree,
  searchDocs,
  uniqueDocName,
  updateDoc,
  updateDocFolder,
} from "./docs.js";

const SHA = "a".repeat(64);

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof DocError ? err.code : "other";
  }
}

describe("doc tree", () => {
  test("names are unique within a folder across folders, docs and assets; other folders and owners are separate", () => {
    const { db } = createStore(":memory:");
    const f = createDocFolder(db, { owner: "alice", parentId: null, name: "notes" });
    createDoc(db, { owner: "alice", folderId: f.id, name: "a.md" });
    expect(code(() => createDoc(db, { owner: "alice", folderId: f.id, name: "a.md" }))).toBe("conflict");
    expect(code(() => createDocFolder(db, { owner: "alice", parentId: f.id, name: "a.md" }))).toBe("conflict");
    expect(code(() => createDocAsset(db, { owner: "alice", folderId: f.id, name: "a.md", mime: "image/png", sha256: SHA, bytes: 1 }))).toBe("conflict");
    expect(code(() => createDocFolder(db, { owner: "alice", parentId: null, name: "notes" }))).toBe("conflict");
    expect(code(() => createDoc(db, { owner: "alice", folderId: null, name: "a.md" }))).toBeNull();
    expect(code(() => createDocFolder(db, { owner: "bob", parentId: null, name: "notes" }))).toBeNull();
    expect(uniqueDocName(db, "alice", f.id, "a.md")).toBe("a (2).md");
    createDoc(db, { owner: "alice", folderId: f.id, name: "a (2).md" });
    expect(uniqueDocName(db, "alice", f.id, "a.md")).toBe("a (3).md");
    expect(uniqueDocName(db, "alice", null, "notes")).toBe("notes (2)");
  });

  test("another owner's folder can't be a parent, and reads as missing", () => {
    const { db } = createStore(":memory:");
    const bobs = createDocFolder(db, { owner: "bob", parentId: null, name: "x" });
    expect(code(() => createDoc(db, { owner: "alice", folderId: bobs.id, name: "a.md" }))).toBe("not_found");
    expect(getDocTree(db, "alice").folders).toEqual([]);
  });

  test("a folder can't move into itself or below itself, nor past the depth cap", () => {
    const { db } = createStore(":memory:");
    const a = createDocFolder(db, { owner: "alice", parentId: null, name: "a" });
    const b = createDocFolder(db, { owner: "alice", parentId: a.id, name: "b" });
    expect(code(() => updateDocFolder(db, { id: a.id, owner: "alice", parentId: a.id }))).toBe("invalid");
    expect(code(() => updateDocFolder(db, { id: a.id, owner: "alice", parentId: b.id }))).toBe("invalid");
    let parent: string | null = null;
    for (let i = 0; i < DOC_FOLDER_DEPTH_MAX; i++) parent = createDocFolder(db, { owner: "alice", parentId: parent, name: `d${i}` }).id;
    expect(code(() => createDocFolder(db, { owner: "alice", parentId: parent, name: "deeper" }))).toBe("invalid");
    // a has a child, so a (depth 2 subtree) can't go below depth 15.
    const d14 = docFolderPath(db, parent, "alice")!;
    expect(d14).toHaveLength(DOC_FOLDER_DEPTH_MAX);
    expect(code(() => updateDocFolder(db, { id: a.id, owner: "alice", parentId: parent }))).toBe("invalid");
    expect(updateDocFolder(db, { id: b.id, owner: "alice", parentId: null, name: "b2" }).parentId).toBeNull();
  });

  test("a recursive delete removes everything below and says which docs and copies went", () => {
    const { db } = createStore(":memory:");
    const a = createDocFolder(db, { owner: "alice", parentId: null, name: "a" });
    const b = createDocFolder(db, { owner: "alice", parentId: a.id, name: "b" });
    const d1 = createDoc(db, { owner: "alice", folderId: a.id, name: "1.md" });
    const d2 = createDoc(db, { owner: "alice", folderId: b.id, name: "2.md" });
    createDocAsset(db, { owner: "alice", folderId: b.id, name: "x.png", mime: "image/png", sha256: SHA, bytes: 1 });
    const kept = createDoc(db, { owner: "alice", folderId: null, name: "kept.md" });
    expect(deleteDocFolder(db, a.id, "bob")).toBeNull();
    const removed = deleteDocFolder(db, a.id, "alice")!;
    expect(removed.docIds.sort()).toEqual([d1.id, d2.id].sort());
    expect(removed.assets).toEqual([{ sha256: SHA, mime: "image/png" }]);
    const tree = getDocTree(db, "alice");
    expect(tree.folders).toEqual([]);
    expect(tree.assets).toEqual([]);
    expect(tree.docs.map((d) => d.id)).toEqual([kept.id]);
  });

  test("the revision bumps on a body or name change, not a move; a stale base revision is a conflict", () => {
    const { db } = createStore(":memory:");
    const f = createDocFolder(db, { owner: "alice", parentId: null, name: "f" });
    const doc = createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "one" });
    expect(doc.revision).toBe(1);
    const saved = updateDoc(db, { id: doc.id, owner: "alice", body: "two", baseRevision: 1 });
    expect(saved.ok && saved.doc.revision).toBe(2);
    const stale = updateDoc(db, { id: doc.id, owner: "alice", body: "three", baseRevision: 1 });
    expect(stale).toEqual({ ok: false, reason: "revision", doc: expect.objectContaining({ body: "two", revision: 2 }) });
    const moved = updateDoc(db, { id: doc.id, owner: "alice", folderId: f.id });
    expect(moved.ok && moved.doc.revision).toBe(2);
    const renamed = updateDoc(db, { id: doc.id, owner: "alice", name: "b.md" });
    expect(renamed.ok && renamed.doc.revision).toBe(3);
    expect(getDoc(db, doc.id, "alice")?.bytes).toBe(3);
    expect(code(() => updateDoc(db, { id: doc.id, owner: "alice", body: "x".repeat(DOC_BODY_MAX_BYTES + 1) }))).toBe("too_large");
    expect(code(() => updateDoc(db, { id: doc.id, owner: "bob", body: "x" }))).toBe("not_found");
  });

  test("paths: ensureDocFolderPath creates what's missing, and docs and assets are found by path", () => {
    const { db } = createStore(":memory:");
    const id = ensureDocFolderPath(db, "alice", ["authz", "notes"]);
    expect(ensureDocFolderPath(db, "alice", ["authz", "notes"])).toBe(id);
    expect(docFolderPath(db, id, "alice")).toEqual(["authz", "notes"]);
    const doc = createDoc(db, { owner: "alice", folderId: id, name: "x.md", body: "b" });
    createDocAsset(db, { owner: "alice", folderId: id, name: "x.png", mime: "image/png", sha256: SHA, bytes: 1 });
    expect(findDocByPath(db, "alice", ["authz", "notes", "x.md"])?.id).toBe(doc.id);
    expect(findDocByPath(db, "bob", ["authz", "notes", "x.md"])).toBeNull();
    expect(findDocAssetByPath(db, "alice", ["authz", "notes", "x.png"])?.sha256).toBe(SHA);
    expect(code(() => ensureDocFolderPath(db, "alice", ["authz", "notes", "x.md", "y"]))).toBe("conflict");
    expect(code(() => ensureDocFolderPath(db, "alice", ["a/b"]))).toBe("invalid");
  });
});

describe("uniqueDocName", () => {
  test("a file's suffix goes before its extension, a folder's at the very end", () => {
    const { db } = createStore(":memory:");
    createDocFolder(db, { owner: "alice", parentId: null, name: "notes.v2" });
    createDoc(db, { owner: "alice", folderId: null, name: "plan.v2.md" });
    expect(uniqueDocName(db, "alice", null, "notes.v2", "folder")).toBe("notes.v2 (2)");
    expect(uniqueDocName(db, "alice", null, "plan.v2.md")).toBe("plan.v2 (2).md");
  });

  test("the stem is cut so the suffixed name stays within DOC_NAME_MAX", () => {
    const { db } = createStore(":memory:");
    const file = `${"a".repeat(DOC_NAME_MAX - 3)}.md`;
    const folder = "f".repeat(DOC_NAME_MAX);
    createDoc(db, { owner: "alice", folderId: null, name: file });
    createDocFolder(db, { owner: "alice", parentId: null, name: folder });
    const fileName = uniqueDocName(db, "alice", null, file);
    expect(fileName).toBe(`${"a".repeat(DOC_NAME_MAX - 7)} (2).md`);
    expect(fileName).toHaveLength(DOC_NAME_MAX);
    expect(isValidDocName(fileName)).toBe(true);
    const folderName = uniqueDocName(db, "alice", null, folder, "folder");
    expect(folderName).toBe(`${"f".repeat(DOC_NAME_MAX - 4)} (2)`);
    expect(isValidDocName(folderName)).toBe(true);
    // An extension too long to keep beside the suffix is cut with the rest.
    const longExt = `a.${"x".repeat(DOC_NAME_MAX - 2)}`;
    createDoc(db, { owner: "alice", folderId: null, name: longExt });
    const cut = uniqueDocName(db, "alice", null, longExt);
    expect(cut.endsWith(" (2)")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(DOC_NAME_MAX);
  });
});

describe("per-owner limits", () => {
  test("items: folders, docs and assets together; another owner is separate", () => {
    const { db } = createStore(":memory:");
    const limits = { items: 3 };
    const f = createDocFolder(db, { owner: "alice", parentId: null, name: "f", limits });
    createDoc(db, { owner: "alice", folderId: f.id, name: "a.md", limits });
    createDocAsset(db, { owner: "alice", folderId: null, name: "x.png", mime: "image/png", sha256: SHA, bytes: 1, limits });
    expect(code(() => createDoc(db, { owner: "alice", folderId: null, name: "b.md", limits }))).toBe("quota");
    expect(code(() => createDocFolder(db, { owner: "alice", parentId: null, name: "g", limits }))).toBe("quota");
    expect(code(() => ensureDocFolderPath(db, "alice", ["new"], null, new Date(), limits))).toBe("quota");
    expect(
      code(() => createDocAsset(db, { owner: "alice", folderId: null, name: "y.png", mime: "image/png", sha256: SHA, bytes: 1, limits }))
    ).toBe("quota");
    expect(code(() => createDoc(db, { owner: "bob", folderId: null, name: "b.md", limits }))).toBeNull();
    expect(getDocTree(db, "alice").docs).toHaveLength(1);
  });

  test("body bytes: the sum after the write; shrinking an over-cap tree is allowed", () => {
    const { db } = createStore(":memory:");
    const limits = { bodyBytes: 10 };
    const a = createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "123456", limits });
    expect(code(() => createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: "12345", limits }))).toBe("quota");
    createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: "1234", limits });
    expect(code(() => updateDoc(db, { id: a.id, owner: "alice", body: "1234567", limits }))).toBe("quota");
    expect(getDoc(db, a.id, "alice")?.body).toBe("123456");
    const shrunk = updateDoc(db, { id: a.id, owner: "alice", body: "1", limits: { bodyBytes: 1 } });
    expect(shrunk.ok && shrunk.doc.body).toBe("1");
  });

  test("asset bytes: every row's bytes count", () => {
    const { db } = createStore(":memory:");
    const limits = { assetBytes: 10 };
    const asset = (name: string, bytes: number) => () =>
      createDocAsset(db, { owner: "alice", folderId: null, name, mime: "image/png", sha256: SHA, bytes, limits });
    expect(code(asset("a.png", 6))).toBeNull();
    expect(code(asset("b.png", 5))).toBe("quota");
    expect(code(asset("b.png", 4))).toBeNull();
  });
});

describe("a deleted doc's share link", () => {
  test("is revoked with the doc, and with a folder deleted around it", () => {
    const { db } = createStore(":memory:");
    const f = createDocFolder(db, { owner: "alice", parentId: null, name: "f" });
    const inside = createDoc(db, { owner: "alice", folderId: f.id, name: "a.md" });
    const alone = createDoc(db, { owner: "alice", folderId: null, name: "b.md" });
    setShare(db, "doc", inside.id, "alice", true);
    setShare(db, "doc", alone.id, "alice", true);
    expect(deleteDoc(db, alone.id, "alice")).toBe(true);
    expect(getLiveGrant(db, "doc", alone.id, "alice")).toBeNull();
    expect(getLiveGrant(db, "doc", inside.id, "alice")).not.toBeNull();
    deleteDocFolder(db, f.id, "alice");
    expect(getLiveGrant(db, "doc", inside.id, "alice")).toBeNull();
  });
});

describe("doc search", () => {
  const seed = () => {
    const { db } = createStore(":memory:");
    const plans = createDocFolder(db, { owner: "alice", parentId: null, name: "plans" });
    const auth = createDocFolder(db, { owner: "alice", parentId: plans.id, name: "auth" });
    createDoc(db, { owner: "alice", folderId: auth.id, name: "overview.md", body: "x" });
    createDoc(db, { owner: "alice", folderId: null, name: "auth-notes.md", body: "x" });
    createDoc(db, { owner: "alice", folderId: null, name: "my-auth.md", body: "x" });
    return { db, plans, auth };
  };
  const paths = (hits: Array<{ path: string }>) => hits.map((h) => h.path);

  test("a name starting with the query ranks first, then the query anywhere in the name, then only in the path", () => {
    const { db } = seed();
    expect(paths(searchDocs(db, "alice", "Auth"))).toEqual(["auth-notes.md", "my-auth.md", "plans/auth/overview.md"]);
    expect(searchDocs(db, "bob", "auth")).toEqual([]);
    expect(searchDocs(db, "alice", "  ")).toEqual([]);
  });

  test("every word must match, across folders and the name", () => {
    const { db } = seed();
    expect(paths(searchDocs(db, "alice", "plans overview"))).toEqual(["plans/auth/overview.md"]);
    expect(searchDocs(db, "alice", "plans notes")).toEqual([]);
  });

  test("a name starting with the first word ranks first only when it holds the other words too", () => {
    const { db, auth } = seed();
    createDoc(db, { owner: "alice", folderId: auth.id, name: "overview-plans.md", body: "x" });
    createDoc(db, { owner: "alice", folderId: null, name: "the-overview-plans.md", body: "x" });
    expect(paths(searchDocs(db, "alice", "overview plans"))).toEqual(["plans/auth/overview-plans.md", "the-overview-plans.md", "plans/auth/overview.md"]);
  });

  test("a snippet finds its match past characters whose lowercase is longer, and never splits an emoji", () => {
    const { db } = createStore(":memory:");
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: `${"İ".repeat(60)} needle` });
    // The 40-unit window before the match starts on the second half of an emoji.
    createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: `${"😀".repeat(30)}-needle` });
    const [a, b] = searchDocs(db, "alice", "needle");
    expect(a!.snippet!.endsWith("needle")).toBe(true);
    expect(b!.snippet).toMatch(/^…(😀)+-needle$/u);
  });

  test("a body match carries its line, cut to a window with ellipses on a long line", () => {
    const { db } = createStore(":memory:");
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: `# Title\n\n${"lead ".repeat(20)}the Needle here ${"tail ".repeat(40)}\nnext` });
    const [hit] = searchDocs(db, "alice", "needle");
    expect(hit).toMatchObject({ path: "a.md", match: "body" });
    expect(hit!.snippet!.startsWith("…")).toBe(true);
    expect(hit!.snippet!.endsWith("…")).toBe(true);
    expect(hit!.snippet).toContain("the Needle here");
    expect(hit!.snippet).not.toContain("next");
  });

  test("% and _ in a query match themselves, not any text", () => {
    const { db } = createStore(":memory:");
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "100% done" });
    createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: "1000 done" });
    createDoc(db, { owner: "alice", folderId: null, name: "c.md", body: "snake_case" });
    expect(paths(searchDocs(db, "alice", "100%"))).toEqual(["a.md"]);
    expect(paths(searchDocs(db, "alice", "e_c"))).toEqual(["c.md"]);
  });

  test("a doc matching by path is not listed again for its body, and the hits are capped", () => {
    const { db } = createStore(":memory:");
    createDoc(db, { owner: "alice", folderId: null, name: "word.md", body: "word" });
    expect(searchDocs(db, "alice", "word")).toEqual([{ id: expect.any(String), path: "word.md", match: "path" }] as never);
    for (let i = 0; i < DOC_SEARCH_LIMIT + 5; i++) createDoc(db, { owner: "alice", folderId: null, name: `n${i}.md`, body: "word" });
    expect(searchDocs(db, "alice", "word").length).toBe(DOC_SEARCH_LIMIT);
  });
});
