import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { PERSONA_ATTACHMENT_MAX_BYTES } from "@standup/shared";
import type { DocTree, ShareState } from "@standup/shared";
import { findDocAssetByPath, findDocByPath, findDocFolderByPath } from "@standup/store";
import { docAssetsDir } from "./assets.js";
import { HOST, IDENTITY, docsHarness, png } from "./test-harness.js";

/*
 * POST /api/docs/write-image: the doc tools' way to store an image at a path
 * in the caller's tree, for a doc beside it to embed by a relative src.
 */

type Written = { asset: { id: string; path: string; mime: string; bytes: number }; unchanged?: boolean };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 60 }, () => 2)]);

describe("POST /api/docs/write-image", () => {
  test("Persona stores an image at a path, creating its folders; the owner reads it back from the asset URL", async () => {
    const h = docsHarness();
    const bytes = png(200, 7);
    const written = await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), {
      path: "platform/console/screens/home.png",
      data: b64(bytes),
    });
    expect(written.asset).toMatchObject({ path: "platform/console/screens/home.png", mime: "image/png", bytes: bytes.length });
    expect(written.unchanged).toBeUndefined();
    expect(findDocFolderByPath(h.store.db, HOST, ["platform", "console", "screens"])).toBeTruthy();
    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", h.owner());
    expect(tree.assets.map((a) => a.name)).toEqual(["home.png"]);
    const served = await h.app.request(`/api/docs/assets/${written.asset.id}`, { headers: h.owner() });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
    expect(h.frames.filter((f) => f.type === "docs:changed")).toHaveLength(1);
  });

  test("the same bytes again change nothing; other bytes replace the image under a new id and drop the old copy", async () => {
    const h = docsHarness();
    const first = await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "s/a.png", data: b64(png(80, 1)) });
    const again = await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "s/a.png", data: b64(png(80, 1)) });
    expect(again).toEqual({ ...first, unchanged: true });
    expect(h.frames.filter((f) => f.type === "docs:changed")).toHaveLength(1);
    const next = await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "s/a.png", data: b64(png(90, 2)) });
    expect(next.asset.id).not.toBe(first.asset.id);
    expect(findDocAssetByPath(h.store.db, HOST, ["s", "a.png"])?.id).toBe(next.asset.id);
    expect((await h.call("GET", `/api/docs/assets/${first.asset.id}`, h.owner())).status).toBe(404);
    expect(readdirSync(docAssetsDir(h.dataDir)).filter((f) => !f.startsWith("."))).toHaveLength(1);
  });

  test("a worker of the owner's stores into the owner's tree; a request with no credential is refused", async () => {
    const h = docsHarness();
    await h.ok<Written>("POST", "/api/docs/write-image", h.worker("alice"), { path: "w.png", data: b64(png()) });
    expect(findDocAssetByPath(h.store.db, "alice", ["w.png"])).toBeTruthy();
    expect((await h.call("POST", "/api/docs/write-image", {}, { path: "x.png", data: b64(png(90, 9)) })).status).toBe(403);
    expect(findDocAssetByPath(h.store.db, HOST, ["x.png"])).toBeNull();
  });

  test("refuses bytes that aren't the image their name says, a bad path, bad base64, an empty or oversize image", async () => {
    const h = docsHarness();
    const refused = async (body: unknown, status: number, error: string) => {
      const res = await h.call("POST", "/api/docs/write-image", h.persona(), body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(error);
    };
    await refused({ path: "a.png", data: b64(new TextEncoder().encode("<svg></svg>")) }, 400, "checked by content");
    await refused({ path: "a.jpg", data: b64(png()) }, 400, "matching its extension");
    await refused({ path: "a.svg", data: b64(png()) }, 400, "ending in .png");
    await refused({ path: "notes/../a.png", data: b64(png()) }, 400, "ending in .png");
    await refused({ data: b64(png()) }, 400, "path is required");
    await refused({ path: "a.png", data: "not base64!" }, 400, "base64");
    await refused({ path: "a.png", data: "" }, 400, "empty");
    const over = new Uint8Array(PERSONA_ATTACHMENT_MAX_BYTES + 1);
    over.set(png(8));
    await refused({ path: "a.png", data: b64(over) }, 413, "the image is over 10 MB");
    expect(existsSync(docAssetsDir(h.dataDir)) ? readdirSync(docAssetsDir(h.dataDir)) : []).toEqual([]);
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "b.jpg", data: b64(jpeg()) });
  });

  test("a body a cross-site form could send is refused", async () => {
    const h = docsHarness();
    const res = await h.app.request("/api/docs/write-image", {
      method: "POST",
      headers: { "content-type": "text/plain", ...h.persona() },
      body: JSON.stringify({ path: "a.png", data: b64(png()) }),
    });
    expect(res.status).toBe(403);
  });

  test("a name a doc already holds is a conflict, and the stored copy isn't kept", async () => {
    const h = docsHarness();
    await h.ok("POST", "/api/docs/write", h.persona(), { path: "notes/a.png", content: "not an image" });
    const res = await h.call("POST", "/api/docs/write-image", h.persona(), { path: "notes/a.png", data: b64(png()) });
    expect(res.status).toBe(409);
    expect(readdirSync(docAssetsDir(h.dataDir)).filter((f) => !f.startsWith("."))).toEqual([]);
  });

  test("a worker adds or changes no image a folder link would show; the owner and their Persona can", async () => {
    const h = docsHarness();
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "pub/screens/a.png", data: b64(png(80, 1)) });
    const pub = findDocFolderByPath(h.store.db, HOST, ["pub"])!;
    await h.ok("PUT", `/api/shares/folder/${pub.id}`, h.owner(), { enabled: true });
    for (const [path, fill] of [["pub/screens/a.png", 2], ["pub/screens/b.png", 3], ["pub/deeper/new/c.png", 4]] as const) {
      const res = await h.call("POST", "/api/docs/write-image", h.worker(HOST), { path, data: b64(png(80, fill)) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("pub/ (shared by link)");
    }
    expect(findDocAssetByPath(h.store.db, HOST, ["pub", "screens", "b.png"])).toBeNull();
    // Sending the bytes already there changes nothing, so it is no refusal.
    const same = await h.ok<Written>("POST", "/api/docs/write-image", h.worker(HOST), { path: "pub/screens/a.png", data: b64(png(80, 1)) });
    expect(same.unchanged).toBe(true);
    expect(findDocFolderByPath(h.store.db, HOST, ["pub", "deeper"])).toBeUndefined();
    await h.ok<Written>("POST", "/api/docs/write-image", h.owner(), { path: "pub/screens/a.png", data: b64(png(80, 2)) });
    // Persona replaces an image there and adds one in a new folder below.
    const replaced = await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "pub/screens/a.png", data: b64(png(80, 3)) });
    expect(findDocAssetByPath(h.store.db, HOST, ["pub", "screens", "a.png"])?.id).toBe(replaced.asset.id);
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "pub/deeper/new/c.png", data: b64(png(80, 4)) });
    expect(findDocAssetByPath(h.store.db, HOST, ["pub", "deeper", "new", "c.png"])).toBeTruthy();
    // Outside the shared folder a worker still writes images.
    await h.ok<Written>("POST", "/api/docs/write-image", h.worker(HOST), { path: "private/x.png", data: b64(png(80, 5)) });
  });

  test("a worker adds or changes no image below a doc that is shared by its own link; Persona can", async () => {
    const h = docsHarness();
    await h.ok("POST", "/api/docs/write", h.persona(), { path: "notes/d.md", content: "![x](screens/a.png)" });
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "notes/screens/a.png", data: b64(png(80, 1)) });
    const doc = findDocByPath(h.store.db, HOST, ["notes", "d.md"])!;
    await h.ok("PUT", `/api/shares/doc/${doc.id}`, h.owner(), { enabled: true });
    for (const path of ["notes/screens/a.png", "notes/screens/b.png", "notes/c.png"]) {
      const res = await h.call("POST", "/api/docs/write-image", h.worker(HOST), { path, data: b64(png(80, 2)) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("notes/d.md (shared by link)");
    }
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "notes/screens/b.png", data: b64(png(80, 2)) });
    // A doc shared at the root reaches the whole tree.
    await h.ok("POST", "/api/docs/write", h.persona(), { path: "top.md", content: "x" });
    await h.ok("PUT", `/api/shares/doc/${findDocByPath(h.store.db, HOST, ["top.md"])!.id}`, h.owner(), { enabled: true });
    const anywhere = await h.call("POST", "/api/docs/write-image", h.worker(HOST), { path: "elsewhere/z.png", data: b64(png(80, 6)) });
    expect(anywhere.status).toBe(409);
    expect(((await anywhere.json()) as { error: string }).error).toContain("top.md (shared by link)");
    await h.ok("PUT", `/api/shares/doc/${findDocByPath(h.store.db, HOST, ["top.md"])!.id}`, h.owner(), { enabled: false });
    // A sibling folder is outside what the doc's link shows.
    await h.ok<Written>("POST", "/api/docs/write-image", h.worker(HOST), { path: "other/a.png", data: b64(png(80, 3)) });
    await h.ok<Written>("POST", "/api/docs/write-image", h.owner(), { path: "notes/screens/a.png", data: b64(png(80, 2)) });
  });

  test("Persona's image in a link-shared folder passes the same content, size and path checks", async () => {
    const h = docsHarness();
    await h.ok("POST", "/api/docs/write", h.persona(), { path: "pub/d.md", content: "x" });
    await h.ok("PUT", `/api/shares/folder/${findDocFolderByPath(h.store.db, HOST, ["pub"])!.id}`, h.owner(), { enabled: true });
    const refused = async (body: unknown, status: number, error: string) => {
      const res = await h.call("POST", "/api/docs/write-image", h.persona(), body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(error);
    };
    await refused({ path: "pub/a.png", data: b64(new TextEncoder().encode("<svg></svg>")) }, 400, "checked by content");
    await refused({ path: "pub/a.jpg", data: b64(png()) }, 400, "matching its extension");
    await refused({ path: "pub/../a.png", data: b64(png()) }, 400, "ending in .png");
    const over = new Uint8Array(PERSONA_ATTACHMENT_MAX_BYTES + 1);
    over.set(png(8));
    await refused({ path: "pub/a.png", data: b64(over) }, 413, "the image is over 10 MB");
    expect(findDocAssetByPath(h.store.db, HOST, ["pub", "a.png"])).toBeNull();
  });

  test("the console's editor upload: a person stores an image beside a doc, which the doc's share link then shows", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    await h.ok("POST", "/api/docs/write", alice, { path: "notes/d.md", content: "# D" });
    const bytes = png(120, 4);
    const written = await h.ok<Written & { asset: { url: string } }>("POST", "/api/docs/write-image", alice, {
      path: "notes/shot.png",
      data: b64(bytes),
    });
    expect(written.asset).toMatchObject({ path: "notes/shot.png", mime: "image/png", url: `/api/docs/assets/${written.asset.id}` });
    const served = await h.app.request(written.asset.url, { headers: alice });
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
    // Someone else's channel, a forged identity or no channel at all stores nothing in alice's tree.
    for (const headers of [h.as("bob"), { [IDENTITY]: "alice" }, {}]) {
      await h.call("POST", "/api/docs/write-image", headers, { path: "notes/other.png", data: b64(png(80, 9)) });
    }
    expect(findDocAssetByPath(h.store.db, "alice", ["notes", "other.png"])).toBeNull();

    const doc = findDocByPath(h.store.db, "alice", ["notes", "d.md"])!;
    await h.ok("PATCH", `/api/docs/${doc.id}`, alice, { body: "# D\n\n![shot](shot.png)\n" });
    const { share } = await h.ok<{ share: ShareState }>("PUT", `/api/shares/doc/${doc.id}`, alice, { enabled: true });
    const token = share.path!.replace("/share/doc/", "");
    const shared = (await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: { images: Record<string, { url: string }> } };
    const media = await h.app.request(shared.doc.images["shot.png"]!.url);
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).equals(bytes)).toBe(true);
  });

  test("with unique, an image already at the path is never replaced: other bytes get the next free name, the same bytes change nothing", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const first = await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "notes/shot.png", unique: true, data: b64(png(80, 1)) });
    const second = await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "notes/shot.png", unique: true, data: b64(png(80, 2)) });
    const third = await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "notes/shot.png", unique: true, data: b64(png(80, 3)) });
    expect([first.asset.path, second.asset.path, third.asset.path]).toEqual(["notes/shot.png", "notes/shot (2).png", "notes/shot (3).png"]);
    expect(findDocAssetByPath(h.store.db, "alice", ["notes", "shot.png"])?.id).toBe(first.asset.id);
    const again = await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "notes/shot.png", unique: true, data: b64(png(80, 1)) });
    expect(again).toMatchObject({ asset: { id: first.asset.id, path: "notes/shot.png" }, unchanged: true });
    // The editor writes `shot (2).png` as an escaped src; a share link of the doc still shows it.
    await h.ok("POST", "/api/docs/write", alice, { path: "notes/d.md", content: "![](shot%20\\(2\\).png)\n" });
    const doc = findDocByPath(h.store.db, "alice", ["notes", "d.md"])!;
    const { share } = await h.ok<{ share: ShareState }>("PUT", `/api/shares/doc/${doc.id}`, alice, { enabled: true });
    const token = share.path!.replace("/share/doc/", "");
    const shared = (await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: { images: Record<string, { url: string }> } };
    expect(Object.values(shared.doc.images)).toHaveLength(1);
    const media = await h.app.request(Object.values(shared.doc.images)[0]!.url);
    expect(Buffer.from(await media.arrayBuffer()).equals(Buffer.from(png(80, 2)))).toBe(true);
    expect((await h.call("POST", "/api/docs/write-image", alice, { path: "notes/x.png", unique: "yes", data: b64(png()) })).status).toBe(400);
  });

  test("a folderId the path's folders no longer are is refused, so an image never lands in a folder renamed meanwhile", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    await h.ok("POST", "/api/docs/write", alice, { path: "notes/d.md", content: "x" });
    const notes = findDocFolderByPath(h.store.db, "alice", ["notes"])!;
    await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "notes/a.png", folderId: notes.id, unique: true, data: b64(png()) });
    await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "top.png", folderId: null, unique: true, data: b64(png()) });
    await h.ok("PATCH", `/api/docs/folders/${notes.id}`, alice, { name: "renamed" });
    const stale = await h.call("POST", "/api/docs/write-image", alice, { path: "notes/b.png", folderId: notes.id, unique: true, data: b64(png(80, 2)) });
    expect(stale.status).toBe(409);
    expect(findDocFolderByPath(h.store.db, "alice", ["notes"])).toBeUndefined();
    expect((await h.call("POST", "/api/docs/write-image", alice, { path: "renamed/b.png", folderId: null, data: b64(png(80, 2)) })).status).toBe(409);
    expect((await h.call("POST", "/api/docs/write-image", alice, { path: "renamed/b.png", folderId: "nope", data: b64(png(80, 2)) })).status).toBe(400);
    await h.ok<Written>("POST", "/api/docs/write-image", alice, { path: "renamed/b.png", folderId: notes.id, unique: true, data: b64(png(80, 2)) });
  });

  test("a person's upload is refused for a non-image, an oversize image and any path that climbs or hides a separator", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const refused = async (body: unknown, status: number, error: string) => {
      const res = await h.call("POST", "/api/docs/write-image", alice, body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(error);
    };
    await refused({ path: "notes/a.png", data: b64(new TextEncoder().encode("not an image at all")) }, 400, "checked by content");
    await refused({ path: "notes/a.txt", data: b64(png()) }, 400, "ending in .png");
    const over = new Uint8Array(PERSONA_ATTACHMENT_MAX_BYTES + 1);
    over.set(png(8));
    await refused({ path: "notes/a.png", data: b64(over) }, 413, "the image is over 10 MB");
    for (const path of ["../a.png", "notes/../../a.png", "notes/..", "./a.png", "notes\\..\\a.png", "notes/a\u0000.png"]) {
      await refused({ path, data: b64(png()) }, 400, "ending in .png");
    }
    expect((await h.ok<DocTree>("GET", "/api/docs/tree", alice)).assets).toEqual([]);
    expect(existsSync(docAssetsDir(h.dataDir)) ? readdirSync(docAssetsDir(h.dataDir)) : []).toEqual([]);
  });

  test("the owner's image quota holds", async () => {
    const h = docsHarness({ docLimits: { assetBytes: 150 } });
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "a.png", data: b64(png(100, 1)) });
    expect((await h.call("POST", "/api/docs/write-image", h.persona(), { path: "b.png", data: b64(png(100, 2)) })).status).toBe(413);
    // Replacing an image counts only what it grows by.
    await h.ok<Written>("POST", "/api/docs/write-image", h.persona(), { path: "a.png", data: b64(png(110, 3)) });
  });
});
