import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { DocAsset, DocDetail, DocFolder, DocTree, DocsChangedPayload, ShareState, SharedDoc } from "@standup/shared";
import { WORKER_TOKEN_HEADER } from "@standup/shared";
import { USER_CHANNEL_HEADER } from "@standup/shared/owner-token";
import { PERSONA_TOKEN_HEADER } from "../persona/routes.js";
import { HOST, IDENTITY, docsHarness, png } from "./test-harness.js";

/*
 * The docs routes: each caller works on its own owner's tree (a person, their
 * Persona, their worker), anyone else's rows read as unknown, saves are
 * revision-checked, and every change is a content-free frame to the owner.
 */

type H = ReturnType<typeof docsHarness>;

const folder = (h: H, headers: Record<string, string>, name: string, parentId: string | null = null) =>
  h.ok<{ folder: DocFolder }>("POST", "/api/docs/folders", headers, { parentId, name }).then((r) => r.folder);
const doc = (h: H, headers: Record<string, string>, name: string, folderId: string | null = null, body = "") =>
  h.ok<{ doc: DocDetail }>("POST", "/api/docs", headers, { folderId, name, body }).then((r) => r.doc);

describe("doc CRUD", () => {
  test("create, read, save with a base revision, rename, move, delete", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const f = await folder(h, alice, "notes");
    const d = await doc(h, alice, "a.md", f.id, "# One");
    expect(d).toMatchObject({ name: "a.md", folderId: f.id, body: "# One", revision: 1, bytes: 5, share: { enabled: false, path: null } });

    const read = await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${d.id}`, alice);
    expect(read.doc.body).toBe("# One");

    const saved = await h.ok<{ doc: DocDetail }>("PATCH", `/api/docs/${d.id}`, alice, { body: "# Two", baseRevision: 1 });
    expect(saved.doc.revision).toBe(2);

    const stale = await h.call("PATCH", `/api/docs/${d.id}`, alice, { body: "# Three", baseRevision: 1 });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { error: string; doc: DocDetail };
    expect(conflict.doc.body).toBe("# Two");
    expect(conflict.doc.revision).toBe(2);

    const renamed = await h.ok<{ doc: DocDetail }>("PATCH", `/api/docs/${d.id}`, alice, { name: "b.md", folderId: null });
    expect(renamed.doc).toMatchObject({ name: "b.md", folderId: null, revision: 3 });

    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", alice);
    expect(tree.folders.map((x) => x.name)).toEqual(["notes"]);
    expect(tree.docs.map((x) => x.name)).toEqual(["b.md"]);
    expect(Object.keys(tree.docs[0]!)).not.toContain("body");

    expect((await h.call("DELETE", `/api/docs/${d.id}`, alice)).status).toBe(200);
    expect((await h.call("GET", `/api/docs/${d.id}`, alice)).status).toBe(404);
  });

  test("a name taken in the folder is a 409; bad names and ids are refused", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const f = await folder(h, alice, "notes");
    await doc(h, alice, "a.md", f.id);
    expect((await h.call("POST", "/api/docs", alice, { folderId: f.id, name: "a.md" })).status).toBe(409);
    expect((await h.call("POST", "/api/docs/folders", alice, { parentId: f.id, name: "a.md" })).status).toBe(409);
    const other = await doc(h, alice, "b.md", f.id);
    expect((await h.call("PATCH", `/api/docs/${other.id}`, alice, { name: "a.md" })).status).toBe(409);
    for (const name of ["", " a", "a/b", "..", "x\u0000"]) {
      expect((await h.call("POST", "/api/docs", alice, { folderId: null, name })).status).toBe(400);
    }
    expect((await h.call("POST", "/api/docs", alice, { folderId: "nope", name: "c.md" })).status).toBe(400);
    expect((await h.call("POST", "/api/docs", alice, { folderId: "00000000-0000-4000-8000-000000000000", name: "c.md" })).status).toBe(404);
    expect((await h.call("GET", "/api/docs/not-an-id", alice)).status).toBe(404);
  });

  test("a folder can't move into its own subfolder", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const a = await folder(h, alice, "a");
    const b = await folder(h, alice, "b", a.id);
    expect((await h.call("PATCH", `/api/docs/folders/${a.id}`, alice, { parentId: b.id })).status).toBe(400);
    expect((await h.call("PATCH", `/api/docs/folders/${a.id}`, alice, { parentId: a.id })).status).toBe(400);
    const moved = await h.ok<{ folder: DocFolder }>("PATCH", `/api/docs/folders/${b.id}`, alice, { parentId: null, name: "b2" });
    expect(moved.folder).toMatchObject({ parentId: null, name: "b2" });
  });
});

describe("who may read and write", () => {
  test("no identity, a bare identity header or a forged channel token is refused", async () => {
    const h = docsHarness();
    expect([401, 403]).toContain((await h.call("GET", "/api/docs/tree", {})).status);
    expect((await h.call("GET", "/api/docs/tree", { [IDENTITY]: "alice" })).status).toBe(403);
    expect((await h.call("GET", "/api/docs/tree", { [IDENTITY]: "alice", [USER_CHANNEL_HEADER]: "forged" })).status).toBe(403);
    expect((await h.call("POST", "/api/docs", { [IDENTITY]: "alice" }, { folderId: null, name: "a.md" })).status).toBe(403);
  });

  test("another user's doc, folder and asset read as unknown", async () => {
    const h = docsHarness();
    const d = await doc(h, h.as("alice"), "a.md");
    const f = await folder(h, h.as("alice"), "f");
    const bob = h.as("bob");
    expect((await h.call("GET", `/api/docs/${d.id}`, bob)).status).toBe(404);
    expect((await h.call("PATCH", `/api/docs/${d.id}`, bob, { body: "x" })).status).toBe(404);
    expect((await h.call("DELETE", `/api/docs/${d.id}`, bob)).status).toBe(404);
    expect((await h.call("DELETE", `/api/docs/folders/${f.id}`, bob)).status).toBe(404);
    expect((await h.call("POST", "/api/docs", bob, { folderId: f.id, name: "x.md" })).status).toBe(404);
    expect((await h.ok<DocTree>("GET", "/api/docs/tree", bob)).docs).toEqual([]);
  });

  test("a write must be JSON", async () => {
    const h = docsHarness();
    const res = await h.app.request("/api/docs", {
      method: "POST",
      headers: { "content-type": "text/plain", ...h.as("alice") },
      body: JSON.stringify({ folderId: null, name: "a.md" }),
    });
    expect(res.status).toBe(403);
  });

  test("Persona works on its owner's docs through the doc tools' routes", async () => {
    const h = docsHarness();
    await doc(h, h.owner(), "mine.md", null, "owner's");
    const read = await h.ok<{ doc: { body: string } }>("GET", "/api/docs/read?path=mine.md", h.persona());
    expect(read.doc.body).toBe("owner's");
    await doc(h, h.as("alice"), "a.md");
    expect((await h.call("GET", "/api/docs/read?path=a.md", h.persona())).status).toBe(404);
    expect((await h.call("GET", "/api/docs/read?path=mine.md", { [PERSONA_TOKEN_HEADER]: "wrong" })).status).toBe(401);
  });

  test("a worker works on its launch owner's docs; an unknown worker token is refused", async () => {
    const h = docsHarness();
    const w = h.worker("alice");
    const written = await h.ok<{ doc: { id: string; path: string; revision: number } }>("POST", "/api/docs/write", w, {
      path: "research/x.md",
      content: "found",
    });
    expect(written.doc.path).toBe("research/x.md");
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${written.doc.id}`, h.as("alice"))).doc.body).toBe("found");
    expect((await h.call("GET", "/api/docs/read?path=research/x.md", { [WORKER_TOKEN_HEADER]: "bogus" })).status).toBe(403);
    expect((await h.call("GET", "/api/docs/read?path=research/x.md", h.worker("bob"))).status).toBe(404);
  });

  test("Persona and workers reach only the doc tools' routes; every other docs route is a person's", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const f = await folder(h, alice, "f");
    const d = await doc(h, alice, "a.md", f.id, "body");
    const up = await h.app.request("/api/docs/assets?folderId=&name=a.png", {
      method: "POST",
      headers: { "content-type": "image/png", ...alice },
      body: png(),
    });
    const { asset } = (await up.json()) as { asset: DocAsset };
    const agents: Array<[string, Record<string, string>]> = [
      ["a worker", h.worker("alice")],
      ["Persona", h.persona()],
    ];
    for (const [who, headers] of agents) {
      const consoleRoutes: Array<[string, string, unknown?]> = [
        ["GET", "/api/docs/tree"],
        ["GET", "/api/docs/search?q=body"],
        ["POST", "/api/docs/folders", { parentId: null, name: "g" }],
        ["PATCH", `/api/docs/folders/${f.id}`, { name: "f2" }],
        ["DELETE", `/api/docs/folders/${f.id}`],
        ["POST", "/api/docs", { folderId: null, name: "b.md" }],
        ["GET", `/api/docs/${d.id}`],
        ["PATCH", `/api/docs/${d.id}`, { body: "changed" }],
        ["DELETE", `/api/docs/${d.id}`],
        ["GET", asset.url],
        ["PATCH", asset.url, { name: "b.png" }],
        ["DELETE", asset.url],
        ["POST", "/api/docs/import", { path: h.root, folderId: null }],
      ];
      for (const [method, path, body] of consoleRoutes) {
        const res = await h.call(method, path, headers, body);
        expect({ who, method, path, status: res.status }).toEqual({ who, method, path, status: 403 });
      }
      const upload = await h.app.request("/api/docs/assets?folderId=&name=b.png", {
        method: "POST",
        headers: { "content-type": "image/png", ...headers },
        body: png(),
      });
      expect({ who, status: upload.status }).toEqual({ who, status: 403 });
      const refusal = (await (await h.call("GET", "/api/docs/tree", headers)).json()) as { error: string };
      expect(refusal.error).toContain("doc tools");
    }
    // Nothing an agent tried changed alice's tree.
    const tree = await h.ok<DocTree>("GET", "/api/docs/tree", alice);
    expect(tree.folders.map((x) => x.name)).toEqual(["f"]);
    expect(tree.docs.map((x) => x.name)).toEqual(["a.md"]);
    expect(tree.assets.map((x) => x.name)).toEqual(["a.png"]);
    // The doc tools' routes still work for both.
    for (const headers of [h.worker("alice"), h.persona()]) {
      expect((await h.call("GET", "/api/docs/list", headers)).status).toBe(200);
    }
    expect((await h.call("GET", "/api/docs/read?path=f/a.md", h.worker("alice"))).status).toBe(200);
    expect((await h.call("POST", "/api/docs/write", h.worker("alice"), { path: "f/c.md", content: "c" })).status).toBe(200);
  });
});

describe("search", () => {
  test("name and path matches come before body matches, each body match with its line; only the caller's own docs", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const authz = await folder(h, alice, "authz");
    await doc(h, alice, "limits.md", authz.id, "# Limits\n\nRate limits for the gateway.");
    await doc(h, alice, "notes.md", null, "# Notes\n\nSee the authz design.\nOther line.");
    await doc(h, alice, "zzz.md", null, "nothing here");
    await doc(h, h.as("bob"), "authz-bob.md", null, "authz");
    const { hits } = await h.ok<{ hits: Array<{ path: string; match: string; snippet?: string }> }>("GET", "/api/docs/search?q=AUTHZ", alice);
    expect(hits).toEqual([
      { id: expect.any(String), path: "authz/limits.md", match: "path" },
      { id: expect.any(String), path: "notes.md", match: "body", snippet: "See the authz design." },
    ] as never);
    expect((await h.ok<{ hits: unknown[] }>("GET", "/api/docs/search?q=%20%20", alice)).hits).toEqual([]);
    expect((await h.ok<{ hits: unknown[] }>("GET", "/api/docs/search?q=100%25", alice)).hits).toEqual([]);
    expect((await h.call("GET", `/api/docs/search?q=${"x".repeat(201)}`, alice)).status).toBe(400);
  });
});

describe("a doc shared by link", () => {
  const shareOn = async (h: ReturnType<typeof docsHarness>, type: "doc" | "folder", id: string) => {
    const { share } = await h.ok<{ share: ShareState }>("PUT", `/api/shares/${type}/${id}`, h.owner(), { enabled: true });
    return share.path!.replace(`/share/${type}/`, "");
  };

  test("the owner's Persona and workers write it like any other doc, and the link shows the newest revision", async () => {
    const h = docsHarness();
    const owner = h.owner();
    const d = await doc(h, owner, "plan.md", await folder(h, owner, "notes").then((f) => f.id), "v1");
    const token = await shareOn(h, "doc", d.id);
    const linked = async () => ((await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: { body: string } }).doc.body;
    expect(await linked()).toBe("v1");
    for (const [i, headers] of [h.persona(), h.worker(HOST)].entries()) {
      const written = await h.ok<{ doc: { id: string; revision: number } }>("POST", "/api/docs/write", headers, {
        path: "notes/plan.md",
        content: `agent ${i}`,
        ifRevision: i + 1,
      });
      expect(written.doc).toMatchObject({ id: d.id, revision: i + 2 });
      expect(await linked()).toBe(`agent ${i}`);
    }
    // The revision check still holds on a shared doc.
    const stale = await h.call("POST", "/api/docs/write", h.persona(), { path: "notes/plan.md", content: "stale", ifRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await linked()).toBe("agent 1");
    // The link stays on: writing never turns sharing off.
    expect((await h.ok<{ share: ShareState }>("GET", `/api/shares/doc/${d.id}`, owner)).share.enabled).toBe(true);
  });

  test("a doc inside a folder shared by link takes the agents' writes, and the folder link opens the newest revision", async () => {
    const h = docsHarness();
    const owner = h.owner();
    const pub = await folder(h, owner, "pub");
    const d = await doc(h, owner, "spec.md", pub.id, "v1");
    const token = await shareOn(h, "folder", pub.id);
    const linked = async () =>
      ((await (await h.app.request(`/api/share/folders/${token}/docs/${d.id}`)).json()) as { doc: { body: string } }).doc.body;
    for (const [i, headers] of [h.persona(), h.worker(HOST)].entries()) {
      await h.ok("POST", "/api/docs/write", headers, { path: "pub/spec.md", content: `agent ${i}` });
      expect(await linked()).toBe(`agent ${i}`);
    }
  });

  test("nobody else writes it: another user's write lands in their own tree, and the share link takes no write", async () => {
    const h = docsHarness();
    const owner = h.owner();
    const d = await doc(h, owner, "plan.md", null, "v1");
    const token = await shareOn(h, "doc", d.id);
    const bobs = [];
    for (const headers of [h.as("bob"), h.worker("bob")]) {
      bobs.push((await h.ok<{ doc: { id: string; revision: number } }>("POST", "/api/docs/write", headers, { path: "plan.md", content: "bob" })).doc);
    }
    expect(bobs[0]!.id).not.toBe(d.id);
    expect(bobs[1]).toEqual({ id: bobs[0]!.id, path: "plan.md", revision: 1 } as never);
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${bobs[0]!.id}`, h.as("bob"))).doc.body).toBe("bob");
    // The link's routes are GETs only: no method writes through it.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await h.app.request(`/api/share/docs/${token}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "via link", content: "via link" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    // The share token is no credential: the doc tools refuse a write that carries only it.
    const tokenOnly = await h.app.request("/api/docs/write", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: "plan.md", content: "via link" }),
    });
    expect(tokenOnly.status).toBe(403);
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${d.id}`, owner)).doc.body).toBe("v1");
    expect(((await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: { body: string } }).doc.body).toBe("v1");
  });

  test("a worker's body may not add an image reference to the doc; the references it already has, URLs, and Persona's may", async () => {
    const h = docsHarness();
    const owner = h.owner();
    const upload = async (folderId: string, name: string, fill: number) => {
      const res = await h.app.request(`/api/docs/assets?folderId=${folderId}&name=${name}`, {
        method: "POST",
        headers: { "content-type": "image/png", ...owner },
        body: png(60, fill),
      });
      return ((await res.json()) as { asset: DocAsset }).asset;
    };
    const shots = await folder(h, owner, "shots");
    const shown = await upload(shots.id, "shown.png", 1);
    const secret = await upload((await folder(h, owner, "private")).id, "secret.png", 2);
    // A doc at the top: its link reaches an image anywhere in the tree its body references.
    const d = await doc(h, owner, "top.md", null, "![](shots/shown.png)");
    const token = await shareOn(h, "doc", d.id);
    const linked = async () => ((await (await h.app.request(`/api/share/docs/${token}`)).json()) as { doc: SharedDoc }).doc;

    const refused = await h.call("POST", "/api/docs/write", h.worker(HOST), { path: "top.md", content: "![](shots/shown.png) ![](private/secret.png)" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "top.md is shared by link, and the new body has image references it didn't have (private/secret.png); only the owner or their Persona can add an image to a shared doc, so leave the images out"
    );
    expect(await linked()).toMatchObject({ body: "![](shots/shown.png)" });
    expect((await h.app.request(`/api/share/docs/${token}/media/${secret.id}`)).status).toBe(404);
    const refusal = async (content: string) => {
      const res = await h.call("POST", "/api/docs/write", h.worker(HOST), { path: "top.md", content });
      expect(res.status).toBe(409);
      return ((await res.json()) as { error: string }).error;
    };
    // A reference to an image not stored yet is refused too: the link would show one stored there later.
    // Each new reference is named once, however it is spelled.
    expect(await refusal("![](shots/later.png) ![](./shots/later.png) ![](../up.png)")).toContain("(shots/later.png, ../up.png)");
    // So is one hidden past the references docImageSources reads.
    expect(await refusal(`${"![]".repeat(1000)} ![](private/secret.png)`)).toContain("1000 or more image references");
    expect(await linked()).toMatchObject({ body: "![](shots/shown.png)" });

    // Text, the same image by another spelling, and a URL all go through.
    await h.ok("POST", "/api/docs/write", h.worker(HOST), {
      path: "top.md",
      content: "# New\n\n![again](./shots/shown.png) ![](https://example.com/x.png) ![](/abs.png)",
    });
    expect(Object.keys((await linked()).images).sort()).toEqual(["./shots/shown.png"]);
    expect((await linked()).images["./shots/shown.png"]!.url).toContain(shown.id);

    await h.ok("POST", "/api/docs/write", h.persona(), { path: "top.md", content: "![](private/secret.png)" });
    expect((await h.app.request(`/api/share/docs/${token}/media/${secret.id}`)).status).toBe(200);
  });

  test("in a subfolder, a worker's references are compared by where they resolve; with sharing off, a worker may add one", async () => {
    const h = docsHarness();
    const owner = h.owner();
    const sub = await folder(h, owner, "notes");
    const d = await doc(h, owner, "plan.md", sub.id, "![a](img/a.png)");
    await shareOn(h, "doc", d.id);
    const write = (content: string) => h.call("POST", "/api/docs/write", h.worker(HOST), { path: "notes/plan.md", content });
    expect((await write("![a](./img/a.png) ![b](../notes/img/a.png)")).status).toBe(200);
    expect((await write("![b](img/b.png)")).status).toBe(409);
    await h.ok("PUT", `/api/shares/doc/${d.id}`, owner, { enabled: false });
    expect((await write("![b](img/b.png)")).status).toBe(200);
  });
});

describe("docs:changed frames", () => {
  test("every change is addressed to the owner with proof and carries no content", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const f = await folder(h, alice, "secret-folder-name");
    const d = await doc(h, alice, "secret-doc.md", f.id, "TOP-SECRET-BODY");
    await h.ok("PATCH", `/api/docs/${d.id}`, alice, { body: "TOP-SECRET-TWO" });
    await h.ok("PATCH", `/api/docs/${d.id}`, alice, { name: "renamed.md" });
    await h.ok("DELETE", `/api/docs/folders/${f.id}`, alice);
    const frames = h.frames.filter((m) => m.type === "docs:changed");
    expect(frames).toHaveLength(5);
    for (const m of frames) {
      expect(m.audience).toBe("alice");
      expect(m.requireProof).toBe(true);
      const raw = JSON.stringify(m.payload);
      for (const leak of ["TOP-SECRET", "secret-folder-name", "secret-doc", "renamed.md"]) expect(raw).not.toContain(leak);
    }
    const payloads = frames.map((m) => m.payload as DocsChangedPayload);
    expect(payloads[2]).toEqual({ tree: false, docId: d.id, revision: 2 });
    expect(payloads[3]).toEqual({ tree: true, docId: d.id, revision: 3 });
    expect(payloads[4]).toEqual({ tree: true, deleted: true });
  });

  test("a write that changes nothing announces nothing and keeps the revision", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const f = await folder(h, alice, "f");
    const g = await folder(h, alice, "g");
    const up = await h.app.request(`/api/docs/assets?folderId=${f.id}&name=a.png`, {
      method: "POST",
      headers: { "content-type": "image/png", ...alice },
      body: png(),
    });
    const { asset } = (await up.json()) as { asset: DocAsset };
    const w = h.worker("alice");
    const first = await h.ok<{ doc: { revision: number } }>("POST", "/api/docs/write", w, { path: "f/a.md", content: "same" });
    const count = () => h.frames.filter((m) => m.type === "docs:changed").length;
    const before = count();
    await h.ok("PATCH", `/api/docs/folders/${f.id}`, alice, {});
    await h.ok("PATCH", `/api/docs/folders/${f.id}`, alice, { name: "f", parentId: null });
    await h.ok("PATCH", `/api/docs/assets/${asset.id}`, alice, {});
    await h.ok("PATCH", `/api/docs/assets/${asset.id}`, alice, { name: "a.png", folderId: f.id });
    const again = await h.ok<{ doc: { revision: number } }>("POST", "/api/docs/write", w, { path: "f/a.md", content: "same" });
    expect(again.doc.revision).toBe(first.doc.revision);
    expect(count()).toBe(before);
    // A real change still announces.
    await h.ok("PATCH", `/api/docs/folders/${g.id}`, alice, { parentId: f.id });
    await h.ok("PATCH", `/api/docs/assets/${asset.id}`, alice, { name: "b.png" });
    await h.ok("POST", "/api/docs/write", w, { path: "f/a.md", content: "different" });
    expect(count()).toBe(before + 3);
  });

  test("turning a doc's share link on or off tells the owner's other tabs; a review's toggle doesn't", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const d = await doc(h, alice, "a.md");
    const start = h.frames.length;
    await h.ok("PUT", `/api/shares/doc/${d.id}`, alice, { enabled: true });
    await h.ok("PUT", `/api/shares/doc/${d.id}`, alice, { enabled: false });
    const frames = h.frames.slice(start).filter((m) => m.type === "docs:changed");
    expect(frames).toHaveLength(2);
    for (const m of frames) {
      expect(m.audience).toBe("alice");
      expect(m.requireProof).toBe(true);
      expect(m.payload).toEqual({ tree: false, docId: d.id, share: true });
    }
  });
});

describe("per-owner limits", () => {
  test("a write past the item cap is a 413, for every kind of item", async () => {
    const h = docsHarness({ docLimits: { items: 2 } });
    const alice = h.as("alice");
    await folder(h, alice, "f");
    await doc(h, alice, "a.md");
    expect((await h.call("POST", "/api/docs", alice, { folderId: null, name: "b.md" })).status).toBe(413);
    expect((await h.call("POST", "/api/docs/folders", alice, { parentId: null, name: "g" })).status).toBe(413);
    const write = await h.call("POST", "/api/docs/write", h.worker("alice"), { path: "new/x.md", content: "x" });
    expect(write.status).toBe(413);
    expect(((await write.json()) as { error: string }).error).toContain("at most 2");
    const up = await h.app.request("/api/docs/assets?folderId=&name=a.png", {
      method: "POST",
      headers: { "content-type": "image/png", ...alice },
      body: png(),
    });
    expect(up.status).toBe(413);
    expect(existsSync(join(h.dataDir, "doc-assets")) ? readdirSync(join(h.dataDir, "doc-assets")).length : 0).toBe(0);
    // Another owner has their own room.
    expect((await h.call("POST", "/api/docs", h.as("bob"), { folderId: null, name: "b.md" })).status).toBe(200);
  });

  test("doc text and image bytes are capped across the owner's tree", async () => {
    const h = docsHarness({ docLimits: { bodyBytes: 10, assetBytes: 150 } });
    const alice = h.as("alice");
    const d = await doc(h, alice, "a.md", null, "123456");
    expect((await h.call("POST", "/api/docs", alice, { folderId: null, name: "b.md", body: "12345" })).status).toBe(413);
    expect((await h.call("PATCH", `/api/docs/${d.id}`, alice, { body: "12345678901" })).status).toBe(413);
    expect((await h.call("POST", "/api/docs/write", h.worker("alice"), { path: "a.md", content: "12345678901" })).status).toBe(413);
    expect((await h.call("PATCH", `/api/docs/${d.id}`, alice, { body: "1234567890" })).status).toBe(200);
    const upload = (name: string) =>
      h.app.request(`/api/docs/assets?folderId=&name=${name}`, {
        method: "POST",
        headers: { "content-type": "image/png", ...alice },
        body: png(84, name.length),
      });
    expect((await upload("a.png")).status).toBe(200);
    expect((await upload("bb.png")).status).toBe(413);
  });
});

describe("assets", () => {
  const upload = (h: H, headers: Record<string, string>, name: string, bytes: Uint8Array, type = "image/png", folderId = "") =>
    h.app.request(`/api/docs/assets?folderId=${folderId}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": type, ...headers },
      body: bytes,
    });

  test("an uploaded image is stored by digest, served to its owner only, and its copy removed with its last row", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const res = await upload(h, alice, "shot.png", png(84, 7));
    expect(res.status).toBe(200);
    const { asset } = (await res.json()) as { asset: DocAsset };
    expect(asset).toMatchObject({ name: "shot.png", mime: "image/png", folderId: null, url: `/api/docs/assets/${asset.id}` });
    expect(Object.keys(asset)).not.toContain("sha256");
    const served = await h.app.request(asset.url, { headers: alice });
    expect(served.status).toBe(200);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...png(84, 7)]);
    expect((await h.app.request(asset.url, { headers: h.as("bob") })).status).toBe(404);
    const dir = join(h.dataDir, "doc-assets");
    expect(readdirSync(dir).filter((f) => f.endsWith(".png"))).toHaveLength(1);
    // A second row for the same bytes keeps the copy until both are gone.
    const twin = ((await (await upload(h, alice, "twin.png", png(84, 7))).json()) as { asset: DocAsset }).asset;
    expect((await h.call("DELETE", `/api/docs/assets/${asset.id}`, alice)).status).toBe(200);
    expect(readdirSync(dir).filter((f) => f.endsWith(".png"))).toHaveLength(1);
    expect((await h.call("DELETE", `/api/docs/assets/${twin.id}`, alice)).status).toBe(200);
    expect(readdirSync(dir).filter((f) => f.endsWith(".png"))).toHaveLength(0);
  });

  test("content must match the extension, the type must be declared, and an SVG is never an asset", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    expect((await upload(h, alice, "shot.jpg", png())).status).toBe(400);
    expect((await upload(h, alice, "shot.png", new TextEncoder().encode("<svg/>"))).status).toBe(400);
    expect((await upload(h, alice, "shot.svg", new TextEncoder().encode("<svg/>"), "image/svg+xml")).status).toBe(403);
    expect((await upload(h, alice, "shot.svg", new TextEncoder().encode("<svg/>"), "application/octet-stream")).status).toBe(400);
    expect((await upload(h, alice, "shot.png", png(), "text/plain")).status).toBe(403);
    expect((await upload(h, alice, "shot.png", png(), "multipart/form-data")).status).toBe(403);
    expect((await upload(h, alice, "a/b.png", png())).status).toBe(400);
    expect(existsSync(join(h.dataDir, "doc-assets")) ? readdirSync(join(h.dataDir, "doc-assets")).length : 0).toBe(0);
  });

  test("a rename keeps its type", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const { asset } = (await (await upload(h, alice, "a.png", png())).json()) as { asset: DocAsset };
    expect((await h.call("PATCH", `/api/docs/assets/${asset.id}`, alice, { name: "a.jpg" })).status).toBe(400);
    expect((await h.ok<{ asset: DocAsset }>("PATCH", `/api/docs/assets/${asset.id}`, alice, { name: "b.png" })).asset.name).toBe("b.png");
  });
});

describe("doc tools by path", () => {
  test("write creates folders and the doc, then updates it; if_revision guards; read and list by path", async () => {
    const h = docsHarness();
    const w = h.worker("alice");
    const first = await h.ok<{ doc: { id: string; path: string; revision: number } }>("POST", "/api/docs/write", w, { path: "a/b/c.md", content: "v1" });
    expect(first.doc.revision).toBe(1);
    const second = await h.ok<{ doc: { id: string; path: string; revision: number } }>("POST", "/api/docs/write", w, {
      path: "a/b/c.md",
      content: "v2",
      ifRevision: 1,
    });
    expect(second.doc).toEqual({ id: first.doc.id, path: "a/b/c.md", revision: 2 });
    const stale = await h.call("POST", "/api/docs/write", w, { path: "a/b/c.md", content: "v3", ifRevision: 1 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { doc: { revision: number } }).doc.revision).toBe(2);
    expect((await h.call("POST", "/api/docs/write", w, { path: "a/new.md", content: "x", ifRevision: 1 })).status).toBe(409);
    expect((await h.call("POST", "/api/docs/write", w, { path: "../x.md", content: "x" })).status).toBe(400);

    const read = await h.ok<{ doc: { body: string; revision: number } }>("GET", "/api/docs/read?path=a/b/c.md", w);
    expect(read.doc).toMatchObject({ body: "v2", revision: 2 });
    expect((await h.call("GET", "/api/docs/read?path=a/b/none.md", w)).status).toBe(404);

    await h.ok("POST", "/api/docs/write", w, { path: "top.md", content: "t" });
    const all = await h.ok<{ folders: string[]; docs: Array<{ id: string; path: string }> }>("GET", "/api/docs/list", w);
    expect(all.folders).toEqual(["a", "a/b"]);
    expect(all.docs.map((d) => d.path)).toEqual(["a/b/c.md", "top.md"]);
    expect(all.docs[0]!.id).toBe(first.doc.id);
    const under = await h.ok<{ folders: string[]; docs: Array<{ path: string }> }>("GET", "/api/docs/list?folder=a", w);
    expect(under.folders).toEqual(["a/b"]);
    expect(under.docs.map((d) => d.path)).toEqual(["a/b/c.md"]);
    expect((await h.call("GET", "/api/docs/list?folder=zzz", w)).status).toBe(404);

    const root = await h.ok<{ folder: string; folders: string[] }>("GET", "/api/docs/list?folder=/", w);
    expect(root).toMatchObject({ folder: "", folders: ["a", "a/b"] });
    const slashed = await h.ok<{ folder: string; docs: Array<{ path: string }> }>("GET", "/api/docs/list?folder=/a/b/", w);
    expect(slashed.folder).toBe("a/b");
    expect(slashed.docs.map((d) => d.path)).toEqual(["a/b/c.md"]);
  });

  test("read and write without a path are a 400 saying so", async () => {
    const h = docsHarness();
    const w = h.worker("alice");
    for (const path of ["/api/docs/read", "/api/docs/read?path=", "/api/docs/read?path=%20"]) {
      const res = await h.call("GET", path, w);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "path is required" });
    }
    expect((await h.call("GET", "/api/docs/read?path=../x.md", w)).status).toBe(400);
    for (const body of [{ content: "x" }, { path: "", content: "x" }, { path: null, content: "x" }]) {
      const res = await h.call("POST", "/api/docs/write", w, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "path is required" });
    }
  });

  test("a caller with no worker token and no proof is refused", async () => {
    const h = docsHarness();
    expect([401, 403]).toContain((await h.call("POST", "/api/docs/write", {}, { path: "x.md", content: "x" })).status);
    expect([401, 403]).toContain((await h.call("GET", "/api/docs/read?path=x.md", {})).status);
    expect([401, 403]).toContain((await h.call("GET", "/api/docs/list", {})).status);
  });
});

describe("share state on a person's read", () => {
  test("DocDetail.share follows the grant", async () => {
    const h = docsHarness();
    const alice = h.as("alice");
    const d = await doc(h, alice, "a.md");
    const put = await h.ok<{ share: ShareState }>("PUT", `/api/shares/doc/${d.id}`, alice, { enabled: true });
    expect(put.share.path).toMatch(/^\/share\/doc\/[A-Za-z0-9_-]{43}$/);
    expect((await h.ok<{ doc: DocDetail }>("GET", `/api/docs/${d.id}`, alice)).doc.share).toEqual(put.share);
  });
});
