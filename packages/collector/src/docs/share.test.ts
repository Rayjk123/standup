import { describe, expect, test } from "bun:test";
import type { DocAsset, DocDetail, DocFolder, ShareState, SharedDoc } from "@standup/shared";
import { docsHarness, png } from "./test-harness.js";

/*
 * A doc shared by link: only its owner turns sharing on or off, the link
 * shows the doc's name and body and only the images the body references,
 * and a bad, revoked or deleted doc's token is the same bare 404.
 */

type H = ReturnType<typeof docsHarness>;
const NOT_FOUND = { error: "Not found" };

async function setUpDoc(h: H, body: string) {
  const alice = h.as("alice");
  const folder = (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId: null, name: "design" })).folder;
  const img = (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId: folder.id, name: "img" })).folder;
  const upload = async (name: string, fill: number, folderId: string) => {
    const res = await h.app.request(`/api/docs/assets?folderId=${folderId}&name=${name}`, {
      method: "POST",
      headers: { "content-type": "image/png", ...alice },
      body: png(60, fill),
    });
    return ((await res.json()) as { asset: DocAsset }).asset;
  };
  const shown = await upload("shown.png", 1, img.id);
  const hidden = await upload("hidden.png", 2, img.id);
  const doc = (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", alice, { folderId: folder.id, name: "plan.md", body })).doc;
  return { alice, folder, doc, shown, hidden };
}

const shareOn = async (h: H, id: string, headers: Record<string, string>) => {
  const { share } = await h.ok<{ share: ShareState }>("PUT", `/api/shares/doc/${id}`, headers, { enabled: true });
  return share.path!.replace("/share/doc/", "");
};

describe("a shared doc", () => {
  test("on shares the doc without auth (GET and HEAD); off revokes the link at once", async () => {
    const h = docsHarness();
    const { alice, doc } = await setUpDoc(h, "# Plan");
    const token = await shareOn(h, doc.id, alice);
    const res = await h.app.request(`/api/share/docs/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.json()).toEqual({ doc: { name: "plan.md", body: "# Plan", images: {} } });
    expect((await h.app.request(`/api/share/docs/${token}`, { method: "HEAD" })).status).toBe(200);

    await h.ok("PUT", `/api/shares/doc/${doc.id}`, alice, { enabled: false });
    for (const method of ["GET", "HEAD"]) expect((await h.app.request(`/api/share/docs/${token}`, { method })).status).toBe(404);
    expect(await (await h.app.request(`/api/share/docs/${token}`)).json()).toEqual(NOT_FOUND);
    expect(await (await h.app.request(`/api/share/docs/${"A".repeat(43)}`)).json()).toEqual(NOT_FOUND);
  });

  test("shows only the doc's name, body and the images its body references", async () => {
    const h = docsHarness();
    const body = "See ![a](img/shown.png) and ![b](img/missing.png) and ![c](https://example.com/x.png)\n\n```\n![code](img/hidden.png)\n```\n";
    const { alice, doc, shown, hidden } = await setUpDoc(h, body);
    const token = await shareOn(h, doc.id, alice);
    const raw = await (await h.app.request(`/api/share/docs/${token}`)).text();
    const shared = (JSON.parse(raw) as { doc: SharedDoc }).doc;
    expect(Object.keys(shared).sort()).toEqual(["body", "images", "name"]);
    expect(shared.images).toEqual({ "img/shown.png": { url: `/api/share/docs/${token}/media/${shown.id}`, mime: "image/png" } });
    for (const leak of [doc.id, "alice", "design", hidden.id, "revision"]) expect(raw.replaceAll(token, "<t>")).not.toContain(leak);

    const media = await h.app.request(shared.images["img/shown.png"]!.url);
    expect(media.status).toBe(200);
    expect(media.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await media.arrayBuffer())]).toEqual([...png(60, 1)]);
    // An asset of the owner's the body doesn't show is out of reach.
    const unshown = await h.app.request(`/api/share/docs/${token}/media/${hidden.id}`);
    expect(unshown.status).toBe(404);
    expect(await unshown.json()).toEqual(NOT_FOUND);
  });

  test("only images in the doc's folder or below are shown: a src climbing out of it is never exposed", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const mk = async (name: string, parentId: string | null) =>
      (await h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", alice, { parentId, name })).folder;
    const upload = async (name: string, fill: number, folderId: string) => {
      const res = await h.app.request(`/api/docs/assets?folderId=${folderId}&name=${name}`, {
        method: "POST",
        headers: { "content-type": "image/png", ...alice },
        body: png(60, fill),
      });
      return ((await res.json()) as { asset: DocAsset }).asset;
    };
    const design = await mk("design", null);
    const screens = await mk("screens", design.id);
    const priv = await mk("private", null);
    const inside = await upload("x.png", 1, screens.id);
    const outside = await upload("x.png", 2, priv.id);
    const body = "![in](screens/x.png) ![out](../private/x.png) ![round](../design/screens/x.png) ![enc](..%2Fprivate%2Fx.png)";
    const d = (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", alice, { folderId: design.id, name: "plan.md", body })).doc;
    const token = await shareOn(h, d.id, alice);
    const shared = ((await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: SharedDoc }).doc;
    expect(Object.keys(shared.images).sort()).toEqual(["../design/screens/x.png", "screens/x.png"]);
    expect(shared.images["screens/x.png"]!.url).toBe(`/api/share/docs/${token}/media/${inside.id}`);
    expect((await h.app.request(`/api/share/docs/${token}/media/${inside.id}`)).status).toBe(200);
    expect((await h.app.request(`/api/share/docs/${token}/media/${outside.id}`)).status).toBe(404);
  });

  test("another user's asset at the same path never resolves", async () => {
    const h = docsHarness();
    const bob = h.as("bob");
    const bobs = (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", bob, { folderId: null, name: "x.md", body: "![x](a.png)" })).doc;
    await h.app.request("/api/docs/assets?folderId=&name=a.png", { method: "POST", headers: { "content-type": "image/png", ...h.as("alice") }, body: png() });
    const token = await shareOn(h, bobs.id, bob);
    expect(((await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: SharedDoc }).doc.images).toEqual({});
  });

  test("only the owner, as a person, can toggle; a doc of anyone else's reads as unknown", async () => {
    const h = docsHarness();
    const { alice, doc } = await setUpDoc(h, "x");
    const put = (headers: Record<string, string>) => h.call("PUT", `/api/shares/doc/${doc.id}`, headers, { enabled: true });
    expect((await put(h.as("bob"))).status).toBe(404);
    expect((await put(h.persona())).status).toBe(403);
    expect((await put({ ...alice, ...h.persona() })).status).toBe(403);
    expect((await put(h.worker("alice"))).status).toBe(403);
    expect((await put({})).status).toBe(403);
    const form = await h.app.request(`/api/shares/doc/${doc.id}`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...alice },
      body: JSON.stringify({ enabled: true }),
    });
    expect(form.status).toBe(403);
    expect((await h.ok<{ share: ShareState }>("GET", `/api/shares/doc/${doc.id}`, alice)).share).toEqual({ enabled: false, path: null });
  });

  test("deleting the doc, or a folder holding it, revokes its link", async () => {
    const h = docsHarness();
    const { alice, folder, doc } = await setUpDoc(h, "x");
    const token = await shareOn(h, doc.id, alice);
    const other = (await h.ok<{ doc: DocDetail }>("POST", "/api/docs", alice, { folderId: null, name: "top.md", body: "y" })).doc;
    const otherToken = await shareOn(h, other.id, alice);
    await h.ok("DELETE", `/api/docs/folders/${folder.id}`, alice);
    expect((await h.app.request(`/api/share/docs/${token}`)).status).toBe(404);
    expect((await h.app.request(`/api/share/docs/${otherToken}`)).status).toBe(200);
    const live = h.store.db.query("SELECT COUNT(*) AS n FROM share_grants WHERE resource_id = ? AND revoked_at IS NULL").get(doc.id);
    expect(live).toEqual({ n: 0 });
    await h.ok("DELETE", `/api/docs/${other.id}`, alice);
    expect((await h.app.request(`/api/share/docs/${otherToken}`)).status).toBe(404);
  });

  test("a doc token doesn't open a review, and the media of a revoked token is the same 404", async () => {
    const h = docsHarness();
    const { alice, doc, shown } = await setUpDoc(h, "![a](img/shown.png)");
    const token = await shareOn(h, doc.id, alice);
    expect((await h.app.request(`/api/share/reviews/${token}`)).status).toBe(404);
    const url = `/api/share/docs/${token}/media/${shown.id}`;
    expect((await h.app.request(url)).status).toBe(200);
    await h.ok("PUT", `/api/shares/doc/${doc.id}`, alice, { enabled: false });
    const res = await h.app.request(url);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });
});
