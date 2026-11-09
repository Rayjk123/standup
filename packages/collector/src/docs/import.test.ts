import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { DocDetail, DocImportResult, DocTree } from "@standup/shared";
import { DocImportError, importDocs } from "./import.js";
import { HOST, docsHarness, png } from "./test-harness.js";

/*
 * Importing from this host's disk: the host owner's alone, a directory comes
 * in as a folder with its structure, symlinks, dot-dirs, node_modules and
 * other files are listed as skipped, and markdown is stored byte for byte.
 */

/** A markdown body with a byte-order mark and CRLF, which must survive as is. */
const README = "﻿# Notes\r\nsee ![shot](img/shot.png)\n";

/** A tree with a nested doc, an image, a json file, a dot-dir, node_modules, a symlink and a hard link. */
function fixture(root: string): string {
  const dir = join(root, "fixture", "notes");
  mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "readme.md"), README);
  writeFileSync(join(dir, "sub", "deeper", "deep.markdown"), "deep");
  mkdirSync(join(dir, "img"));
  writeFileSync(join(dir, "img", "shot.png"), png(40, 3));
  writeFileSync(join(dir, "img", "fake.png"), "not an image");
  writeFileSync(join(dir, "data.json"), "{}");
  writeFileSync(join(dir, ".git", "config"), "secret");
  writeFileSync(join(dir, ".hidden.md"), "hidden");
  writeFileSync(join(dir, "node_modules", "x", "readme.md"), "dep");
  writeFileSync(join(root, "fixture", "outside.md"), "OUTSIDE");
  symlinkSync(join(root, "fixture", "outside.md"), join(dir, "link.md"));
  symlinkSync(join(root, "fixture"), join(dir, "linkdir"));
  linkSync(join(root, "fixture", "outside.md"), join(dir, "hard.md"));
  return dir;
}

describe("POST /api/docs/import", () => {
  test("a directory comes in as a folder with its structure; everything else is listed as skipped", async () => {
    const h = docsHarness();
    const dir = fixture(h.root);
    const result = await h.ok<DocImportResult>("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    expect(result).toMatchObject({ folders: 4, docs: 2, assets: 1 });
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));
    expect(Object.keys(reasons).sort()).toEqual(
      [
        "notes/.git",
        "notes/.hidden.md",
        "notes/data.json",
        "notes/hard.md",
        "notes/img/fake.png",
        "notes/link.md",
        "notes/linkdir",
        "notes/node_modules",
      ].sort()
    );
    expect(reasons["notes/link.md"]).toContain("symlink");
    expect(reasons["notes/linkdir"]).toContain("symlink");
    expect(reasons["notes/data.json"]).toBe("not markdown or an image");
    expect(reasons["notes/.git"]).toContain("dot");
    expect(reasons["notes/node_modules"]).toContain("node_modules");
    expect(reasons["notes/hard.md"]).toContain("hard link");
    expect(reasons["notes/img/fake.png"]).toContain("not a .png image");

    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", h.owner());
    const byId = new Map(tree.folders.map((f) => [f.id, f]));
    const pathOf = (folderId: string | null): string => {
      const f = folderId ? byId.get(folderId) : undefined;
      return f ? `${pathOf(f.parentId)}${f.name}/` : "";
    };
    expect(tree.folders.map((f) => pathOf(f.id)).sort()).toEqual(["notes/", "notes/img/", "notes/sub/", "notes/sub/deeper/"]);
    expect(tree.docs.map((d) => pathOf(d.folderId) + d.name).sort()).toEqual(["notes/readme.md", "notes/sub/deeper/deep.markdown"]);
    expect(tree.assets.map((a) => pathOf(a.folderId) + a.name)).toEqual(["notes/img/shot.png"]);
    expect(result.rootFolderId).toBe(tree.folders.find((f) => f.name === "notes")!.id);

    const readme = tree.docs.find((d) => d.name === "readme.md")!;
    const onDisk = readFileSync(join(dir, "readme.md"));
    const stored = (h.store.db.query("SELECT body FROM docs WHERE id = ?").get(readme.id) as { body: Uint8Array }).body;
    expect([...stored]).toEqual([...onDisk]);
    const res = await h.call("GET", `/api/docs/${readme.id}`, h.owner());
    const body = (JSON.parse(Buffer.from(await res.arrayBuffer()).toString("utf8")) as { doc: DocDetail }).doc.body;
    expect([...Buffer.from(body, "utf8")]).toEqual([...Buffer.from(README, "utf8")]);
    for (const d of tree.docs) {
      const text = (await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${d.id}`, h.owner())).doc.body;
      expect(text).not.toContain("OUTSIDE");
    }
  });

  test("importing the same directory again lands beside the first as notes (2)", async () => {
    const h = docsHarness();
    const dir = fixture(h.root);
    await h.ok("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    await h.ok("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", h.owner());
    expect(tree.folders.filter((f) => f.parentId === null).map((f) => f.name).sort()).toEqual(["notes", "notes (2)"]);
  });

  test("a single markdown file or image comes in on its own, with a suffixed name on a collision", async () => {
    const h = docsHarness();
    const file = join(h.root, "one.md");
    writeFileSync(file, "one");
    const first = await h.ok<DocImportResult>("POST", "/api/docs/import", h.owner(), { path: file, folderId: null });
    expect(first).toEqual({ rootFolderId: null, folders: 0, docs: 1, assets: 0, skipped: [] });
    await h.ok("POST", "/api/docs/import", h.owner(), { path: file, folderId: null });
    const image = join(h.root, "pic.png");
    writeFileSync(image, png());
    expect((await h.ok<DocImportResult>("POST", "/api/docs/import", h.owner(), { path: image, folderId: null })).assets).toBe(1);
    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", h.owner());
    expect(tree.docs.map((d) => d.name).sort()).toEqual(["one (2).md", "one.md"]);
    const json = join(h.root, "x.json");
    writeFileSync(json, "{}");
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: json, folderId: null })).status).toBe(400);
  });

  test("~/ expands to the home dir; a symlink, a protected location or a missing path is refused", async () => {
    const h = docsHarness();
    writeFileSync(join(h.home, "home.md"), "home");
    expect((await h.ok<DocImportResult>("POST", "/api/docs/import", h.owner(), { path: "~/home.md", folderId: null })).docs).toBe(1);
    symlinkSync(join(h.home, "home.md"), join(h.root, "link.md"));
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: join(h.root, "link.md"), folderId: null })).status).toBe(400);
    mkdirSync(join(h.home, ".ssh"));
    writeFileSync(join(h.home, ".ssh", "notes.md"), "key");
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: "~/.ssh", folderId: null })).status).toBe(400);
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: "~/.ssh/notes.md", folderId: null })).status).toBe(400);
    writeFileSync(join(h.dataDir, "inside.md"), "data dir");
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: join(h.dataDir, "inside.md"), folderId: null })).status).toBe(400);
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: join(h.root, "missing"), folderId: null })).status).toBe(400);
    expect((await h.call("POST", "/api/docs/import", h.owner(), { path: "relative/path", folderId: null })).status).toBe(400);
    expect((await h.ok<DocTree>("GET", "/api/docs/tree", h.owner())).docs).toHaveLength(1);
  });

  test("only the host owner through the owner channel may import: never a teammate, Persona or a worker", async () => {
    const h = docsHarness();
    const file = join(h.root, "one.md");
    writeFileSync(file, "one");
    const body = { path: file, folderId: null };
    expect((await h.call("POST", "/api/docs/import", h.as("bob"), body)).status).toBe(403);
    expect((await h.call("POST", "/api/docs/import", h.as(HOST), body)).status).toBe(403);
    expect((await h.call("POST", "/api/docs/import", h.persona(), body)).status).toBe(403);
    expect((await h.call("POST", "/api/docs/import", { ...h.owner(), ...h.persona() }, body)).status).toBe(403);
    expect((await h.call("POST", "/api/docs/import", h.worker(HOST), body)).status).toBe(403);
    expect((await h.call("POST", "/api/docs/import", { ...h.owner(), ...h.worker(HOST) }, body)).status).toBe(403);
    const formShaped = await h.app.request("/api/docs/import", {
      method: "POST",
      headers: { "content-type": "text/plain", ...h.owner() },
      body: JSON.stringify(body),
    });
    expect(formShaped.status).toBe(403);
    expect((await h.ok<DocTree>("GET", "/api/docs/tree", h.owner())).docs).toEqual([]);
  });

  test("a failed import leaves nothing behind", async () => {
    const h = docsHarness();
    const dir = fixture(h.root);
    // A folder created mid-import fails, after the walk and the image copy.
    h.store.db.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON doc_folders WHEN NEW.name = 'deeper' BEGIN SELECT RAISE(ABORT, 'boom'); END"
    );
    const res = await h.call("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    expect(res.status).toBe(500);
    const answer = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(answer)).toEqual(["error"]);
    expect(String(answer.error)).not.toContain("boom");
    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", h.owner());
    expect(tree).toEqual({ folders: [], docs: [], assets: [] });
    // The image copied in before the transaction is gone too.
    const assets = join(h.dataDir, "doc-assets");
    expect(existsSync(assets) ? readdirSync(assets) : []).toEqual([]);
  });

  test("an import past the owner's limits is a 413 and leaves nothing", async () => {
    const h = docsHarness({ docLimits: { items: 3 } });
    const dir = fixture(h.root);
    const res = await h.call("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    expect(res.status).toBe(413);
    expect(await h.ok<DocTree>("GET", "/api/docs/tree", h.owner())).toEqual({ folders: [], docs: [], assets: [] });
    const assets = join(h.dataDir, "doc-assets");
    expect(existsSync(assets) ? readdirSync(assets) : []).toEqual([]);
  });

  test("a directory imported again beside itself is suffixed at the very end", async () => {
    const h = docsHarness();
    const dir = join(h.root, "notes.v2");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.md"), "a");
    await h.ok("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    await h.ok("POST", "/api/docs/import", h.owner(), { path: dir, folderId: null });
    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", h.owner());
    expect(tree.folders.map((f) => f.name).sort()).toEqual(["notes.v2", "notes.v2 (2)"]);
  });
});

describe("importDocs caps", () => {
  test("every walked entry counts against the entry cap, skipped ones too", () => {
    const h = docsHarness();
    const dir = fixture(h.root);
    // The fixture's notes/ holds 14 walked entries below it, of every kind.
    const run = (maxEntries: number) => () =>
      importDocs(h.store.db, { owner: HOST, path: dir, folderId: null, dataDir: h.dataDir, home: h.home, env: {}, maxEntries });
    expect(run(5)).toThrow(DocImportError);
    expect(run(5)).toThrow("more than 5 files and folders");
    expect(run(100)().docs).toBe(2);
  });

  test("the file cap counts only files brought in, not skipped ones", () => {
    const h = docsHarness();
    const dir = join(h.root, "many");
    mkdirSync(dir);
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `skip-${i}.json`), "{}");
    writeFileSync(join(dir, "a.md"), "a");
    writeFileSync(join(dir, "b.md"), "b");
    const run = (maxFiles: number) => () =>
      importDocs(h.store.db, { owner: HOST, path: dir, folderId: null, dataDir: h.dataDir, home: h.home, env: {}, maxFiles });
    expect(run(1)).toThrow("more than 1 files to bring in");
    const result = run(2)();
    expect(result.docs).toBe(2);
    expect(result.skipped).toHaveLength(10);
  });

  test("/proc, /sys and /dev are never walked, by path or through a symlinked parent", async () => {
    const h = docsHarness();
    for (const path of ["/proc", "/proc/self", "/sys", "/dev", "/dev/null"]) {
      const res = await h.call("POST", "/api/docs/import", h.owner(), { path, folderId: null });
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
    symlinkSync("/proc", join(h.root, "via"));
    const res = await h.call("POST", "/api/docs/import", h.owner(), { path: join(h.root, "via", "sys"), folderId: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("protected");
  });
});
