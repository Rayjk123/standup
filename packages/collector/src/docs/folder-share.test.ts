import { describe, expect, test } from "bun:test";
import type { DocAsset, DocDetail, DocFolder, ShareState, SharedDoc, SharedFolder } from "@standup/shared";
import { docsHarness, png } from "./test-harness.js";

/*
 * A folder shared by link: the link shows the folder's tree and opens any doc
 * in it or a folder below it, without auth; what it reaches follows the live
 * tree (a doc added later is in, one moved out is not); nothing outside the
 * folder is reachable by id, path or image src; turning it off revokes it at
 * once while a doc's own link keeps working; and no other route opens to an
 * unauthenticated request.
 */

type H = ReturnType<typeof docsHarness>;
const NOT_FOUND = { error: "Not found" };

/**
 * alice's tree:
 *   acme-platform/ overview.md, diagram.png
 *     control-plane/ api.md
 *     data-plane/ runtime.md
 *   private/ secret.md, secret.png
 *   top.md
 */
async function setUp(h: H) {
  const alice = h.as("alice");
  const folder = async (name: string, parentId: string | null) =>
    (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId, name })).folder;
  const doc = async (folderId: string | null, name: string, body: string) =>
    (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", alice, { folderId, name, body })).doc;
  const upload = async (name: string, fill: number, folderId: string) => {
    const res = await h.app.request(`/api/docs/assets?folderId=${folderId}&name=${name}`, {
      method: "POST",
      headers: { "content-type": "image/png", ...alice },
      body: png(60, fill),
    });
    return ((await res.json()) as { asset: DocAsset }).asset;
  };
  const platform = await folder("acme-platform", null);
  const control = await folder("control-plane", platform.id);
  const data = await folder("data-plane", platform.id);
  const priv = await folder("private", null);
  const diagram = await upload("diagram.png", 1, platform.id);
  const secretPng = await upload("secret.png", 2, priv.id);
  const overview = await doc(platform.id, "overview.md", "# Overview\n\n![d](diagram.png)");
  const api = await doc(control.id, "api.md", "# API\n\n![up](../diagram.png) ![out](../../private/secret.png) ![enc](..%2F..%2Fprivate%2Fsecret.png)");
  const runtime = await doc(data.id, "runtime.md", "# Runtime");
  const secret = await doc(priv.id, "secret.md", "# Secret");
  const top = await doc(null, "top.md", "# Top");
  return { alice, folder, doc, platform, control, data, priv, diagram, secretPng, overview, api, runtime, secret, top };
}

const shareFolder = async (h: H, id: string, headers: Record<string, string>, enabled = true) => {
  const { share } = await h.ok<{ share: ShareState }>("PUT", `/api/shares/folder/${id}`, headers, { enabled });
  return share.path?.replace("/share/folder/", "") ?? null;
};

const tree = async (h: H, token: string) => {
  const res = await h.app.request(`/api/share/folders/${token}`);
  return res.status === 200 ? ((await res.json()) as { folder: SharedFolder }).folder : res.status;
};

const openDoc = async (h: H, token: string, docId: string) => {
  const res = await h.app.request(`/api/share/folders/${token}/docs/${docId}`);
  return res.status === 200 ? ((await res.json()) as { doc: SharedDoc }).doc : res.status;
};

describe("a shared folder", () => {
  test("shows the folder's tree and opens nested docs without auth, uncached", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.platform.id, s.alice))!;
    const res = await h.app.request(`/api/share/folders/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await h.app.request(`/api/share/folders/${token}`, { method: "HEAD" })).status).toBe(200);
    const raw = await res.text();
    const folder = (JSON.parse(raw) as { folder: SharedFolder }).folder;
    expect(folder.name).toBe("acme-platform");
    expect(folder.folders.map((f) => [f.name, f.parentId]).sort()).toEqual([
      ["acme-platform", null],
      ["control-plane", s.platform.id],
      ["data-plane", s.platform.id],
    ]);
    expect(folder.docs.map((d) => d.name).sort()).toEqual(["api.md", "overview.md", "runtime.md"]);
    // Nothing of the rest of the tree, the owner or the docs' bodies.
    for (const leak of ["private", "secret", "top.md", "alice", "# Overview", "diagram.png", s.secret.id, s.priv.id]) expect(raw).not.toContain(leak);

    const runtime = await openDoc(h, token, s.runtime.id);
    expect(runtime).toEqual({ name: "runtime.md", body: "# Runtime", images: {} });
    const res2 = await h.app.request(`/api/share/folders/${token}/docs/${s.overview.id}`);
    expect(res2.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(((await res2.json()) as { doc: SharedDoc }).doc).sort()).toEqual(["body", "images", "name"]);
  });

  test("a doc added to the folder later, or to a subfolder made later, is in the link at once", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.platform.id, s.alice))!;
    const later = await s.doc(s.data.id, "later.md", "# Later");
    const sub = await s.folder("deep", s.control.id);
    const deep = await s.doc(sub.id, "deep.md", "# Deep");
    const folder = (await tree(h, token)) as SharedFolder;
    expect(folder.docs.map((d) => d.name).sort()).toEqual(["api.md", "deep.md", "later.md", "overview.md", "runtime.md"]);
    expect(folder.folders.find((f) => f.id === sub.id)?.parentId).toBe(s.control.id);
    expect(await openDoc(h, token, later.id)).toMatchObject({ name: "later.md", body: "# Later" });
    expect(await openDoc(h, token, deep.id)).toMatchObject({ name: "deep.md" });
    // A doc moved in from elsewhere is in; one moved out is gone.
    await h.ok("PATCH", `/api/docs/${s.top.id}`, s.alice, { folderId: s.control.id });
    expect(await openDoc(h, token, s.top.id)).toMatchObject({ name: "top.md" });
    await h.ok("PATCH", `/api/docs/${s.runtime.id}`, s.alice, { folderId: s.priv.id });
    expect(await openDoc(h, token, s.runtime.id)).toBe(404);
    expect(((await tree(h, token)) as SharedFolder).docs.map((d) => d.name)).not.toContain("runtime.md");
  });

  test("a subfolder or image moved out leaves the link; the shared folder itself moved or renamed keeps it", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.platform.id, s.alice))!;
    await h.ok("PATCH", `/api/docs/folders/${s.control.id}`, s.alice, { parentId: s.priv.id });
    expect(await openDoc(h, token, s.api.id)).toBe(404);
    expect(((await tree(h, token)) as SharedFolder).folders.map((f) => f.name)).not.toContain("control-plane");
    // Moved back in, it is reachable again.
    await h.ok("PATCH", `/api/docs/folders/${s.control.id}`, s.alice, { parentId: s.platform.id });
    expect(await openDoc(h, token, s.api.id)).toMatchObject({ name: "api.md" });

    expect((await h.app.request(`/api/share/folders/${token}/media/${s.diagram.id}`)).status).toBe(200);
    await h.ok("PATCH", `/api/docs/assets/${s.diagram.id}`, s.alice, { folderId: s.priv.id });
    expect((await h.app.request(`/api/share/folders/${token}/media/${s.diagram.id}`)).status).toBe(404);

    await h.ok("PATCH", `/api/docs/folders/${s.platform.id}`, s.alice, { parentId: s.priv.id, name: "renamed" });
    const folder = (await tree(h, token)) as SharedFolder;
    expect(folder.name).toBe("renamed");
    // Still only the shared folder's subtree: the new parent stays out of it.
    expect(folder.folders.find((f) => f.id === s.platform.id)?.parentId).toBeNull();
    expect(JSON.stringify(folder)).not.toContain(s.priv.id);
    expect(await openDoc(h, token, s.runtime.id)).toMatchObject({ name: "runtime.md" });
  });

  test("a doc or subfolder in a shared folder says so in its share state; the owner can list shared folders", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const state = async (type: string, id: string) => (await h.ok<{ share: ShareState }>("GET", `/api/shares/${type}/${id}`, s.alice)).share;
    expect(await state("doc", s.api.id)).toEqual({ enabled: false, path: null });
    await shareFolder(h, s.platform.id, s.alice);
    expect(await state("doc", s.api.id)).toEqual({ enabled: false, path: null, viaFolder: "acme-platform" });
    expect(await state("folder", s.control.id)).toEqual({ enabled: false, path: null, viaFolder: "acme-platform" });
    // The nearest shared folder is named; the shared folder itself has none above it.
    await shareFolder(h, s.control.id, s.alice);
    expect((await state("doc", s.api.id)).viaFolder).toBe("acme-platform/control-plane");
    expect((await state("folder", s.platform.id)).viaFolder).toBeUndefined();
    expect((await state("doc", s.secret.id)).viaFolder).toBeUndefined();
    // The owner's doc read carries it too.
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${s.overview.id}`, s.alice)).doc.share?.viaFolder).toBe("acme-platform");

    expect((await h.ok<{ ids: string[] }>("GET", "/api/shares/folder", s.alice)).ids.sort()).toEqual([s.control.id, s.platform.id].sort());
    expect((await h.ok<{ ids: string[] }>("GET", "/api/shares/folder", h.as("bob"))).ids).toEqual([]);
    for (const headers of [{}, h.persona(), h.worker("alice")]) expect((await h.call("GET", "/api/shares/folder", headers)).status).toBe(403);
    expect((await h.call("GET", "/api/shares/bogus", s.alice)).status).toBe(404);
  });

  test("a doc outside the folder is the same bare 404 through the folder link", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.control.id, s.alice))!;
    const bobs = (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", h.as("bob"), { folderId: null, name: "b.md", body: "bob" })).doc;
    // A sibling folder's doc, the parent folder's doc, a top-level doc, another folder's, another user's, and junk ids.
    for (const id of [s.runtime.id, s.overview.id, s.top.id, s.secret.id, bobs.id, s.control.id, "00000000-0000-0000-0000-000000000000", "not-an-id"]) {
      const res = await h.app.request(`/api/share/folders/${token}/docs/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    expect(await openDoc(h, token, s.api.id)).toMatchObject({ name: "api.md" });
    // The folder link's tree is only the shared folder's.
    const folder = (await tree(h, token)) as SharedFolder;
    expect(folder.folders).toEqual([{ id: s.control.id, parentId: null, name: "control-plane" }]);
    expect(folder.docs.map((d) => d.id)).toEqual([s.api.id]);
  });

  test("images resolve only inside the shared folder; a src or media id reaching outside it is never served", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.platform.id, s.alice))!;
    const api = (await openDoc(h, token, s.api.id)) as SharedDoc;
    // `../diagram.png` climbs out of control-plane but stays inside the shared folder; `../../private/…` leaves it.
    expect(Object.keys(api.images)).toEqual(["../diagram.png"]);
    expect(api.images["../diagram.png"]!.url).toBe(`/api/share/folders/${token}/media/${s.diagram.id}`);
    const media = await h.app.request(api.images["../diagram.png"]!.url);
    expect(media.status).toBe(200);
    expect(media.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await media.arrayBuffer())]).toEqual([...png(60, 1)]);
    expect((await h.app.request(`/api/share/folders/${token}/media/${s.secretPng.id}`)).status).toBe(404);

    // Sharing control-plane alone puts diagram.png (one level up) out of reach too.
    const narrow = (await shareFolder(h, s.control.id, s.alice))!;
    expect(((await openDoc(h, narrow, s.api.id)) as SharedDoc).images).toEqual({});
    expect((await h.app.request(`/api/share/folders/${narrow}/media/${s.diagram.id}`)).status).toBe(404);
  });

  test("dot-segment, encoded and prefix paths under the folder link reach nothing else", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.control.id, s.alice))!;
    const attempts = [
      `/api/share/folders/${token}/docs/../../docs/${s.secret.id}`,
      `/api/share/folders/${token}/docs/..%2F..%2Fdocs%2F${s.secret.id}`,
      `/api/share/folders/${token}/docs/%2e%2e%2f${s.secret.id}`,
      `/api/share/folders/${token}/docs/${s.api.id}/../${s.secret.id}`,
      `/api/share/folders/${token}/docs/${s.api.id}%2F..%2F${s.secret.id}`,
      `/api/share/folders/${token}/../../docs/tree`,
      `/api/share/folders/${token}/..%2F..%2Fdocs%2Ftree`,
      `/api/share/folders/${token}%2F..%2F..%2Fdocs%2Ftree`,
      `/api/share/folders/${token}/%2e%2e/%2e%2e/docs/${s.secret.id}`,
      `/api/share/folders/%2e%2e/%2e%2e/docs/tree`,
      `/api/share/folders/${token}/docs/${s.secret.id}/x`,
      `/api/share/folders/${token}/docs/`,
      `/api/share/folders/${token}/docs`,
      `/api/share/folders/${token}/tree`,
      `/api/share/folders/${token}/media/x/y`,
      `/api/share/folders/${token}//..//..//docs/tree`,
      `/api/share/folders/${token}/../../../api/docs/${s.secret.id}`,
      `/api/share/docs/${token}`,
      `/api/share/reviews/${token}`,
      `/api/share/docs/${token}/docs/${s.api.id}`,
    ];
    for (const path of attempts) {
      const res = await h.app.request(path);
      const body = await res.text();
      expect(body).not.toContain("# Secret");
      expect(body).not.toContain("private");
      expect(body).not.toContain("alice");
      // A dot segment the URL parser folds back onto the folder's own tree or doc route may answer with that; nothing else does.
      if (res.status === 200) expect(Object.keys(JSON.parse(body))).toEqual(["folder"]);
      else expect([401, 403, 404]).toContain(res.status);
    }
    for (const path of [`/api/share/folders/${token}`, `/api/share/folders/${token}/docs/${s.api.id}`]) {
      const res = await h.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(404);
    }
  });

  test("turning it off revokes the tree, docs and images at once; a doc's own link keeps working", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.platform.id, s.alice))!;
    const { share } = await h.ok<{ share: ShareState }>("PUT", `/api/shares/doc/${s.overview.id}`, s.alice, { enabled: true });
    const docToken = share.path!.replace("/share/doc/", "");
    const urls = [`/api/share/folders/${token}`, `/api/share/folders/${token}/docs/${s.overview.id}`, `/api/share/folders/${token}/media/${s.diagram.id}`];
    for (const url of urls) expect((await h.app.request(url)).status).toBe(200);

    expect(await shareFolder(h, s.platform.id, s.alice, false)).toBeNull();
    for (const url of urls) {
      for (const method of ["GET", "HEAD"]) expect((await h.app.request(url, { method })).status).toBe(404);
      expect(await (await h.app.request(url)).json()).toEqual(NOT_FOUND);
    }
    expect((await h.app.request(`/api/share/docs/${docToken}`)).status).toBe(200);
    expect((await h.ok<{ share: ShareState }>("GET", `/api/shares/folder/${s.platform.id}`, s.alice)).share).toEqual({ enabled: false, path: null });

    // On again is a new link; the old one stays dead.
    const again = (await shareFolder(h, s.platform.id, s.alice))!;
    expect(again).not.toBe(token);
    expect((await h.app.request(`/api/share/folders/${again}`)).status).toBe(200);
    expect((await h.app.request(`/api/share/folders/${token}`)).status).toBe(404);
  });

  test("deleting the folder, or a folder holding it, revokes its link", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const outer = (await shareFolder(h, s.platform.id, s.alice))!;
    const inner = (await shareFolder(h, s.control.id, s.alice))!;
    await h.ok("DELETE", `/api/docs/folders/${s.platform.id}`, s.alice);
    for (const token of [outer, inner]) expect((await h.app.request(`/api/share/folders/${token}`)).status).toBe(404);
    const live = h.store.db.query("SELECT COUNT(*) AS n FROM share_grants WHERE resource_type = 'folder' AND revoked_at IS NULL").get();
    expect(live).toEqual({ n: 0 });
  });

  test("only the owner, as a person, can toggle; another user's folder reads as unknown", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const put = (headers: Record<string, string>) => h.call("PUT", `/api/shares/folder/${s.platform.id}`, headers, { enabled: true });
    expect((await put(h.as("bob"))).status).toBe(404);
    expect((await put(h.persona())).status).toBe(403);
    expect((await put({ ...s.alice, ...h.persona() })).status).toBe(403);
    expect((await put(h.worker("alice"))).status).toBe(403);
    expect((await put({})).status).toBe(403);
    const form = await h.app.request(`/api/shares/folder/${s.platform.id}`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...s.alice },
      body: JSON.stringify({ enabled: true }),
    });
    expect(form.status).toBe(403);
    expect((await h.call("GET", `/api/shares/folder/${s.platform.id}`, {})).status).toBe(403);
    expect((await h.call("GET", `/api/shares/folder/${s.platform.id}`, h.as("bob"))).status).toBe(404);
    expect((await h.ok<{ share: ShareState }>("GET", `/api/shares/folder/${s.platform.id}`, s.alice)).share).toEqual({ enabled: false, path: null });
  });

  test("a live folder link opens no other route to an unauthenticated request", async () => {
    const h = docsHarness();
    const s = await setUp(h);
    const token = (await shareFolder(h, s.platform.id, s.alice))!;
    const withToken = { authorization: `Bearer ${token}`, "x-standup-share-token": token, cookie: `share=${token}` };
    const reads = [
      "/api/docs/tree",
      `/api/docs/tree?share=${token}`,
      `/api/docs/${s.overview.id}`,
      `/api/docs/${s.overview.id}?share=${token}`,
      `/api/docs/${s.secret.id}`,
      `/api/docs/assets/${s.diagram.id}`,
      "/api/docs/list",
      "/api/docs/read?path=acme-platform/overview.md",
      `/api/shares/folder/${s.platform.id}`,
      `/api/shares/doc/${s.overview.id}`,
      "/api/reviews",
    ];
    for (const path of reads) {
      for (const headers of [{}, withToken]) {
        const res = await h.app.request(path, { headers });
        expect([401, 403, 404]).toContain(res.status);
        expect(await res.text()).not.toContain("# Overview");
      }
    }
    const writes: Array<[string, string, unknown]> = [
      ["PUT", `/api/shares/folder/${s.platform.id}`, { enabled: false }],
      ["PATCH", `/api/docs/${s.overview.id}`, { body: "defaced" }],
      ["POST", "/api/docs", { folderId: s.platform.id, name: "x.md", body: "x" }],
      ["POST", "/api/docs/folders", { parentId: s.platform.id, name: "x" }],
      ["DELETE", `/api/docs/folders/${s.platform.id}`, undefined],
      ["POST", "/api/docs/write", { path: "acme-platform/x.md", content: "x" }],
    ];
    for (const [method, path, body] of writes) {
      const res = await h.call(method, path, withToken, body);
      expect([401, 403, 404]).toContain(res.status);
    }
    // The link still works, and nothing was changed through it.
    expect((await tree(h, token)) as SharedFolder).toMatchObject({ name: "acme-platform" });
    expect(await openDoc(h, token, s.overview.id)).toMatchObject({ body: "# Overview\n\n![d](diagram.png)" });
  });
});
